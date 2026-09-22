package com.anybuff.android.bridge

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import com.anybuff.android.engine.EngineLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * DirectAccess — plan §4.6 AFA (All-Files-Access) direct bind, trial phase.
 *
 * The trial verdict (plan §1.4): direct bind over MANAGE_EXTERNAL_STORAGE is
 * the ONLY route that can reach removable volumes (SD/OTG) with raw R/W, and
 * it removes the full workspace copy for every direct-bindable project. This
 * module carries the three shell-side pieces of that plan item:
 *
 *  1. Permission gate — [isAfaGranted] / [afaSettingsIntent] (the renderer's
 *     Storage tab sends the user to the system screen when it is off; the
 *     copy flow remains the fallback with feature parity, R11).
 *  2. Tree URI → raw path derivation + write/delete probe — [rawPathOf] /
 *     [probeWritable]. A pick only becomes a direct bind when the raw path
 *     maps AND accepts a probe file; anything else (cloud providers, restricted
 *     volumes) falls through to the legacy copy flow.
 *  3. The direct-bind registry — [record]/[all]/[remove] plus the pause
 *     preference ([isPaused]/[setPaused]/[clear]). State persists in
 *     filesDir/direct-binds.json (single-write atomic replace, ADR-13 shape)
 *     and ProotRunner adds one `-b raw:/workspace/<name>` per entry at host
 *     spawn. `uri` is kept for the future Route A write-back engine
 *     (persisted grants); a vanished grant degrades nothing — the bind uses
 *     the raw path directly.
 *
 * Purely additive: every failure path returns the legacy copy flow, never an
 * error surface (the renderer keeps working exactly as before).
 */
object DirectAccess {

    private const val FILE_NAME = "direct-binds.json"

    /** A direct-bind entry: guest name ↔ host raw path. */
    data class DirectBind(val name: String, val rawPath: String, val uri: String)

    /** Registry file shape: the pause preference + the bind entries. */
    data class Registry(val paused: Boolean, val binds: List<DirectBind>)

    // ── Permission gate ─────────────────────────────────────────────

    /** true when the user granted All-Files-Access (side-load phase only). */
    fun isAfaGranted(): Boolean =
        Environment.isExternalStorageManager()

    /**
     * The system screen where All-Files-Access is toggled for this app. Sent
     * from the renderer's Storage tab ("Grant All-Files-Access" button); the
     * activity re-reports the gate state in onResume via a DOM event.
     */
    fun afaSettingsIntent(): android.content.Intent =
        android.content.Intent(
            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:com.anybuff.android"),
        )

    // ── Tree URI → raw path (plan §4.6 item 2) ──────────────────────

    /**
     * Map a DocumentsContract tree URI onto a raw filesystem path:
     *   primary:      → /storage/emulated/0
     *   XXXX-XXXX:    → /storage/<uuid>            (SD/OTG — the whole point)
     *   home:, downloads:, images/…: → null (non-hardware roots are NOT
     *   direct-bind targets; the copy flow already covers them).
     *
     * Derived from the tree's document id (docId prefix), NOT from the tree
     * uri path itself (that is a provider-internal "tree/<authority>/<docId>"
     * wrapper whose third segment is the docId). Returns null whenever the
     * mapping cannot be made confidently — the caller then copies as before.
     */
    fun rawPathOf(treeUri: Uri): String? {
        val docId = try {
            DocumentsContract.getTreeDocumentId(treeUri)
        } catch (_: Exception) {
            null
        } ?: return null
        // The doc id is "<root>:<relative path>" with an empty relative for
        // the root itself ("primary:", "1A2B-3C4D:foo/bar").
        val colon = docId.indexOf(':')
        if (colon <= 0) return null
        val root = docId.substring(0, colon)
        val rel = docId.substring(colon + 1)
        // Strip the top-level storage root's own directory (Android/data,
        // Android/obb are special-cased by MediaProvider and useless here).
        if (rel.startsWith("Android/") || rel == "Android") return null
        val base = when {
            root == "primary" -> "/storage/emulated/0"
            // Removable volume ids are the hex UUID form ("1A2B-3C4D").
            root.length == 9 && root[4] == '-' -> "/storage/$root"
            // "emulated:..." aliases /storage/emulated/0 on AOSP vold.
            root == "emulated" -> "/storage/emulated/0"
            else -> return null
        }
        if (rel.isEmpty()) return base
        // Sanitize: reject traversal-ish segments outright (defensive —
        // DocumentsProvider ids never contain these, but never trust).
        if (rel.contains("..") || rel.contains('\u0000')) return null
        return "$base/$rel"
    }

