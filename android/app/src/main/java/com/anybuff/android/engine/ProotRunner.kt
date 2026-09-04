package com.anybuff.android.engine

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * proot sandbox runner (plan M-B1, largest component).
 *
 * proot is shipped as `libproot_exec.so` + `libproot_loader.so` in jniLibs
 * (arm64-v8a). With `useLegacyPackaging`, AGP extracts them to
 * nativeLibraryDir where SELinux permits executing app-installed libraries —
 * that is the whole W^X story: the loader (in nativeLibraryDir) execs the
 * guest ELF (the rootfs's /usr/bin/node) which lives on filesDir that SELinux
 * would otherwise refuse to exec on targetSdk ≥29 (oonid/pr finding; plan M-B1).
 *
 * The runner builds a ProcessBuilder for:
 *   libproot_exec.so --root-id --sysvipc --link2symlink --kill-on-exit
 *       --kernel-release=<fake> -r <rootfs> -w /workspace
 *       -b <hostdata>:/hostdata -b <engineAssets>:/engine-assets
 *       -b <nodeInstall>:/opt/node
 *       -b /dev -b /dev/urandom:/dev/random
 *       -b <proc-fakes>:/proc/stat -b <proc-fakes>:/proc/loadavg …
 *       -b <empty>:/sys/fs/selinux
 *       -b /proc -b /sys
 *       /usr/bin/env -i HOME=/root PATH=… TERM=xterm-256color …
 *       <node> <host bundle>
 *
 * NOTE: `env -i` wipes the environment INSIDE the guest, so the host's
 * ANYBUFF_HOST_* settings must be passed as env -i ARGUMENTS (after -i), not
 * merely set on the Android-side ProcessBuilder env. Getting this wrong
 * leaves the host with no data dir / wasm path / secrets — the exact class of
 * silent boot failure the 2026-09-03 device test surfaced.
 */
class ProotRunner(private val context: Context, private val paths: SandboxPaths) {

    companion object {
        private const val TAG = "AnyBuffProot"
        private const val PROOT_EXEC = "libproot_exec.so"
        private const val PROOT_LOADER = "libproot_loader.so"
        private const val FAKE_KERNEL = "6.1.0-android"

        /** Only origin allowed to open the host WS (the WebView origin). */
        private const val HOST_ORIGINS = "https://appassets.androidplatform.net"
    }

    /** Result of launching the host process. */
    data class HostProcess(
        val process: Process,
        val wsUrl: String,
        val token: String,
    )

    /**
     * The node runtime is installed to engineDir/node and BOUND into the guest
     * at /opt/node (a full copy into the rootfs would double ~190MB of device
     * storage for zero gain). The first command in the chain is the ROOTFS's
     * /usr/bin/env (coreutils), which applies env -i KEY=VALUE then execs
     * $guestNodeDir/bin/node → /engine-assets/anybuff-host.mjs.
     *
     * Legacy fallback kept only for trees installed by the very first device
     * build (node copied into rootfs /usr/local). The marker check re-installs
     * node on any SHA mismatch, so this path goes away after one clean boot.
     */
    private val guestNode: File
        get() = File(paths.node, "bin/node").takeIf { it.exists() }
            ?: File(paths.rootfs, "usr/local/bin/node") // pre-/opt-bind layout

    /**
     * Guest path where node is bound (must match guestNode + -b bind below).
     * /opt is a real directory in the ubuntu-base rootfs (mode 0755), so the
     * bind lands on an existing dir instead of a proot-created virtual one —
     * avoids the bind-to-missing-dir corner where proot <5 emulates the dir
     * with a symlink that trips --link2symlink handling.
     */
    private val guestNodeDir = "/opt/node"

    /** Find proot libs (nativeLibraryDir). Throws when absent. */
    private fun prootLib(name: String): File {
        val dir = File(context.applicationInfo.nativeLibraryDir)
        val f = File(dir, name)
        if (!f.exists()) {
            throw IOException(
                "proot library $name not found in ${dir.path} — " +
                    "run android/scripts/fetch-proot.sh and rebuild (plan §4 M-B1, R2).",
            )
        }
        return f
    }

    /**
     * libtalloc.so.2 ships as an asset (AGP jniLibs drops non-lib*.so files).
     * Stage it to filesDir so the Android linker can find it via
     * LD_LIBRARY_PATH — dlopen maps PROT_EXEC pages which is allowed on
     * app_data_file (unlike execve, which SELinux denies on targetSdk 29+).
     * Written via tmp+rename so a mid-copy kill can never poison the cache
     * (a corrupt .so would give proot an unexplainable linker error forever).
     */
    private fun stageTallocLib(): File {
        val dir = File(paths.engineDir, "libs")
        dir.mkdirs()
        val dest = File(dir, "libtalloc.so.2")
        if (!dest.exists()) {
            val tmp = File(dir, "libtalloc.so.2.tmp")
            context.assets.open("engine/lib/libtalloc.so.2").use { input ->
                tmp.outputStream().use { input.copyTo(it) }
            }
            if (!tmp.renameTo(dest)) {
                tmp.delete()
                throw IOException("failed to stage libtalloc.so.2")
            }
        }
        return dir
    }

    /**
     * Environment the guest shell sees — passed as `env -i` arguments so they
     * survive the wipe (hygienic: nothing else from the host leaks in).
     * ANYBUFF_HOST_* values are passed to the host process this way because
     * env -i would otherwise strip them (see class doc).
     */
    private fun guestEnv(hostSecretsJson: String): Map<String, String> {
        return mapOf(
            "HOME" to "/root",
            // /opt/node/bin first: node is bound at /opt/node (not copied into
            // the rootfs), so guest shells must find it on PATH.
            "PATH" to "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TERM" to "xterm-256color",
            "LANG" to "C.UTF-8",
            "LC_ALL" to "C.UTF-8",
            "CI" to "true",
            "NO_COLOR" to "1",
            "PAGER" to "cat",
            // Host process env (reaches the guest via env -i args).
            "ANYBUFF_HOST_DATA_DIR" to "/hostdata",
            "ANYBUFF_HOST_HOME" to "/root",
            "ANYBUFF_HOST_APPDATA" to "/hostdata",
            "ANYBUFF_HOST_ORIGINS" to HOST_ORIGINS,
            "ANYBUFF_HOST_RG_PATH" to "/engine-assets/vendor/ripgrep/arm64-linux/rg",
            // tree-sitter.wasm lives beside the host bundle in engine-assets;
            // the bundle reads CODEBUFF_TREE_SITTER_WASM_PATH (verified against
            // the dist bundle's resolveTreeSitterWasm).
            "CODEBUFF_TREE_SITTER_WASM_PATH" to "/engine-assets/tree-sitter.wasm",
            "CODEBUFF_WASM_DIR" to "/engine-assets/wasm",
            "ANYBUFF_HOST_SECRETS" to hostSecretsJson,
        )
    }

    /**
     * Start the host process inside the sandbox.
     *
     * @param hostSecretsJson JSON { providerId: plaintextApiKey } — see
     *   ANYBUFF_HOST_SECRETS in anybuff-host.ts. Empty when no keys hydrated.
     * @param workspaceDir Android dir to bind at /workspace inside the guest.
     * @return the running host process + its ready line.
     */
    fun startHost(hostSecretsJson: String, workspaceDir: File): HostProcess {
        paths.ensureDirs()
        val exec = prootLib(PROOT_EXEC)
        val rootfs = paths.rootfs
        if (!rootfs.isDirectory) throw IOException("rootfs not installed — run RootfsInstaller first")

        val nodeBin = guestNode
        if (!nodeBin.exists()) throw IOException("node not installed in rootfs at ${nodeBin.path}")

        // Paths to bind.
        val installDir = paths.installDir // host bundle + rg + wasm (from APK assets)
        val hostBundle = File(installDir, "anybuff-host.mjs")
        if (!hostBundle.exists()) throw IOException("host bundle missing at ${hostBundle.path}")

        // web-tree-sitter must be importable inside the guest: node resolves
        // it from <bundleDir>/node_modules/...
        val wtsDir = File(installDir, "node_modules/web-tree-sitter")
        if (!File(wtsDir, "tree-sitter.js").exists()) {
            throw IOException("web-tree-sitter module missing at ${wtsDir.path}")
        }

        // Pre-generate /proc fakes.
        val procFakes = paths.procFakes
        procFakes.mkdirs()
        File(procFakes, "stat").writeText(fakeProcStat())
        File(procFakes, "loadavg").writeText("0.00 0.01 0.05 1/100 1\n")
        File(procFakes, "version").writeText("Linux version 6.1.0-android (fake)\n")
        File(procFakes, "vmstat").writeText("nr_free_pages 100000\n")

        val wsWorkspace = File(workspaceDir, "workspace").apply { mkdirs() }
        val uploadDir = File(workspaceDir, "upload").apply { mkdirs() }
        val skillsDir = File(workspaceDir, "skills").apply { mkdirs() }

        val command = mutableListOf(
            exec.absolutePath,
            "--root-id",
            "--sysvipc",
            "--link2symlink",
            "--kill-on-exit",
            "--kernel-release=$FAKE_KERNEL",
            "-r", rootfs.absolutePath,
            "-w", "/workspace",
            "-b", "${wsWorkspace.absolutePath}:/workspace",
            "-b", "${installDir.absolutePath}:/engine-assets",
            "-b", "${paths.node.absolutePath}:$guestNodeDir",
            "-b", "${paths.hostData.absolutePath}:/hostdata",
            "-b", "${uploadDir.absolutePath}:/upload",
            "-b", "${skillsDir.absolutePath}:/skills",
            "-b", "/dev",
            "-b", "/dev/urandom:/dev/random",
            "-b", "${File(procFakes, "stat").absolutePath}:/proc/stat",
            "-b", "${File(procFakes, "loadavg").absolutePath}:/proc/loadavg",
            "-b", "${File(procFakes, "version").absolutePath}:/proc/version",
            "-b", "${File(procFakes, "vmstat").absolutePath}:/proc/vmstat",
            "-b", "/proc",
            "-b", "/sys",
            "/usr/bin/env", "-i",
        )
        // Guest env as env -i arguments — these survive the wipe and reach the
        // host process (data dir, wasm paths, origins, secrets; see class doc).
        // NOTE: pass the SECRETS JSON (one-shot handshake), not the hostData
        // path — the previous build passed the wrong argument here, which left
        // ANYBUFF_HOST_SECRETS unusable (and only visible via the drains).
        for ((k, v) in guestEnv(hostSecretsJson)) {
            command += "$k=$v"
        }
        command += listOf(
            "$guestNodeDir/bin/node",
            "/engine-assets/anybuff-host.mjs",
        )

        val pb = ProcessBuilder(command)
        pb.redirectErrorStream(true)
        // Android-side (pre-proot) environment. This env is NOT what the guest
        // sees — proot is the process being exec'd here, so this env must only
        // carry what PROOT ITSELF needs: its loader path, tmp dir, and the
        // LD_LIBRARY_PATH so its NEEDED libs (libtalloc.so.2, libandroid-shmem.so)
        // resolve from nativeLibraryDir. Everything meant for the guest goes as
        // env -i arguments instead (see guestEnv), because env -i wipes it.
        val hostEnv = pb.environment()
        hostEnv.clear()
        hostEnv["PROOT_LOADER"] = prootLib(PROOT_LOADER).absolutePath
        val prootTmp = File(paths.engineDir, "proot-tmp").apply { mkdirs() }
        hostEnv["PROOT_TMP_DIR"] = prootTmp.absolutePath
        // libtalloc.so.2 (asset-staged, see stageTallocLib) + nativeLibraryDir
        // (libandroid-shmem.so) — both must be visible to the proot process.
        hostEnv["LD_LIBRARY_PATH"] =
            stageTallocLib().absolutePath + ":" + context.applicationInfo.nativeLibraryDir
        hostEnv["TMPDIR"] = prootTmp.absolutePath

        Log.i(TAG, "Starting host: ${command.joinToString(" ")}")
        val process = pb.start()
        // Drain stdout in a thread so the pipe never deadlocks (128KB cap).
        val outBuf = StringBuilder()
        val drainer = Thread {
            val buf = CharArray(4096)
            try {
                process.inputStream.bufferedReader().use { r ->
                    while (true) {
                        val n = r.read(buf)
                        if (n < 0) break
                        if (outBuf.length < 128 * 1024) outBuf.append(buf, 0, n)
                        Log.d(TAG, String(buf, 0, n).trim())
                    }
                }
            } catch (_: IOException) {
            }
        }
        drainer.isDaemon = true
        drainer.start()

        // Wait for the ready line.
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            val m = Regex("ANYBUFF_HOST_READY (\\d+) (\\S+)").find(outBuf.toString())
            if (m != null) {
                val port = m.groupValues[1].toInt()
                val token = m.groupValues[2]
                val wsUrl = "ws://127.0.0.1:$port?token=$token"
                Log.i(TAG, "Host ready at $wsUrl")
                return HostProcess(process, wsUrl, token)
            }
            if (!process.isAlive) {
                throw IOException("host exited before ready. log:\n${outBuf}")
            }
            Thread.sleep(100)
        }
        process.destroy()
        throw IOException("timed out waiting for host ready. log:\n${outBuf}")
    }

    private fun fakeProcStat(): String {
        // Minimal /proc/stat that /proc readers tolerate.
        return "cpu  100 0 100 10000 0 0 0 0 0 0\n" +
            "cpu0 50 0 50 5000 0 0 0 0 0 0\n" +
            "intr 100 0 0 0 0 0 0 0 0 0\n" +
            "ctxt 1000\n" +
            "btime 1700000000\n" +
            "processes 10\n" +
            "procs_running 1\n" +
            "procs_blocked 0\n"
    }

    /** Kill the whole proot tree (used on destroy / stop). */
    fun stop(process: Process) {
        try {
            process.destroy()
            // Give it a moment, then force.
            if (!process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly()
            }
        } catch (_: Exception) {
        }
    }
}
