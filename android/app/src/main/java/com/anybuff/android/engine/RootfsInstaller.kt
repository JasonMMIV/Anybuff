package com.anybuff.android.engine

import android.content.Context
import android.os.StatFs
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Rootfs + Node installer (plan M-B1; rewritten 2026-09-03 after the device
 * test surfaced the first-boot-download 404 — see plan §4.0).
 *
 * Both payloads now ship INSIDE the APK (assets/runtime, pinned + SHA256'd by
 * scripts/fetch-engine-runtime.sh). This class streams them out of the APK
 * (verifying the SHA256 from assets/runtime/manifest.json as it goes), extracts
 * with [SafeTarExtractor] into staging dirs, patches the rootfs (resolv.conf,
 * hosts, /etc/hostname), then rename-swaps staging → live so a crash mid-way
 * never leaves a half-written rootfs as the active one.
 *
 * Offline first boot, no URL rot, and the exact payload is reproducible from
 * the pins in the fetch script.
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

        /** APK asset paths (shipped by scripts/fetch-engine-runtime.sh). */
        private const val ASSET_RUNTIME = "runtime"
        private const val ASSET_MANIFEST = "$ASSET_RUNTIME/manifest.json"

        /** Buffers: 256 KiB is plenty for hashing + copying APK streams. */
        private const val BUF = 256 * 1024

        /**
         * Headroom above the uncompressed payload before we refuse to install.
         * Covers the compressed archive while it is streamed out of the APK
         * (~30 MB) plus filesystem slack — a mid-extract ENOSPC would strand a
         * half-written staging dir behind an opaque failure.
         */
        private const val SPACE_MARGIN = 50L * 1024 * 1024

        // Kept for error messages / stage text parity with the plan.
        const val NODE_VERSION = "22.23.2"
    }

    /** Manifest entries (file + sha256 + uncompressed size), verified at install. */
    private data class RuntimeAsset(
        val file: String,
        val sha256: String,
        val version: String,
        val uncompressedBytes: Long,
    )

    private fun manifest(): Pair<RuntimeAsset, RuntimeAsset> {
        val raw = context.assets.open(ASSET_MANIFEST).bufferedReader().use { it.readText() }
        val obj = JSONObject(raw)
        fun entry(key: String) = obj.getJSONObject(key).let {
            RuntimeAsset(
                it.getString("file"),
                it.getString("sha256"),
                it.getString("version"),
                // optLong: manifests written before this field shipped (2026-09-04)
                // skip the preflight rather than crashing the parse.
                it.optLong("uncompressedBytes", 0L),
            )
        }
        return entry("rootfs") to entry("node")
    }

    /** True when a complete rootfs is present (marker matches payload version). */
    fun isRootfsReady(): Boolean {
        val (rootfsAsset, _) = manifest()
        return paths.rootfsMarker.readTextOrNull() == rootfsAsset.sha256 &&
            paths.rootfs.isDirectory
    }

    /** True when a complete Node install is present. */
    fun isNodeReady(): Boolean {
        val (_, nodeAsset) = manifest()
        return paths.nodeMarker.readTextOrNull() == nodeAsset.sha256 &&
            File(paths.node, "bin/node").exists()
    }

    private fun File.readTextOrNull(): String? = try {
        if (exists()) readText().trim() else null
    } catch (_: Exception) {
        null
    }

    /**
     * Refuse to start an install that cannot possibly fit. The archive is
     * streamed into engineDir and staging/live trees live under it too, so
     * StatFs on engineDir accounts for the whole lifecycle.
     */
    private fun requireSpaceFor(asset: RuntimeAsset) {
        val needed = asset.uncompressedBytes
        if (needed <= 0L) return // manifest predates the field: skip preflight
        val avail = StatFs(paths.engineDir.absolutePath).availableBytes
        if (avail < needed + SPACE_MARGIN) {
            val needMiB = (needed + SPACE_MARGIN) / (1024L * 1024)
            val haveMiB = avail / (1024L * 1024)
            throw IOException(
                "空間不足：安裝 ${asset.file} 需要約 $needMiB MB，" +
                    "裝置目前僅剩 $haveMiB MB。請先釋放儲存空間再重試。",
            )
        }
    }

    /**
     * Ensure both the rootfs and Node are installed from the APK assets.
     * Skips work when markers already match the shipped payload (so an app
     * update with the same runtime reuses the installed tree). Throws on
     * failure (SHA mismatch, extraction, IO).
     */
    suspend fun ensureInstalled(progress: Progress?, cancel: () -> Boolean = { false }) {
        paths.ensureDirs()
        val (rootfsAsset, nodeAsset) = manifest()

        if (!isRootfsReady()) {
            progress?.onStage("安裝 Ubuntu base ${rootfsAsset.version}（隨 APK 附帶，無需網路）")
            extractFromAssets(rootfsAsset, paths.rootfsStaging, paths.rootfs, paths.rootfsMarker, cancel, progress, innerDir = false)
        }

        if (!isNodeReady()) {
            progress?.onStage("解壓 Node.js $NODE_VERSION（隨 APK 附帶）")
            // live = paths.node (NOT paths.nodeStaging): the first device build
            // passed the staging dir as BOTH staging and live, which renamed
            // the finished tree into node.staging and then deleted it in the
            // same breath — leaving a marker for a deleted tree and a
            // subsequent "node binary missing" on the next boot attempt.
            extractFromAssets(nodeAsset, paths.nodeStaging, paths.node, paths.nodeMarker, cancel, progress, innerDir = true)
        }

        patchRootfs()
    }

    /**
     * Stream `assets/runtime/<file>` → [staging] with running SHA256, verify
     * against [asset].sha256, extract the tar, then rename-swap staging →
     * [live]. [marker] receives the payload SHA256 so the installed state is
     * keyed to the exact bits that shipped.
     */
    private suspend fun extractFromAssets(
        asset: RuntimeAsset,
        staging: File,
        live: File,
        marker: File,
        cancel: () -> Boolean,
        progress: Progress?,
        innerDir: Boolean = false,
    ) {
        // Fresh staging each time.
        staging.deleteRecursively()
        staging.mkdirs()
        // The marker already told the caller the installed tree is stale (bad
        // SHA or half-install), so the old live tree is worthless — drop it
        // BEFORE extracting so peak storage is archive + staging, never
        // archive + staging + old-live (~doubled on reinstall/upgrade).
        live.deleteRecursively()
        // Fails fast with a clear message when the payload cannot fit (a
        // mid-extract ENOSPC otherwise surfaces as a baffling "extraction failed").
        requireSpaceFor(asset)

        // 1. Stream the asset out of the APK, hashing as we go.
        val archive = File(paths.engineDir, asset.file)
        context.assets.open("$ASSET_RUNTIME/${asset.file}").use { input ->
            archive.outputStream().use { out ->
                val buf = ByteArray(BUF)
                val digest = MessageDigest.getInstance("SHA-256")
                var copied = 0L
                while (true) {
                    if (cancel()) {
                        archive.delete()
                        staging.deleteRecursively()
                        throw IOException("install cancelled")
                    }
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    digest.update(buf, 0, n)
                    copied += n
                    // APK assets report no total length via the streaming
                    // reader; show progress in 10 MiB milestones instead.
                    progress?.onProgress(((copied / (10L * 1024 * 1024)) * 10).toInt().coerceIn(0, 90))
                }
                val got = digest.digest().joinToString("") { "%02x".format(it) }
                if (got != asset.sha256) {
                    archive.delete()
                    staging.deleteRecursively()
                    throw IOException(
                        "runtime asset ${asset.file} SHA256 mismatch (got $got) — APK corrupt or repacked",
                    )
                }
            }
        }

        // 2. Extract (SafeTarExtractor transparently handles .gz / .xz).
        try {
            SafeTarExtractor.extract(archive, staging)
        } catch (e: Exception) {
            staging.deleteRecursively()
            // Carry the real cause in the message too: the boot-error page only
            // shows this wrapper text, so an ENOSPC / EPERM deep inside the
            // extractor must never be swallowed (2026-09-04 device feedback:
            // "extraction … failed" with no reason visible).
            throw RuntimeException("extraction of ${asset.file} failed: ${e.message}", e)
        } finally {
            // No-op safety net — SafeTarExtractor.extract unlinks the archive as
            // soon as its fd is open; this only guards the rare pre-extract throw.
            archive.delete()
        }

        // 3. Atomic swap: staging → live. Preserve the old live tree until the
        //    rename succeeds (ADR-13 pattern: never pre-delete the target).
        //    Node tarballs wrap everything under node-vX.Y.Z-linux-arm64/ —
        //    move that inner directory into the live slot instead.
        var swapFrom = staging
        if (innerDir) {
            val inner = staging.listFiles()?.firstOrNull { it.isDirectory && it.name.startsWith("node-v") }
                ?: throw RuntimeException("node tarball layout unexpected (no node-v*/ dir)")
            swapFrom = inner
        }
        val old = File(paths.engineDir, "${live.name}.old")
        old.deleteRecursively()
        if (live.exists()) live.renameTo(old)
        if (!swapFrom.renameTo(live)) {
            if (old.exists() && !live.exists()) old.renameTo(live)
            throw RuntimeException("rename to ${live.name} failed")
        }
        old.deleteRecursively()
        staging.deleteRecursively()
        marker.writeText(asset.sha256 + "\n")
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
}
