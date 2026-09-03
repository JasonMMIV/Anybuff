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

        /** Bump when the expanded-assets layout/versioning logic changes. */
        private const val ASSET_LAYOUT = 1

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

    /** Idempotent boot. Safe to call repeatedly; no-ops when already up. */
    fun start(listener: Listener, hostSecretsJson: String = "{}") {
        val alive = host.get()?.process?.isAlive == true
        if (alive) {
            listener.onHostReady(host.get()!!.wsUrl)
            return
        }
        // Single-flight: without this, an Activity recreation during a long
        // first boot (rootfs download) would run two installs / two proots.
        if (starting) {
            // A boot is already in progress; its listener will be the one to
            // receive onHostReady. Callers who need a callback can rely on the
            // activity re-subscribing via start() after host is set.
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
            } catch (e: Exception) {
                Log.e(TAG, "sandbox start failed", e)
                listener.onError(e.message ?: "sandbox start failed")
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

        val assetFiles = appContext.assets.list(ASSET_ENGINE) ?: emptyArray()
        fun copyDir(rel: String) {
            val children = appContext.assets.list(rel) ?: return
            for (child in children) {
                val childRel = "$rel/$child"
                if (appContext.assets.list(childRel)?.isNotEmpty() == true) {
                    File(paths.installDir, childRel.removePrefix(ASSET_ENGINE + "/")).mkdirs()
                    copyDir(childRel)
                } else {
                    val out = File(paths.installDir, childRel.removePrefix(ASSET_ENGINE + "/"))
                    out.parentFile?.mkdirs()
                    appContext.assets.open(childRel).use { input ->
                        out.outputStream().use { input.copyTo(it) }
                    }
                }
            }
        }
        assetFiles.forEach { copyDir("$ASSET_ENGINE/$it") }

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
