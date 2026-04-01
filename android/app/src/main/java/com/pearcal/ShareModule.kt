package com.pearcal

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import java.io.File

@ReactModule(name = ShareModule.NAME)
class ShareModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PearCalShare"
    }

    override fun getName() = NAME

    @ReactMethod
    fun share(title: String, text: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val chooser = Intent.createChooser(intent, title)
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SHARE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun shareCalendar(content: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val file = File(ctx.cacheDir, "pearcal-export.ics")
            file.writeText(content, Charsets.UTF_8)
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/calendar"
                putExtra(Intent.EXTRA_SUBJECT, "PearCal Export")
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(intent, "Export Calendar")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SHARE_ERROR", e.message)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
