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

    /** Boot the engine if it is not already running (M-B1 fills this in). */
    private fun ensureEngineRunning() {
        // TODO(M-B1): SandboxManager.ensureStarted { wsUrl, token ->
        //   publish ws url + token to the WebView via the bridge, then
        //   MainActivity navigates the renderer at it.
        // }
    }

    private fun stopEngine() {
        // TODO(M-B1): SandboxManager.stop() — kill the proot process tree.
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
            .setSmallIcon(android.R.drawable.stat_notify_sync)
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
