package com.anybuff.android

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import com.anybuff.android.bridge.NativeBridge
import com.anybuff.android.crypto.KeyVault
import com.anybuff.android.engine.EngineLog
import com.anybuff.android.engine.EngineService
import com.anybuff.android.engine.SandboxManager

/**
 * MainActivity — hosts the AnyBuff renderer (shared React UI) inside a WebView.
 *
 * Boot flow (M-B0 + M-B1 + M-B3):
 *  1. Load a static boot screen from assets (renderer's index.html shows a
 *     "starting engine" splash while the sandbox boots).
 *  2. SandboxManager.start() installs rootfs+Node (first run) and starts the
 *     proot host (anybuff-host.mjs over WS).
 *  3. On host-ready, NativeBridge.bootstrapJs(wsUrl) injects the globals the
 *     renderer's WS shim needs (__ANYBUFF_WS_URL__, __ANYBUFF_NATIVE__,
 *     __ANYBUFF_APP_VERSION__) and reloads the page → the React app mounts and
 *     talks to the engine exactly like the desktop renderer talks to Electron.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge
    private lateinit var vault: KeyVault
    private var booted = false
    /** True once the appassets page finished loading (pending-folder push gate). */
    private val pageReady = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Current system dark/light theme (round 12) — the shell is the source of
     * truth for the renderer's 'system' theme mode: the WebView's
     * prefers-color-scheme media query is derived from this Activity's theme
     * (isLightTheme), not from the system uiMode, and never live-updates (see
     * onConfigurationChanged). UI-thread confined: written in onCreate /
     * onConfigurationChanged, read by injectAndLoad's runOnUiThread block.
     */
    private var systemTheme: String = "light"

    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        bridge.onFolderPicked(uri)
    }
    private val pickFiles =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            bridge.onFilesPicked(uris)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        vault = KeyVault(this)
        // Round 12: capture the true system theme before the first bootstrap —
        // the renderer's 'system' mode reads this, not the WebView media query
        // (see onConfigurationChanged).
        systemTheme = themeFromConfiguration(resources.configuration)
        webView = WebView(this)
        setContentView(webView)

        // Crash-loop guard landed (see onRenderProcessGone): the fresh WebView
        // is healthy, but re-loading the app right now would just crash again
        // (the memory pressure is still there). Show the error page instead of
        // re-booting the engine (which is already running). Retry re-boots.
        if (showCrashLoopError) {
            showCrashLoopError = false
            showBootError("The app UI crashed repeatedly (likely memory pressure). Free some memory and retry.")
            return
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): android.webkit.WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                if (url?.startsWith(APPASSETS_ORIGIN) == true) pageReady.set(false)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (url?.startsWith(APPASSETS_ORIGIN) == true) {
                    pageReady.set(true)
                    // A folder picked in SAF while this page was being (re)created
                    // may have been staged after the load started — deliver it
                    // now that the page can run JS.
                    bridge.flushPendingFolder()
                    // Round 12: re-sync the injected system theme on every page
                    // load — a dark-mode toggle during the load (or before the
                    // renderer mounted its listener) left the page with a stale
                    // value; the re-dispatch is idempotent for the renderer.
                    pushSystemTheme(systemTheme)
                }
            }
            // Render-process crash recovery (R5): recreate the WebView. The
            // renderer is usually killed by system memory pressure (the proot
            // Node host + long conversations push the device), so recovery must
            // be robust: detach BEFORE destroy (destroy while still attached is
            // an IllegalStateException on some WebView versions → app crash
            // instead of recovery), and stop after 3 crashes in 30s — an endless
            // destroy/recreate loop would leave a permanently white screen. On
            // the crash-loop path we still recreate() (a dead WebView cannot
            // host ANY page, not even the error page) and let the fresh
            // activity's onCreate show the error UI instead of re-booting.
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - firstRenderCrashAt > CRASH_GUARD_WINDOW_MS) {
                    firstRenderCrashAt = now
                    rendererCrashes = 0
                }
                rendererCrashes++
                runOnUiThread {
                    (webView.parent as? ViewGroup)?.removeView(webView)
                    webView.destroy()
                    if (rendererCrashes >= MAX_RENDERER_RECREATES) {
                        rendererCrashes = 0
                        firstRenderCrashAt = 0
                        showCrashLoopError = true
                    }
                    recreate()
                }
                return true
            }
        }

        bridge = NativeBridge(
            activity = this,
            webView = webView,
            pickFolderLauncher = pickFolder,
            pickFilesLauncher = pickFiles,
            vault = vault,
            appVersion = BuildConfig.VERSION_NAME,
            onRestartEngine = { restartEngine() },
            pageReady = pageReady,
        )
        bridge.register()

        // Start the engine FGS and boot the sandbox. Keys are read from the
        // Keystore at spawn time inside SandboxManager and handed to the host
        // in one shot (never to the page).
        startEngineService()
        bootEngine()
    }

    private fun bootEngine() {
        SandboxManager.get(this).start(
            listener = object : SandboxManager.Listener {
                override fun onStage(stage: String) { /* splash shows stage */ }
                override fun onHostReady(wsUrl: String) = injectAndLoad(wsUrl)
                override fun onError(error: String) = showBootError(error)
            },
        )
    }

    /** Inject the WS/native globals then (re)load the app. Only once. */
    private fun injectAndLoad(wsUrl: String) {
        runOnUiThread {
            // A background auto-reboot can finish after the activity was
            // destroyed (system killed the app while rebooting) — loadUrl on a
            // destroyed WebView throws; skip and let the next creation boot.
            if (isFinishing || isDestroyed) return@runOnUiThread
            if (booted) return@runOnUiThread
            booted = true
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                bridge.bootstrapJs(wsUrl, systemTheme),
                setOf(APPASSETS_ORIGIN),
            )
            webView.loadUrl(APPASSETS_ORIGIN + "/assets/www/index.html")
        }
    }

    /**
     * WS-dead recovery: the renderer detected the host socket closed (engine
     * process died / was killed) and the user tapped "Restart Engine". Tear
     * down the sandbox, clear the boot latch and boot again — the fresh host
     * publishes a NEW port+token, which injectAndLoad re-injects on reload.
     */
    fun restartEngine() {
        EngineLog.append(this, "engine restart requested (renderer overlay)")
        // booted flips on the UI thread; the stop itself can block several
        // seconds (process waitFor + tree kill) — keep it off the UI thread
        // or every restart stutters/ANRs the activity.
        runOnUiThread { booted = false }
        Thread {
            SandboxManager.get(this).stop()
            runOnUiThread { bootEngine() }
        }.start()
    }

    private fun showBootError(error: String) {
        runOnUiThread {
            // Inline error page (renderer may not be reachable). The retry
            // button calls back into the activity via the JS bridge object —
            // location.reload() cannot re-run the Kotlin boot path.
            webView.addJavascriptInterface(BootErrorJs { bootEngine() }, "__AnyBuffBoot")
            webView.loadDataWithBaseURL(
                null,
                "<html><body style='background:#0F1115;color:#e5e7eb;font-family:sans-serif;padding:24px'>" +
                    "<h2>引擎啟動失敗</h2><p style='color:#9ca3af'>$error</p>" +
                    "<p><button onclick='__AnyBuffBoot.retry()'>重試</button></p></body></html>",
                "text/html", "utf-8", null,
            )
        }
    }

    /** JS entry point for the boot-error page's retry button. */
    private inner class BootErrorJs(private val onRetry: () -> Unit) {
        @android.webkit.JavascriptInterface
        fun retry() {
            // The error page can appear after a successful boot (crash-loop
            // guard); clear the latch so injectAndLoad re-injects + reloads
            // instead of no-op'ing on the already-true booted flag.
            runOnUiThread {
                booted = false
                onRetry()
            }
        }
    }

    private fun startEngineService() {
        val intent = Intent(this, EngineService::class.java)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    /** Map a configuration's night mode onto the renderer's theme ids. */
    private fun themeFromConfiguration(config: android.content.res.Configuration): String =
        if ((config.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        ) "dark" else "light"

    /**
     * Round 12: forward system dark-mode toggles to the renderer. The
     * manifest keeps uiMode in android:configChanges deliberately —
     * recreating the Activity would tear down the WebView and re-race the
     * sandbox boot path (round-8 crash-recovery discipline) — so the change
     * is pushed instead: the live page gets a DOM event, and a later page
     * reload picks the fresh value up from the document-start bootstrap
     * (bootstrapJs reads systemTheme at injection time).
     */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        val next = themeFromConfiguration(newConfig)
        if (next != systemTheme) {
            systemTheme = next
            pushSystemTheme(next)
        }
    }

    /** Push the current system theme to the live page (main thread, best-effort). */
    private fun pushSystemTheme(theme: String) {
        runOnUiThread {
            // A config change can race activity teardown — never touch a
            // destroyed WebView (explicit intent guard; the try/catch below
            // is the belt).
            if (isFinishing || isDestroyed) return@runOnUiThread
            // pageReady gates evaluateJavascript: a mid-load page may not run
            // JS reliably, and the document-start bootstrap carries the fresh
            // value into the next load anyway.
            if (!pageReady.get()) return@runOnUiThread
            try {
                webView.evaluateJavascript(
                    "window.__ANYBUFF_SYSTEM_THEME__ = '$theme';" +
                        " window.dispatchEvent(new CustomEvent('anybuff:system-theme-change'));",
                    null,
                )
            } catch (_: Exception) {
                // Page not in a state that can run JS — the bootstrap covers it.
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Activity finishing (back / swipe): tear down the sandbox AND the
        // engine service together — a live START_STICKY FGS must not outlive
        // a killed sandbox (notification would claim a running engine).
        // NOTE: onDestroy also fires on config-change recreation; those paths
        // are avoided here because configChanges handles rotation and the
        // activity is not finishing in those cases.
        if (isFinishing) {
            SandboxManager.get(this).stop()
            startService(EngineService.shutdownIntent(this))
        }
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private companion object {
        const val APPASSETS_ORIGIN = "https://appassets.androidplatform.net"
        const val MAX_RENDERER_RECREATES = 3
        const val CRASH_GUARD_WINDOW_MS = 30_000L

        /** Process-wide: set when the crash-loop guard trips, read + cleared
         * by the next activity's onCreate so it shows the error page. */
        @Volatile
        var showCrashLoopError = false
    }

    /** Renderer crash-loop guard state (see onRenderProcessGone). */
    private var rendererCrashes = 0
    private var firstRenderCrashAt = 0L
}
