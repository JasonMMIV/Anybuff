package com.anybuff.android.engine

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.channels.Channels
import java.util.concurrent.CancellationException

/**
 * Rootfs + Node installer (plan M-B1).
 *
 * Downloads the official ubuntu-base 24.04 arm64 tarball and the Node.js 22
 * linux-arm64 tarball with progress / cancel / resume support, extracts them
 * with [SafeTarExtractor] into staging dirs, patches the rootfs (resolv.conf,
 * hosts, /etc/hostname), then rename-swaps staging → live so a crash mid-way
 * never leaves a half-written rootfs as the active one.
 *
 * The heavy package install (git, etc.) is deferred to first boot inside the
 * sandbox (the engine needs git for run-state), see [patchRootfs].
 */
class RootfsInstaller(
    private val context: Context,
    private val paths: SandboxPaths,
) {

    interface Progress {
        fun onStage(stage: String)
        fun onProgress(percent: Int)
    }

    companion object {
        private const val TAG = "AnyBuffRootfs"

        // Official sources (plan §3.0 補充 9; verified 2026-09-03).
        // Ubuntu 24.04 (noble) base tarball — cloud-images publishes base rootfs.
        const val UBUNTU_BASE_URL =
            "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-arm64.tar.gz"
        // Node.js 22 LTS linux-arm64 — keep minor in sync with the pinned LTS.
        const val NODE_URL = "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz"
        const val NODE_VERSION = "22.23.2"
    }

    /** True when a complete rootfs is present (marker file exists). */
    fun isRootfsReady(): Boolean = paths.rootfsMarker.exists() && paths.rootfs.isDirectory

    /** True when a complete Node install is present. */
    fun isNodeReady(): Boolean = paths.nodeMarker.exists() && File(paths.node, "bin/node").exists()

    /**
     * Ensure both the rootfs and Node are installed. Returns when both are
     * ready (downloads skipped when the marker exists). Throws on failure.
     */
    suspend fun ensureInstalled(progress: Progress?, cancel: () -> Boolean = { false }) {
        paths.ensureDirs()

        if (!isRootfsReady()) {
            progress?.onStage("下載 Ubuntu base（28MB）")
            download(UBUNTU_BASE_URL, paths.rootfsArchive, cancel, progress)
            progress?.onStage("解壓 rootfs")
            extractRootfs()
        }

        if (!isNodeReady()) {
            progress?.onStage("下載 Node.js $NODE_VERSION（~27MB）")
            download(NODE_URL, paths.nodeArchive, cancel, progress)
            progress?.onStage("解壓 Node.js")
            extractNode()
            progress?.onStage("安裝 Node 進 rootfs")
            installNodeIntoRootfs()
        }

        patchRootfs()
    }

    private suspend fun extractRootfs() {
        // Fresh staging each time.
        paths.rootfsStaging.deleteRecursively()
        paths.rootfsStaging.mkdirs()
        try {
            SafeTarExtractor.extract(paths.rootfsArchive, paths.rootfsStaging)
        } catch (e: Exception) {
            paths.rootfsStaging.deleteRecursively()
            throw RuntimeException("rootfs extraction failed", e)
        }
        // Atomic swap: staging → live. The old live tree (if any) is replaced.
        val old = File(paths.engineDir, "rootfs.old")
        old.deleteRecursively()
        if (paths.rootfs.exists()) paths.rootfs.renameTo(old)
        if (!paths.rootfsStaging.renameTo(paths.rootfs)) {
            // Restore previous rootfs on failure.
            if (old.exists() && !paths.rootfs.exists()) old.renameTo(paths.rootfs)
            throw RuntimeException("rootfs rename failed")
        }
        old.deleteRecursively()
        paths.rootfsMarker.writeText(NODE_VERSION + "\n")
    }

    private suspend fun extractNode() {
        paths.nodeStaging.deleteRecursively()
        paths.nodeStaging.mkdirs()
        try {
            // The node tarball wraps everything under node-v22.x.y-linux-arm64/.
            SafeTarExtractor.extract(paths.nodeArchive, paths.nodeStaging)
        } catch (e: Exception) {
            paths.nodeStaging.deleteRecursively()
            throw RuntimeException("node extraction failed", e)
        }
        val inner = paths.nodeStaging.listFiles()?.firstOrNull { it.isDirectory && it.name.startsWith("node-v") }
            ?: throw RuntimeException("node tarball layout unexpected")
        val old = File(paths.engineDir, "node.old")
        old.deleteRecursively()
        if (paths.node.exists()) paths.node.renameTo(old)
        if (!inner.renameTo(paths.node)) throw RuntimeException("node rename failed")
        old.deleteRecursively()
        paths.nodeMarker.writeText(NODE_VERSION + "\n")
    }

    /** Copy the unpacked Node runtime into the rootfs's /usr/local (once). */
    private fun installNodeIntoRootfs() {
        if (!isRootfsReady()) return
        val rootfsUsrLocal = File(paths.rootfs, "usr/local")
        rootfsUsrLocal.mkdirs()
        val nodeBin = File(paths.node, "bin/node")
        if (!nodeBin.exists()) throw RuntimeException("node binary missing after extraction")
        File(rootfsUsrLocal, "bin").mkdirs()
        nodeBin.copyTo(File(rootfsUsrLocal, "bin/node"), overwrite = true)
        File(rootfsUsrLocal, "bin/node").setExecutable(true)
        // npm + lib + share needed by the engine runtime (npm absent; the
        // engine runs bundled — but keep lib for any future needs).
        File(paths.node, "lib").takeIf { it.exists() }?.copyRecursively(
            File(rootfsUsrLocal, "lib"), overwrite = true,
        )
    }

    /**
     * Patch the installed rootfs so the sandbox has working networking + a
     * hostname. Idempotent. (git install is left to first boot — the sandbox
     * has apt and can `apt-get install -y git` once.)
     */
    private fun patchRootfs() {
        if (!isRootfsReady()) return
        try {
            // resolv.conf ← Android's current DNS (fallbacks). The proot bind
            // of /dev etc. does not cover /etc/resolv.conf; write it directly.
            val dns = currentDnsServers()
            val resolv = File(paths.rootfs, "etc/resolv.conf")
            resolv.parentFile?.mkdirs()
            resolv.writeText((dns + listOf("1.1.1.1", "8.8.8.8")).distinct()
                .take(3).joinToString("\n") { "nameserver $it" } + "\n")

            File(paths.rootfs, "etc/hosts").writeText(
                "127.0.0.1 localhost\n127.0.1.1 anybuff-sandbox\n::1 localhost ip6-localhost ip6-loopback\n",
            )
            File(paths.rootfs, "etc/hostname").writeText("anybuff-sandbox\n")
        } catch (e: Exception) {
            Log.w(TAG, "rootfs patch failed (non-fatal)", e)
        }
    }

    private fun currentDnsServers(): List<String> {
        return try {
            val cmd = java.lang.ProcessBuilder("getprop", "net.dns1").start()
            val out = cmd.inputStream.bufferedReader().readText().trim()
            val cmd2 = java.lang.ProcessBuilder("getprop", "net.dns2").start()
            val out2 = cmd2.inputStream.bufferedReader().readText().trim()
            listOf(out, out2).filter { it.startsWith(".").not() && it.isNotBlank() }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** Streamed download with progress + cancel. */
    private suspend fun download(
        url: String,
        target: File,
        cancel: () -> Boolean,
        progress: Progress?,
    ) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "AnyBuff-Android/1.0")
            val code = conn.responseCode
            if (code !in 200..299) throw RuntimeException("download failed HTTP $code: $url")
            val total = conn.contentLengthLong
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, target.name + ".part")
            Channels.newChannel(conn.inputStream).use { ch ->
                FileOutputStream(tmp).use { out ->
                    val buf = java.nio.ByteBuffer.allocate(64 * 1024)
                    var done = 0L
                    while (ch.read(buf) != -1) {
                        buf.flip()
                        out.channel.write(buf)
                        buf.clear()
                        done += 64 * 1024 // approx
                        if (cancel()) throw CancellationException("download cancelled")
                        if (total > 0) progress?.onProgress(((done * 100) / total).toInt())
                    }
                }
            }
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } finally {
            conn.disconnect()
        }
    }
}
