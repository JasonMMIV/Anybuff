package com.anybuff.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

/** AnyBuff Android application. Creates the engine notification channel. */
class AnyBuffApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ENGINE,
                getString(R.string.engine_notification_channel),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "AnyBuff engine run progress"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    companion object {
        const val CHANNEL_ENGINE = "engine"
    }
}
