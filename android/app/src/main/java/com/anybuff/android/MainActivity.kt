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
        vault = KeyVault()
        webView = WebView(this)
        setContentView(webView)

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

            // Render-process crash recovery (R5): recreate the WebView.
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                runOnUiThread {
                    webView.destroy()
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
        )
        bridge.register()

        // Start the engine FGS and boot the sandbox. The keys are rehydrated
        // from Keystore and handed to the host in one shot (never to the page).
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
            hostSecretsJson = bridge.allPlaintextKeys(),
        )
    }

    /** Inject the WS/native globals then (re)load the app. Only once. */
    private fun injectAndLoad(wsUrl: String) {
        runOnUiThread {
            if (booted) return@runOnUiThread
            booted = true
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                bridge.bootstrapJs(wsUrl),
                setOf(APPASSETS_ORIGIN),
            )
            webView.loadUrl(APPASSETS_ORIGIN + "/assets/www/index.html")
        }
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
            runOnUiThread { onRetry() }
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
    }
}
