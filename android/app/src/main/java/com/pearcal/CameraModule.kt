package com.pearcal

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import java.io.ByteArrayOutputStream
import java.io.File
import android.util.Base64

@ReactModule(name = CameraModule.NAME)
class CameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        const val NAME = "PearCalCamera"
        const val CAMERA_REQUEST = 49375
    }

    private var cameraPromise: Promise? = null
    private var photoUri: Uri? = null

    init { reactContext.addActivityEventListener(this) }

    override fun getName() = NAME

    @ReactMethod
    fun capture(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "No activity"); return }
        cameraPromise = promise

        try {
            val photoDir = File(reactApplicationContext.cacheDir, "camera_photos")
            photoDir.mkdirs()
            val photoFile = File.createTempFile("photo_", ".jpg", photoDir)
            photoUri = FileProvider.getUriForFile(
                reactApplicationContext,
                "${reactApplicationContext.packageName}.fileprovider",
                photoFile
            )
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
            }
            activity.startActivityForResult(intent, CAMERA_REQUEST)
        } catch (e: Exception) {
            cameraPromise = null
            promise.reject("CAMERA_ERROR", e.message ?: "Failed to open camera")
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != CAMERA_REQUEST) return
        val p = cameraPromise ?: return
        cameraPromise = null
        if (resultCode == Activity.RESULT_OK) {
            try {
                val uri = photoUri ?: throw Exception("No photo URI")
                val stream = reactApplicationContext.contentResolver.openInputStream(uri)
                val bitmap = BitmapFactory.decodeStream(stream)
                stream?.close()
                // Scale down to max 512px
                val maxDim = 512
                val scale = minOf(maxDim.toFloat() / bitmap.width, maxDim.toFloat() / bitmap.height, 1f)
                val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true)
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
                val base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                p.resolve("data:image/jpeg;base64,$base64")
            } catch (e: Exception) {
                p.reject("PROCESS_ERROR", e.message ?: "Failed to process photo")
            }
        } else {
            p.reject("CANCELLED", "Camera cancelled")
        }
    }

    override fun onNewIntent(intent: Intent) {}
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
