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
) {
    companion object {
        private const val TAG = "AnyBuffBridge"
        private const val OBJECT_NAME = "androidNative"
        private const val ALLOWED_ORIGIN = "https://appassets.androidplatform.net"
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
                    pickFolderLauncher.launch(null)
                }
                "pickFiles" -> {
                    pendingFiles[id] = replyProxy
                    pickFilesLauncher.launch(arrayOf("*/*"))
                }
                "openExternal" -> {
                    val url = msg.optString("url")
                    openExternal(url)
                    post(id, replyProxy) { put("ok", true) }
                }
                "getVersion" -> {
                    post(id, replyProxy) { put("version", appVersion) }
                }
                "saveKey" -> {
                    // { providerId, apiKey } → Keystore encrypt → filesDir.
                    val providerId = msg.optString("providerId")
                    val apiKey = msg.optString("apiKey")
                    val ok = saveProviderKey(providerId, apiKey)
                    post(id, replyProxy) { put("ok", ok) }
                }
                "deleteKey" -> {
                    val ok = deleteProviderKey(msg.optString("providerId"))
                    post(id, replyProxy) { put("ok", ok) }
                }
                else -> post(id, replyProxy) { put("ok", false); put("error", "unknown method $method") }
            }
        } catch (e: Exception) {
            Log.e(TAG, "bridge message failed", e)
        }
    }

    /* ── Keystore key store (filesDir/keys.json, values encrypted) ── */

    private fun keysFile(): File = File(activity.filesDir, "provider-keys.json")

    private fun loadKeyMap(): MutableMap<String, String> = try {
        val raw = keysFile().readText()
        val obj = JSONObject(raw)
        val map = mutableMapOf<String, String>()
        obj.keys().forEach { k -> map[k] = obj.getString(k) }
        map
    } catch (e: Exception) {
        mutableMapOf()
    }

    private fun saveKeyMap(map: Map<String, String>) {
        val obj = JSONObject()
        map.forEach { (k, v) -> obj.put(k, v) }
        // Atomic write: a kill mid-write must not corrupt the whole key store
        // (same pattern as host-core files/atomic-write).
        val tmp = File(keysFile().parentFile, keysFile().name + ".tmp")
        tmp.writeText(obj.toString())
        if (!tmp.renameTo(keysFile())) {
            tmp.delete()
            keysFile().writeText(obj.toString())
        }
    }

    private fun saveProviderKey(providerId: String, apiKey: String): Boolean {
        return try {
            if (apiKey.isEmpty()) {
                deleteProviderKey(providerId)
                return true
            }
            val map = loadKeyMap()
            map[providerId] = vault.encrypt(apiKey)
            saveKeyMap(map)
            true
        } catch (e: Exception) {
            Log.e(TAG, "saveProviderKey failed", e)
            false
        }
    }

    private fun deleteProviderKey(providerId: String): Boolean = try {
        val map = loadKeyMap()
        map.remove(providerId)
        saveKeyMap(map)
        true
    } catch (e: Exception) {
        false
    }

    /** JSON map of ALL decrypted keys for the one-shot host handshake. */
    fun allPlaintextKeys(): String {
        val obj = JSONObject()
        loadKeyMap().forEach { (id, enc) ->
            vault.decrypt(enc)?.let { obj.put(id, it) }
        }
        return obj.toString()
    }

    /* ── SAF result delivery ─────────────────────────────────── */

    fun onFolderPicked(uri: Uri?) {
        val entry = pendingFolder.entries.firstOrNull() ?: return
        pendingFolder.remove(entry.key)
        val replyProxy = entry.value
        val dest = if (uri == null) null else copyTreeToUpload(uri)
        val id = entry.key
        post(id, replyProxy) {
            if (dest != null) put("path", dest) else put("path", JSONObject.NULL)
        }
    }

    fun onFilesPicked(uris: List<Uri>) {
        val entry = pendingFiles.entries.firstOrNull() ?: return
        pendingFiles.remove(entry.key)
        val replyProxy = entry.value
        val paths = uris.map { copyToUpload(it) }.filterNotNull()
        post(entry.key, replyProxy) { put("paths", JSONArray(paths)) }
    }

    private fun copyTreeToUpload(uri: Uri): String? = try {
        val docFile = androidx.documentfile.provider.DocumentFile.fromTreeUri(activity, uri)
            ?: return null
        val name = docFile.name ?: "folder"
        // A picked FOLDER becomes a project workspace: it must live under the
        // dir ProotRunner binds at /workspace (filesDir/workspaces/workspace),
        // and the returned path must be the GUEST path — a host-absolute
        // /data/user/0/... path does not exist inside the chrooted host.
        val destRoot = File(activity.filesDir, "workspaces/workspace").apply { mkdirs() }
        val dest = File(destRoot, name)
        if (dest.exists()) dest.deleteRecursively()
        copyDocTree(docFile, dest)
        "/workspace/$name"
    } catch (e: Exception) {
        Log.e(TAG, "copyTreeToUpload failed", e)
        null
    }

    private fun copyDocTree(doc: androidx.documentfile.provider.DocumentFile, dest: File) {
        dest.mkdirs()
        doc.listFiles().forEach { child ->
            val out = File(dest, child.name ?: return@forEach)
            if (child.isDirectory) copyDocTree(child, out)
            else activity.contentResolver.openInputStream(child.uri)?.use { input ->
                out.outputStream().use { input.copyTo(it) }
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
        // for pickFolder/pickFiles/openExternal/getVersion. This exposes that
        // object backed by the message channel.
        val escapedWs = wsUrl.replace("\\", "\\\\").replace("'", "\\'")
        return """
        (function () {
          const send = (method, payload) =>
            new Promise((resolve) => {
              const id = Math.floor(Math.random() * 1e9);
              const handler = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.id === id) {
                  window.removeEventListener('message', handler);
                  resolve(msg);
                }
              };
              window.addEventListener('message', handler);
              androidNative.postMessage(JSON.stringify(Object.assign({ id, method }, payload || {})));
            });
          window.__ANYBUFF_WS_URL__ = '$escapedWs';
          window.__ANYBUFF_APP_VERSION__ = '$appVersion';
          window.__ANYBUFF_NATIVE__ = {
            pickFolder: () => send('pickFolder').then(r => r.path || null),
            pickFiles: () => send('pickFiles').then(r => r.paths || []),
            openExternal: (url) => { androidNative.postMessage(JSON.stringify({ method: 'openExternal', url })); },
            getVersion: () => send('getVersion').then(r => r.version),
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