    /** true when [rawPath] IS a storage volume root (no project segment). */
    fun isVolumeRoot(rawPath: String): Boolean {
        if (rawPath == "/storage/emulated/0") return true
        if (!rawPath.startsWith("/storage/")) return false
        val parent = File(rawPath).parentFile?.path ?: return false
        return parent == "/storage"
    }

    /**
     * Write/delete probe (plan §4.6: "以寫刪測試檔 probe 可寫性"). true only
     * when a probe file can be created AND deleted inside [dir]; the reason
     * string is for the EngineLog breadcrumb ("probe result and reason").
     */
    fun probeWritable(dir: File): Pair<Boolean, String> {
        if (!dir.isDirectory && !dir.mkdirs()) {
            return false to "root directory does not exist and cannot be created"
        }
        val probe = File(dir, ".anybuff-probe-${System.currentTimeMillis()}.tmp")
        return try {
            try {
                probe.writeText("anybuff probe")
            } catch (e: Exception) {
                return false to "probe write failed: ${e.message}"
            }
            if (!probe.delete()) {
                probe.deleteOnExit()
                return false to "probe delete failed (read-only mount?)"
            }
            true to "writable"
        } catch (e: Exception) {
            false to "probe error: ${e.message}"
        }
    }

    // ── Direct-bind registry ────────────────────────────────────────

    /** All recorded direct binds, newest last. Empty on any parse failure. */
    fun all(context: Context): List<DirectBind> = loadRegistry(context).binds

    /** The bind for a guest folder name, or null. */
    fun forName(context: Context, name: String): DirectBind? =
        loadRegistry(context).binds.firstOrNull { it.name == name }

    // ── Pause preference (§4.6: the in-app off switch) ──────────────

    /**
     * true when in-place access is PAUSED. The platform forbids an app from
     * revoking its own MANAGE_EXTERNAL_STORAGE, so this app-level preference
     * (persisted next to the registry) is the user-reachable off switch:
     * picks run the copy flow and a (re)spawned host mounts nothing, while
     * the registry is KEPT so resuming restores every project in place.
     */
    fun isPaused(context: Context): Boolean = loadRegistry(context).paused

    /**
     * Set the pause preference (see [isPaused]).
     *
     * @return true when the value actually changed — callers use this to
     *   skip pointless host restarts (an unchanged preference remounts
     *   nothing).
     */
    fun setPaused(context: Context, paused: Boolean): Boolean {
        val reg = loadRegistry(context)
        if (reg.paused == paused) return false
        save(context, paused, reg.binds)
        EngineLog.append(
            context,
            if (paused) "direct: paused (${reg.binds.size} bind(s) kept for resume)"
            else "direct: resumed (${reg.binds.size} bind(s) re-enabled)",
        )
        return true
    }

    /** Remove EVERY entry (the pause flag is kept). @return removed count. */
    fun clear(context: Context): Int {
        val reg = loadRegistry(context)
        if (reg.binds.isEmpty()) return 0
        save(context, reg.paused, emptyList())
        EngineLog.append(context, "direct: cleared ${reg.binds.size} bind(s)")
        return reg.binds.size
    }

