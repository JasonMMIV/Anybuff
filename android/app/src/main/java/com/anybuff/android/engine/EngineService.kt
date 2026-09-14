package com.anybuff.android.engine

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.anybuff.android.AnyBuffApp
import com.anybuff.android.MainActivity
import com.anybuff.android.R

/**
 * EngineService — specialUse foreground service owning the sandbox host
 * process tree (M-B4). The engine keeps running while the app is backgrounded
 * or the screen is off; the notification shows progress and a stop action.
 *
 * specialUse (NOT dataSync) is mandatory: dataSync carries a 6h/day cap on
 * Android 15+ that hard-crashes the app when exceeded (plan §4 M-B4). The
 * Play declaration for specialUse is prepared in the manifest property.
 *
 * The actual sandbox bootstrap (proot rootfs install, host spawn, WS URL
 * publication) lands in M-B1 — this file owns lifecycle + notification only.
 */
class EngineService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopEngine()
                stopSelf()
            }
            ACTION_SHUTDOWN -> {
                // Activity is finishing — tear the sandbox down but keep this
                // process's service stopped too, so no zombie FGS lingers over
                // a dead sandbox.
                stopEngine()
                stopSelf()
            }
            else -> {
                if (intent?.getBooleanExtra(EXTRA_KEEP_SCREEN, false) == true) {
                    // M-B4: activity visible → keep screen on while running.
                }
                ensureEngineRunning()
            }
        }
        return START_STICKY
    }

    /** Boot the engine headless when neither the host nor a boot is live (M-B4).
     *
     * Two reach paths: (a) START_STICKY restart after Android killed the whole
     * process — the service comes back with a null intent (no activity, no
     * primaryListener) and NOTHING else would boot the engine until the user
     * reopened the app; (b) any other onStartCommand delivery while the host
     * is dead (e.g. the notification's open tap after a crash).
     *
     * The gate MUST accept "boot in flight" as well as "host alive": on a
     * normal cold start MainActivity.onCreate runs startEngineService() then
     * bootEngine() — the service's onStartCommand lands on the main thread
     * AFTER the activity's onCreate, so SandboxManager.start is already
     * single-flight. If the gate only checked liveness, the service would
     * queue a second listener and — worse — start() unconditionally assigns
     * primaryListener, hijacking the auto-reboot re-point target from the
     * live activity's listener to this headless one. Then every subsequent
     * background auto-reboot would boot headless while the live page waits
     * forever for a re-point that never comes. Gating on alive-OR-booting
     * keeps primaryListener ownership with the activity on the normal path.
     */
    private fun ensureEngineRunning() {
        val sandbox = SandboxManager.get(this)
        if (sandbox.isHostAliveOrBooting()) return
        EngineLog.append(this, "service: booting sandbox headless (no activity)")
        sandbox.start(
            object : SandboxManager.Listener {
                override fun onStage(stage: String) { /* headless — no progress UI */ }
                override fun onHostReady(wsUrl: String) {
                    // No page to inject into; the next MainActivity's start()
                    // replays this URL (host alive path). Log the port only —
                    // the URL carries the session token.
                    EngineLog.append(
                        this@EngineService,
                        "service: headless host ready ${wsUrl.substringBefore('?')}",
                    )
                }
                override fun onError(error: String) {
                    EngineLog.append(this@EngineService, "service: headless boot FAILED: $error")
                    // The notification must not claim a running engine over a
                    // dead host — stop the service; the next app open re-boots.
                    stopSelf()
                }
            },
        )
    }

    private fun stopEngine() {
        SandboxManager.get(this).stop()
    }

    private fun startAsForeground() {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, buildNotification(), flags)
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, EngineService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, AnyBuffApp.CHANNEL_ENGINE)
            .setContentTitle(getString(R.string.engine_notification_title))
            .setContentText("Agent engine sandbox")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.engine_stop_action),
                stopIntent,
            )
            .build()
    }

    companion object {
        private const val NOTIF_ID = 1001
        private const val ACTION_STOP = "com.anybuff.android.engine.STOP"
        private const val ACTION_SHUTDOWN = "com.anybuff.android.engine.SHUTDOWN"
        private const val EXTRA_KEEP_SCREEN = "keep_screen"

        fun stopIntent(context: android.content.Context): Intent =
            Intent(context, EngineService::class.java).setAction(ACTION_STOP)

        /** Fired by the Activity when it is finishing (see ACTION_SHUTDOWN). */
        fun shutdownIntent(context: android.content.Context): Intent =
            Intent(context, EngineService::class.java).setAction(ACTION_SHUTDOWN)
    }
}
