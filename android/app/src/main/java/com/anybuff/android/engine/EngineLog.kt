package com.anybuff.android.engine

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * EngineLog — on-device engine diagnostics ring buffer (no adb required).
 *
 * The host process's stdout/stderr, boot stages, unexpected process exits and
 * renderer WS lifecycle events are appended to a single file under
 * filesDir/engine/logs/host.log. The WebView reads the tail via the native
 * bridge (readEngineLog) so the user can see WHY the engine dies directly in
 * the app — no adb needed (some testers cannot / will not install over ADB).
 *
 * Rotation: when the file grows past [MAX_BYTES] the newest [KEEP_BYTES] are
 * moved to host.log.1 and the main file is truncated. All appends are
 * synchronized (drainer thread, monitor thread and the bridge thread all
 * write) and never throw — logging must never take the engine down.
 */
object EngineLog {

    private const val MAX_BYTES = 512_000L
    private const val KEEP_BYTES = 128_000
    private const val MAX_LINE = 400

    private val lock = Any()
    private val ts = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    fun file(context: Context): File =
        File(File(context.filesDir, "engine"), "logs/host.log")

    fun append(context: Context, line: String) {
        try {
            synchronized(lock) {
                val f = file(context)
                f.parentFile?.mkdirs()
                if (f.length() > MAX_BYTES) rotate(f)
                f.appendText("${ts.format(Date())} ${line.take(MAX_LINE)}\n")
            }
        } catch (_: Exception) {
            // Logging must never break the engine.
        }
    }

    /** Keep the newest KEEP_BYTES as host.log.1, truncate the live file. */
    private fun rotate(f: File) {
        try {
            val bytes = f.readBytes()
            if (bytes.size > KEEP_BYTES) {
                File(f.parentFile, "host.log.1")
                    .writeBytes(bytes.copyOfRange(bytes.size - KEEP_BYTES, bytes.size))
            }
            f.writeText("")
        } catch (_: Exception) {
        }
    }

    /** Newest [maxBytes] of the log (plus the rotation's tail) for display. */
    fun readTail(context: Context, maxBytes: Int = 96_000): String {
        return try {
            synchronized(lock) {
                val f = file(context)
                val main = if (f.exists()) {
                    val bytes = f.readBytes()
                    if (bytes.size <= maxBytes) bytes.toString(Charsets.UTF_8)
                    else bytes.copyOfRange(bytes.size - maxBytes, bytes.size).toString(Charsets.UTF_8)
                } else ""
                val older = File(f.parentFile, "host.log.1")
                if (older.exists()) {
                    val ob = older.readBytes()
                    val head = if (ob.size > 24_000) ob.copyOfRange(ob.size - 24_000, ob.size).toString(Charsets.UTF_8) else ob.toString(Charsets.UTF_8)
                    head + main
                } else main
            }
        } catch (e: Exception) {
            "(failed to read engine log: ${e.message})"
        }
    }

    fun clear(context: Context) {
        try {
            synchronized(lock) {
                file(context).delete()
                File(file(context).parentFile, "host.log.1").delete()
            }
        } catch (_: Exception) {
        }
    }
}
