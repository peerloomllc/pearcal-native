package com.pearcal

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Toast
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

            // On API 29+ save directly to the public Downloads collection so the file
            // appears in the Files app without needing WRITE_EXTERNAL_STORAGE at runtime.
            var savedToDownloads = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, "pearcal-export.ics")
                        put(MediaStore.Downloads.MIME_TYPE, "text/calendar")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val resolver = ctx.contentResolver
                    val dlUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (dlUri != null) {
                        resolver.openOutputStream(dlUri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        resolver.update(dlUri, values, null, null)
                        savedToDownloads = true
                    }
                } catch (_: Exception) {}
            }
            if (savedToDownloads) {
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(ctx, "Saved to Downloads as pearcal-export.ics", Toast.LENGTH_LONG).show()
                }
            }

            // Write to cache for the share intent (needed for FileProvider URI)
            val cacheFile = File(ctx.cacheDir, "pearcal-export.ics")
            cacheFile.writeText(content, Charsets.UTF_8)
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", cacheFile)
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
