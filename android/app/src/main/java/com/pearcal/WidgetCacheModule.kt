package com.pearcal

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.pearcal.widget.DailyWidgetReceiver
import java.io.File

@ReactModule(name = WidgetCacheModule.NAME)
class WidgetCacheModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "WidgetCache"
        const val CACHE_FILE = "today.json"
    }
    override fun getName() = NAME

    private fun cacheFile(): File {
        val dir = File(reactApplicationContext.filesDir, "widget")
        if (!dir.exists()) dir.mkdirs()
        return File(dir, CACHE_FILE)
    }

    @ReactMethod
    fun writeCache(json: String, promise: Promise) {
        try {
            cacheFile().writeText(json)
            val ctx = reactApplicationContext
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, DailyWidgetReceiver::class.java))
            if (ids.isNotEmpty()) DailyWidgetReceiver.updateAll(ctx)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("widget_cache_write", e)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
