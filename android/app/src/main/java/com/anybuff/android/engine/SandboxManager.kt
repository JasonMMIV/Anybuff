package com.anybuff.android.engine

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * SandboxManager — coordinates the full engine lifecycle:
 *
 *   1. Ensure the APK-bundled engine assets are expanded from assets/engine
 *      into filesDir (host bundle, ripgrep, tree-sitter wasm) — done once,
 *      keyed on content hash so app updates re-copy changed bundles.
 *   2. Ensure the rootfs + Node are installed (RootfsInstaller) — download +
 *      extract + patch, with progress.
 *   3. Start the proot host (ProotRunner) and publish the WS URL + token for
 *      the WebView bridge.
 *   4. Stop / kill on demand (FGS stop, activity destroy).
 *
 * Keys never pass through this manager in plaintext beyond the one-shot
 * handshake JSON handed to the host (ADR-12).
 */
class SandboxManager private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val paths = SandboxPaths(appContext)
    private val installer = RootfsInstaller(appContext, paths)
    private val runner = ProotRunner(appContext, paths)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Active host process + its URL (null when stopped). */
    val host = AtomicReference<ProotRunner.HostProcess?>(null)

    /** Callbacks for install progress / boot state. */
    interface Listener {
        fun onStage(stage: String)
        fun onHostReady(wsUrl: String)
        fun onError(error: String)
    }

    companion object {
        private const val TAG = "AnyBuffSandbox"
        private const val ASSET_ENGINE = "engine" // assets/engine

        /**
         * Bump when the expanded-assets layout/versioning logic changes.
         * 2 = 2026-09-04 device round 4: top-level FILES under assets/engine
         * (anybuff-host.mjs, tree-sitter.wasm) were silently dropped by the
         * old copyDir — it listed every top-level entry as a directory and
         * bailed on the null list() a FILE returns. Bumping forces a
         * re-expansion on devices that already wrote the buggy v10000-l1.
         */
        private const val ASSET_LAYOUT = 2

        @Volatile
        private var instance: SandboxManager? = null

        fun get(context: Context): SandboxManager =
            instance ?: synchronized(this) {
                instance ?: SandboxManager(context).also { instance = it }
            }
    }

    /** True while a boot is in flight (single-flight guard for start()). */
    @Volatile
    private var starting = false

    /** Listeners awaiting a boot that is already in flight (recreated Activity). */
    private val pendingListeners = java.util.concurrent.ConcurrentLinkedQueue<Listener>()

    /** Idempotent boot. Safe to call repeatedly; no-ops when already up. */
    fun start(listener: Listener, hostSecretsJson: String = "{}") {
        val alive = host.get()?.process?.isAlive == true
        if (alive) {
            listener.onHostReady(host.get()!!.wsUrl)
            return
        }
        // Single-flight: without this, an Activity recreation during a long
        // first boot (rootfs install) would run two installs / two proots.
        if (starting) {
            // A boot is in flight (e.g. the Activity was recreated mid-install
            // via onRenderProcessGone) — the ORIGINAL caller's listener drives
            // it, so queue this new listener and replay onHostReady/onError
            // when the boot settles. Without this the new WebView would sit on
            // the splash forever (its listener never registered).
            pendingListeners.add(listener)
            return
        }
        starting = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    expandEngineAssets()
                    installer.ensureInstalled(
                        progress = object : RootfsInstaller.Progress {
                            override fun onStage(stage: String) = listener.onStage(stage)
                            override fun onProgress(percent: Int) { /* UI polls stage */ }
                        },
                    )
                }
                val workspaceDir = File(appContext.filesDir, "workspaces")
                val h = runner.startHost(hostSecretsJson, workspaceDir)
                host.set(h)
                listener.onHostReady(h.wsUrl)
                // Replay to late subscribers (recreated activities).
                while (true) {
                    val l = pendingListeners.poll() ?: break
                    try { l.onHostReady(h.wsUrl) } catch (_: Exception) {}
                }
            } catch (e: Exception) {
                Log.e(TAG, "sandbox start failed", e)
                // The boot-error page only shows the string handed here, so
                // surface the deepest actionable cause (ENOSPC / EPERM / …),
                // not just the stage wrapper text.
                val top = e.message ?: "sandbox start failed"
                val causeMsg = e.cause?.message
                    ?.takeIf { it.isNotBlank() && top.contains(it).not() }
                val msg = if (causeMsg != null) "$top（$causeMsg）" else top
                listener.onError(msg)
                while (true) {
                    val l = pendingListeners.poll() ?: break
                    try { l.onError(msg) } catch (_: Exception) {}
                }
            } finally {
                starting = false
            }
        }
    }

    /** Expand the APK-bundled engine assets into filesDir (once per app version). */
    private fun expandEngineAssets() {
        // Key the marker on the APK versionCode: an app update ships a new host
        // bundle / rg / wasm set and must re-expand over the old filesDir copy.
        val pm = appContext.packageManager
        val versionCode = if (android.os.Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(appContext.packageName, 0).longVersionCode
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(appContext.packageName, 0).versionCode.toLong()
        }
        val marker = File(paths.engineDir, ".expanded-v$versionCode-l$ASSET_LAYOUT")
        if (marker.exists() && paths.installDir.isDirectory) return

        paths.installDir.deleteRecursively()
        paths.installDir.mkdirs()

        // Recursive copy. Discriminate uniformly at EVERY level (including the
        // top: assets/engine holds files like anybuff-host.mjs and
        // tree-sitter.wasm right next to dirs). AssetManager.list() returns the
        // direct children of a directory, and null/empty for a path that is not
        // a directory. Treating empty-list as a FILE is safe because APK zips
        // carry no empty directories — every dir exists only via its contained
        // files — so an empty list() can only mean a file (or a path that
        // cannot exist). The old code fed every top-level entry into a dir-only
        // walker, which silently returned on the null list() a file produces —
        // dropping those two files and failing ProotRunner's host-bundle check
        // on device (2026-09-04 round 4).
        fun copyPath(rel: String) {
            val children = appContext.assets.list(rel)
            val out = File(paths.installDir, rel.removePrefix(ASSET_ENGINE + "/"))
            if (children.isNullOrEmpty()) {
                // A file: stream it out.
                out.parentFile?.mkdirs()
                appContext.assets.open(rel).use { input ->
                    out.outputStream().use { input.copyTo(it) }
                }
            } else {
                // A directory: make it, then recurse into each child.
                out.mkdirs()
                for (child in children) copyPath("$rel/$child")
            }
        }
        val rootChildren = appContext.assets.list(ASSET_ENGINE) ?: emptyArray()
        for (child in rootChildren) copyPath("$ASSET_ENGINE/$child")

        // rg must be executable once expanded (it is a static ELF).
        File(paths.installDir, "vendor/ripgrep/arm64-linux/rg").setExecutable(true)
        File(paths.installDir, "anybuff-host.mjs").setExecutable(true)

        marker.writeText("v$versionCode-l$ASSET_LAYOUT")
        Log.i(TAG, "engine assets expanded to ${paths.installDir}")
    }

    /** Stop the host and tear down the process tree. */
    fun stop() {
        host.get()?.let { h ->
            runner.stop(h.process)
            host.set(null)
        }
    }

    fun destroy() {
        stop()
        scope.cancel()
    }
}
