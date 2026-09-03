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
 *       -b /dev -b /dev/urandom:/dev/random
 *       -b <proc-fakes>:/proc/stat -b <proc-fakes>:/proc/loadavg …
 *       -b <empty>:/sys/fs/selinux
 *       -b /proc -b /sys
 *       /usr/bin/env -i HOME=/root PATH=… TERM=xterm-256color …
 *       <node> <host bundle>
 *
 * The host bundle (anybuff-host.mjs) is the self-contained @codebuff/host-core
 * WS server. Env vars ANYBUFF_HOST_* configure data dirs / secrets / rg path.
 */
class ProotRunner(private val context: Context, private val paths: SandboxPaths) {

    companion object {
        private const val TAG = "AnyBuffProot"
        private const val PROOT_EXEC = "libproot_exec.so"
        private const val PROOT_LOADER = "libproot_loader.so"
        private const val FAKE_KERNEL = "6.1.0-android"
    }

    /** Result of launching the host process. */
    data class HostProcess(
        val process: Process,
        val wsUrl: String,
        val token: String,
    )

    /** The node binary inside the installed rootfs. */
    private val guestNode: File
        get() = File(paths.rootfs, "usr/bin/node").takeIf { it.exists() }
            ?: File(paths.rootfs, "usr/local/bin/node")

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

    /** Environment the guest shell sees (hygienic — no host secrets/env leak). */
    private fun guestEnv(): Map<String, String> {
        // env -i semantics: start from nothing; only these are passed.
        return mapOf(
            "HOME" to "/root",
            "PATH" to "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TERM" to "xterm-256color",
            "LANG" to "C.UTF-8",
            "LC_ALL" to "C.UTF-8",
            "CI" to "true",
            "NO_COLOR" to "1",
            "PAGER" to "cat",
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
        for ((k, v) in guestEnv()) {
            command += "$k=$v"
        }
        command += listOf(
            "/usr/local/bin/node",
            "/engine-assets/anybuff-host.mjs",
        )

        val pb = ProcessBuilder(command)
        pb.redirectErrorStream(true)
        // Host env — NOTE: secrets only in memory via the ONE env var, and the
        // host deletes it from its own process.env immediately (ADR-12).
        val hostEnv = pb.environment()
        hostEnv.clear()
        hostEnv["ANYBUFF_HOST_DATA_DIR"] = paths.hostData.absolutePath
        hostEnv["ANYBUFF_HOST_HOME"] = "/root"
        hostEnv["ANYBUFF_HOST_ORIGINS"] = "https://appassets.androidplatform.net"
        hostEnv["ANYBUFF_HOST_RG_PATH"] = "/engine-assets/vendor/ripgrep/arm64-linux/rg"
        hostEnv["ANYBUFF_HOST_WASM_DIR"] = "/engine-assets/wasm"
        hostEnv["ANYBUFF_HOST_TS_WASM"] = "/engine-assets/wasm/tree-sitter.wasm"
        hostEnv["ANYBUFF_HOST_SECRETS"] = hostSecretsJson
        hostEnv["PROOT_LOADER"] = prootLib(PROOT_LOADER).absolutePath
        hostEnv["PROOT_TMP_DIR"] = paths.engineDir.absolutePath + "/proot-tmp"
        hostEnv["TMPDIR"] = "/tmp"
        hostEnv["PATH"] = "/usr/local/bin:/usr/bin:/bin"

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
