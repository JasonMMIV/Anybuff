package com.anybuff.android.bridge

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import android.webkit.WebView
import com.anybuff.android.crypto.KeyVault
import com.anybuff.android.engine.EngineLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * NativeBridge — the WebView ↔ Kotlin message channel (M-B3).
 *
 * The renderer talks to `window.AnyBuff` (the WS shim). For the handful of
 * shell-only capabilities the WS shim cannot provide — SAF file/folder
 * pickers, opening external URLs, reporting the installed app version, and
 * Keystore-backed key persistence — the WebView posts messages here under
 * the channel name "__anybuff_native". See renderer host-ws.ts
 * `AnyBuffNativeBridge` for the consumer shape.
 *
 * The bridge registers an origin allowlist of exactly
 * https://appassets.androidplatform.net (the WebViewAssetLoader origin), so no
 * other origin can invoke it.
 */
class NativeBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val pickFolderLauncher: ActivityResultLauncher<Uri?>,
    private val pickFilesLauncher: ActivityResultLauncher<Array<String>>,
    private val vault: KeyVault,
    private val appVersion: String,
    private val onRestartEngine: () -> Unit = {},
    /** Set by MainActivity: true once the appassets page finished loading. */
    private val pageReady: java.util.concurrent.atomic.AtomicBoolean = java.util.concurrent.atomic.AtomicBoolean(false),
) {
    companion object {
        private const val TAG = "AnyBuffBridge"
        private const val OBJECT_NAME = "androidNative"
        private const val ALLOWED_ORIGIN = "https://appassets.androidplatform.net"

        /**
         * Guest path of a folder the user picked in SAF that arrived with NO
         * live pending request — the Activity/WebView was recreated while the
         * picker was open, so the page that asked for it is gone and its
         * replyProxy is dead (plan §4.0 deferred item "SAF pending 跨 navigation
         * 的 replyProxy 失效"). Kept process-wide; delivery to the freshly
         * loaded page happens either when the page becomes ready
         * (flushPendingFolder from onPageFinished) or immediately when the
         * result arrives on an already-ready page.
         */
        @Volatile
        var pendingFolderPath: String? = null
    }

    /** Pending SAF results routed by request id. */
    private val pendingFolder = mutableMapOf<Long, JavaScriptReplyProxy>()
    private val pendingFiles = mutableMapOf<Long, JavaScriptReplyProxy>()
    private var nextRequestId = 1L

    fun register() {
        WebViewCompat.addWebMessageListener(
            webView,
            OBJECT_NAME,
            setOf(ALLOWED_ORIGIN),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy,
                ) {
                    if (!isMainFrame) return
                    val data = message.data ?: return
                    handleMessage(data, replyProxy)
                }
            },
        )
    }

    private fun handleMessage(data: String, replyProxy: JavaScriptReplyProxy) {
        try {
            val msg = JSONObject(data)
            val id = msg.optLong("id", -1)
            val method = msg.optString("method")
            when (method) {
                "pickFolder" -> {
                    pendingFolder[id] = replyProxy
                    try {
                        EngineLog.append(activity, "pick: picker opening (id=$id)")
                        pickFolderLauncher.launch(null)
                    } catch (e: Exception) {
                        // Never leave the renderer's promise hanging: an
                        // unusable picker must resolve, not time out forever.
                        pendingFolder.remove(id)
                        Log.e(TAG, "pickFolder launch failed", e)
                        post(id, replyProxy) { put("ok", false); put("error", "failed to open folder picker") }
                    }
                }
                "restartEngine" -> {
                    // WS-dead recovery (renderer shows the lost-connection
                    // overlay): stop + reboot the sandbox host, then the page
                    // reloads with the fresh WS URL (injectAndLoad).
                    post(id, replyProxy) { put("ok", true) }
                    onRestartEngine()
                }
                "pickFiles" -> {
                    pendingFiles[id] = replyProxy
                    pickFilesLauncher.launch(arrayOf("*/*"))
                }
                "takeStagedFolder" -> {
                    // Page-mounted PULL of a staged SAF pick. The push
                    // (flushPendingFolder, from onPageFinished) can fire before
                    // the freshly (re)created page has mounted its listener —
                    // onPageFinished races React's module evaluation + mount —
                    // so a reload would silently lose the user's pick. The
                    // page therefore asks once it is actually ready to apply
                    // one. Delivery is single-shot: the holder clears HERE
                    // (the push never clears it).
                    val staged = pendingFolderPath
                    pendingFolderPath = null
                    EngineLog.append(activity, "pick: staged folder pulled (${staged ?: "none"})")
                    post(id, replyProxy) { put("path", staged ?: JSONObject.NULL) }
                }
                "openExternal" -> {
                    val url = msg.optString("url")
                    openExternal(url)
                    post(id, replyProxy) { put("ok", true) }
                }
                "getVersion" -> {
                    post(id, replyProxy) { put("version", appVersion) }
                }
                "readEngineLog" -> {
                    // Engine diagnostics WITHOUT adb: the renderer reads the
                    // on-device ring buffer (host stdout, exits, WS events)
                    // and shows it in Settings → Engine.
                    val log = EngineLog.readTail(activity)
                    post(id, replyProxy) { put("ok", true); put("log", log) }
                }
                "logEvent" -> {
                    EngineLog.append(
                        activity,
                        "ui/${msg.optString("kind")}: ${msg.optString("detail")}",
                    )
                    post(id, replyProxy) { put("ok", true) }
                }
                "saveKey" -> {
                    // { providerId, apiKey } → Keystore encrypt → filesDir.
                    val providerId = msg.optString("providerId")
                    val apiKey = msg.optString("apiKey")
                    val ok = vault.saveProviderKey(providerId, apiKey)
                    // Round-10 breadcrumb: key saves used to fail with no
                    // trace — the engine log now records what landed.
                    EngineLog.append(
                        activity,
                        if (ok) "keys: saved $providerId" else "keys: save FAILED for $providerId",
                    )
                    post(id, replyProxy) { put("ok", ok) }
                }
                "deleteKey" -> {
                    val providerId = msg.optString("providerId")
                    val ok = vault.deleteProviderKey(providerId)
                    EngineLog.append(
                        activity,
                        if (ok) "keys: deleted $providerId" else "keys: delete FAILED for $providerId",
                    )
                    post(id, replyProxy) { put("ok", ok) }
                }
                else -> post(id, replyProxy) { put("ok", false); put("error", "unknown method $method") }
            }
        } catch (e: Exception) {
            Log.e(TAG, "bridge message failed", e)
        }
    }

    /* The durable provider-key store (filesDir/provider-keys.json,
     * Keystore-encrypted values) lives in KeyVault — moved there in round 10
     * so the app-process singleton SandboxManager can read the FRESH key set
     * at every host spawn without capturing an Activity. */

    /* ── SAF result delivery ─────────────────────────────────── */

    fun onFolderPicked(uri: Uri?) {
        // The request may be gone: opening DocumentsUI (a heavyweight activity)
        // frequently gets the app's activity killed and recreated on return,
        // which destroys this bridge's pending map along with the old page.
        EngineLog.append(activity, "pick: SAF result uri=${uri ?: "null"}")
        val entry = pendingFolder.entries.firstOrNull()
        if (entry != null) pendingFolder.remove(entry.key)
        val id = entry?.key ?: -1L
        val replyProxy = entry?.value
        if (entry == null) EngineLog.append(activity, "pick: no live pending request — result will be staged")

        // Copy OFF the main thread: a project tree can be thousands of files
        // and DocumentsProvider IPC is slow — copying inline would freeze the
        // UI (ANR) for minutes.
        Thread {
            val result = if (uri == null) CopyResult(null, null) else copyTreeToUpload(uri)
            if (result.error != null) {
                // Surface copy failures as a UI notice too — a failed pick must
                // never look like a silent no-op on the welcome screen.
                pushProgress("{\"phase\":\"error\",\"error\":${JSONObject.quote(result.error)}}")
            } else if (result.path != null) {
                pushProgress("{\"phase\":\"done\"}")
            }
            if (replyProxy != null && postSafely(id, replyProxy, result)) {
                EngineLog.append(activity, "pick: replied live id=$id path=${result.path}")
            }
            // Stage EVERY successfully copied pick — not just the no-live-request
            // case. A live reply that "succeeded" from this side can still be lost
            // before the page's JS runs it: the render process can die between the
            // reply and the handler (memory pressure), the Activity can be
            // recreated racing the picker return, or the reply listener can be
            // missing (the round-9 bug this whole path backstops). The staged
            // holder is process-wide and survives recreation; it is flushed right
            // now when the page is ready, or by the next onPageFinished. The
            // renderer dedupes (its folder-pending handler skips a path equal to
            // the current cwd), so the double delivery is harmless.
            if (result.path != null) {
                pendingFolderPath = result.path
                EngineLog.append(activity, "pick: staged ${result.path} for the loaded page")
                activity.runOnUiThread {
                    if (pageReady.get()) flushPendingFolder()
                }
            }
        }.start()
    }

    /**
     * Push a staged SAF folder to the current page (main thread only). Called
     * from onPageFinished and from onFolderPicked when the page is already
     * ready. The renderer listens for 'anybuff:folder-pending' and applies the
     * path like a successful pickFolder (setCwd + persist).
     */
    fun flushPendingFolder() {
        val p = pendingFolderPath ?: return
        EngineLog.append(activity, "pick: flushing staged folder $p")
        val escaped = p.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r")
        try {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('anybuff:folder-pending', { detail: '$escaped' }));",
                null,
            )
        } catch (e: Exception) {
            // Page not in a state that can run JS (still loading / destroyed).
            // The holder is deliberately NOT cleared here: this push can also
            // land before the fresh page's React app has mounted its listener
            // (onPageFinished races module evaluation), so the only reliable
            // delivery is the page's own pull (takeStagedFolder), which is
            // also the only place that clears the holder.
            Log.w(TAG, "pending folder push failed", e)
        }
    }

    /** Reply to the live page (main thread); false when the proxy is dead. */
    private fun postSafely(id: Long, replyProxy: JavaScriptReplyProxy, result: CopyResult): Boolean {
        val latch = java.util.concurrent.CountDownLatch(1)
        val failed = java.util.concurrent.atomic.AtomicBoolean(false)
        activity.runOnUiThread {
            try {
                post(id, replyProxy) {
                    if (result.path != null) {
                        put("path", result.path)
                    } else {
                        put("path", JSONObject.NULL)
                        if (result.error != null) put("error", result.error)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "replyProxy postMessage failed (page likely recreated)", e)
                EngineLog.append(activity, "pick: live reply failed (${e.message})")
                failed.set(true)
            } finally {
                latch.countDown()
            }
        }
        return try {
            latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
            !failed.get()
        } catch (e: InterruptedException) {
            false
        }
    }

    fun onFilesPicked(uris: List<Uri>) {
        val entry = pendingFiles.entries.firstOrNull() ?: return
        pendingFiles.remove(entry.key)
        val replyProxy = entry.value
        val paths = uris.map { copyToUpload(it) }.filterNotNull()
        post(entry.key, replyProxy) { put("paths", JSONArray(paths)) }
    }

    private data class CopyResult(val path: String?, val error: String?)

    /**
     * Push folder-import progress to the page (main thread, best-effort).
     * [detailJson] is a raw JSON object literal. The renderer listens for
     * 'anybuff:folder-progress' and surfaces it as a notice — a large project
     * can copy for minutes over DocumentsProvider IPC, and silence reads as
     * "the pick did nothing" (the exact welcome-screen complaint).
     */
    private fun pushProgress(detailJson: String) {
        activity.runOnUiThread {
            try {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('anybuff:folder-progress', { detail: $detailJson }));",
                    null,
                )
            } catch (_: Exception) {
                // Progress is cosmetic; never let it break the pick.
            }
        }
    }

    private fun copyTreeToUpload(uri: Uri): CopyResult = try {
        val docFile = androidx.documentfile.provider.DocumentFile.fromTreeUri(activity, uri)
            ?: return CopyResult(null, "could not open the selected folder")
        val name = docFile.name ?: "folder"
        // A picked FOLDER becomes a project workspace: it must live under the
        // dir ProotRunner binds at /workspace (filesDir/workspaces/workspace),
        // and the returned path must be the GUEST path — a host-absolute
        // /data/user/0/... path does not exist inside the chrooted host.
        val destRoot = File(activity.filesDir, "workspaces/workspace").apply { mkdirs() }
        val dest = File(destRoot, name)
        if (dest.exists()) dest.deleteRecursively()
        EngineLog.append(activity, "pick: copying '$name' → /workspace/$name")
        pushProgress("{\"phase\":\"copying\",\"copied\":0}")
        val copied = intArrayOf(0)
        copyDocTree(docFile, dest, copied)
        EngineLog.append(activity, "pick: copy done ${copied[0]} files → /workspace/$name")
        CopyResult("/workspace/$name", null)
    } catch (e: Exception) {
        Log.e(TAG, "copyTreeToUpload failed", e)
        EngineLog.append(activity, "pick: copy FAILED: ${e.message}")
        CopyResult(null, e.message ?: "could not copy the selected folder")
    }

    private fun copyDocTree(
        doc: androidx.documentfile.provider.DocumentFile,
        dest: File,
        copied: IntArray,
    ) {
        dest.mkdirs()
        doc.listFiles().forEach { child ->
            val out = File(dest, child.name ?: return@forEach)
            if (child.isDirectory) copyDocTree(child, out, copied)
            else {
                activity.contentResolver.openInputStream(child.uri)?.use { input ->
                    out.outputStream().use { input.copyTo(it) }
                }
                copied[0]++
                if (copied[0] % 100 == 0) {
                    pushProgress("{\"phase\":\"copying\",\"copied\":${copied[0]}}")
                }
            }
        }
    }

    private fun copyToUpload(uri: Uri): String? = try {
        val name = queryDisplayName(uri) ?: "upload_${System.currentTimeMillis()}"
        // Picked FILES are agent attachments: copy under the dir ProotRunner
        // binds at /upload (filesDir/workspaces/upload) and return the GUEST
        // path, which is what the sandboxed host can actually read.
        val destRoot = File(activity.filesDir, "workspaces/upload").apply { mkdirs() }
        val dest = File(destRoot, name)
        activity.contentResolver.openInputStream(uri)?.use { input ->
            dest.outputStream().use { input.copyTo(it) }
        }
        "/upload/$name"
    } catch (e: Exception) {
        Log.e(TAG, "copyToUpload failed", e)
        null
    }

    private fun queryDisplayName(uri: Uri): String? = try {
        activity.contentResolver.query(
            uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null,
        )?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (e: Exception) {
        null
    }

    private fun openExternal(url: String) {
        // Only http(s) — never allow renderer content (model output, links) to
        // reach file:/intent:/… handlers on the device.
        val parsed = try {
            Uri.parse(url)
        } catch (e: Exception) {
            null
        }
        val scheme = parsed?.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            Log.w(TAG, "openExternal rejected non-http(s) url: $url")
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, parsed))
        } catch (e: Exception) {
            Log.w(TAG, "no handler for $url", e)
        }
    }

    /* ── reply helper ────────────────────────────────────────── */

    private fun post(id: Long, replyProxy: JavaScriptReplyProxy, fill: JSONObject.() -> Unit) {
        val obj = JSONObject()
        if (id >= 0) obj.put("id", id)
        obj.fill()
        replyProxy.postMessage(obj.toString())
    }

    /** The JS the WS shim expects — a bridge that returns Promises. */
    fun bootstrapJs(wsUrl: String): String {
        // The renderer's createWsAnyBuff reads __ANYBUFF_NATIVE__ (host-ws.ts)
        // for pickFolder/pickFiles/openExternal/getVersion/restartEngine. This
        // exposes that object backed by the message channel.
        val escapedWs = wsUrl.replace("\\", "\\\\").replace("'", "\\'")
        return """
        (function () {
          const send = (method, payload) =>
            new Promise((resolve) => {
              const id = Math.floor(Math.random() * 1e9);
              // Replies from JavaScriptReplyProxy.postMessage are delivered to
              // the injected object's OWN onmessage/addEventListener('message')
              // — they are NEVER dispatched as DOM 'message' events on window
              // (the WebMessageListener channel lives outside Blink's event
              // machinery; see androidx.webkit WebViewCompat#addWebMessageListener
              // javadoc and components/js_injection/renderer/js_binding.cc).
              // The old window.addEventListener here never fired: the picker
              // opened and the copy succeeded, but the reply was silently
              // dropped and the awaiting pickFolder() promise hung forever —
              // the "selected a folder, UI still shows no project" bug.
              const handler = (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch (e) { return; }
                if (!msg || msg.id !== id) return;
                try { androidNative.removeEventListener('message', handler); } catch (e) {}
                // Diagnostic breadcrumb (logged on the MATCHED reply only, so
                // concurrent sends cannot mislabel it): confirms bridge replies
                // reach the page — the round-9 bug made every one of these silent.
                try { androidNative.postMessage(JSON.stringify({ method: 'logEvent', kind: 'bridge', detail: 'reply ' + method + ' id=' + id })); } catch (e) {}
                resolve(msg);
              };
              androidNative.addEventListener('message', handler);
              androidNative.postMessage(JSON.stringify(Object.assign({ id, method }, payload || {})));
            });
          window.__ANYBUFF_WS_URL__ = '$escapedWs';
          window.__ANYBUFF_APP_VERSION__ = '$appVersion';
          window.__ANYBUFF_NATIVE__ = {
            pickFolder: () => send('pickFolder').then(r => (r.error ? Promise.reject(new Error(r.error)) : r.path || null)),
            pickFiles: () => send('pickFiles').then(r => r.paths || []),
            openExternal: (url) => { androidNative.postMessage(JSON.stringify({ method: 'openExternal', url })); },
            getVersion: () => send('getVersion').then(r => r.version),
            restartEngine: () => { androidNative.postMessage(JSON.stringify({ method: 'restartEngine' })); },
            readEngineLog: () => send('readEngineLog').then(r => r.log || ''),
            takeStagedFolder: () => send('takeStagedFolder').then(r => r.path || null),
            logEvent: (kind, detail) => { try { androidNative.postMessage(JSON.stringify({ method: 'logEvent', kind: String(kind || ''), detail: String(detail || '') })); } catch (e) {} },
            // saveKey/deleteKey hand a freshly-typed key to the shell for
            // Keystore storage (same transient renderer→native crossing the
            // desktop IPC does). Stored keys are NEVER readable back by the
            // page (§2.2 — the host rehydrates from Keystore at boot).
            saveKey: (providerId, apiKey) => send('saveKey', { providerId, apiKey }).then(r => r.ok),
            deleteKey: (providerId) => send('deleteKey', { providerId }).then(r => r.ok),
          };
        })();
        """.trimIndent()
    }
}