    /**
     * Record (or replace) the bind for [name] and persist atomically. The
     * directory itself is validated by the caller (probe + sanitization);
     * this only manages the registry file.
     *
     * @return true when the MOUNT changed (a new name, or an existing name
     *   re-pointed at a different rawPath) — proot mounts are baked in at
     *   host spawn, so the caller (§4.6 D1 activation) uses this to decide
     *   whether a running host must restart to pick the bind up. Same-name
     *   picks of the same rawPath return false: the mount is already live
     *   and a restart would be pointless churn.
     */
    fun record(context: Context, name: String, rawPath: String, uri: String): Boolean {
        val reg = loadRegistry(context)
        val binds = reg.binds
        val existing = binds.firstOrNull { it.name == name }
        // Identical re-pick: nothing to persist, nothing to remount — leave
        // a breadcrumb (re-picks of the same project are common; silence
        // would read as "the pick was dropped").
        if (existing?.rawPath == rawPath && existing.uri == uri) {
            EngineLog.append(context, "direct: re-picked '$name' → $rawPath (unchanged; no remount)")
            return false
        }
        val next = binds.filter { it.name != name } + DirectBind(name, rawPath, uri)
        save(context, reg.paused, next)
        val remount = existing == null || existing.rawPath != rawPath
        EngineLog.append(
            context,
            if (remount) "direct: bound '$name' → $rawPath (${next.size} total)"
            else "direct: refreshed '$name' → $rawPath (uri only; mount unchanged)",
        )
        return remount
    }

    /**
     * Drop the bind for [name] (project deleted, or re-picked into the copy
     * flow).
     *
     * @return true when an entry was actually removed (§4.6 D3): a live host
     *   keeps serving the old mount until a restart, so the caller uses this
     *   to trigger the same activation as a fresh bind.
     */
    fun remove(context: Context, name: String): Boolean {
        val reg = loadRegistry(context)
        val next = reg.binds.filter { it.name != name }
        if (next.size == reg.binds.size) return false
        save(context, reg.paused, next)
        EngineLog.append(context, "direct: unbound '$name' (${next.size} total)")
        return true
    }

    /* The registry is tiny (a handful of projects); read-parse-write per
     * operation keeps it trivially consistent across processes — mirroring
     * KeyVault's class-level lock discipline is unnecessary here because only
     * the UI process writes it (the host reads binds via ProotRunner, which
     * runs in-process with the same singleton). */

    private fun file(context: Context): File = File(context.filesDir, FILE_NAME)

    private fun loadRegistry(context: Context): Registry {
        val f = file(context)
        if (!f.exists()) return Registry(false, emptyList())
        return try {
            val o = JSONObject(f.readText())
            val arr = o.optJSONArray("binds") ?: JSONArray()
            val binds = (0 until arr.length()).mapNotNull { i ->
                val b = arr.optJSONObject(i) ?: return@mapNotNull null
                val name = b.optString("name")
                val rawPath = b.optString("rawPath")
                if (name.isEmpty() || rawPath.isEmpty()) null
                else DirectBind(name, rawPath, b.optString("uri"))
            }
            // A missing `paused` key (files written before the preference
            // existed) reads as false — fully backward compatible.
            Registry(o.optBoolean("paused", false), binds)
        } catch (_: Exception) {
            // A corrupt registry degrades to "no direct binds" (copy flow) —
            // same self-healing read policy as probe-samples (ADR-27 MC-2.2).
            Registry(false, emptyList())
        }
    }

    private fun save(context: Context, paused: Boolean, binds: List<DirectBind>) {
        val f = file(context)
        val arr = JSONArray()
        binds.forEach { b ->
            arr.put(
                JSONObject()
                    .put("name", b.name)
                    .put("rawPath", b.rawPath)
                    .put("uri", b.uri)
            )
        }
        // `paused` is written on EVERY save: record/remove thread it through
        // so registry edits can never wipe the preference.
        val payload = JSONObject().put("paused", paused).put("binds", arr).toString()
        // Atomic replace: write the sibling temp file first, then rename over
        // the target (ADR-13 — never truncate the live file in place).
        val tmp = File(f.parentFile, "$FILE_NAME.${android.os.Process.myPid()}.${System.currentTimeMillis()}.tmp")
        try {
            tmp.writeText(payload)
            if (!tmp.renameTo(f)) {
                // Cross-device rename cannot happen within filesDir — a hard
                // failure here is a platform bug; keep the old file.
                tmp.delete()
                EngineLog.append(context, "direct: FAILED to persist direct-binds.json (rename)")
            }
        } catch (e: Exception) {
            tmp.delete()
            EngineLog.append(context, "direct: FAILED to persist direct-binds.json: ${e.message}")
        }
    }
}
