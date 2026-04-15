package com.pearcal

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.ByteArrayOutputStream
import java.io.File
import android.util.Base64
import android.util.Log
import androidx.exifinterface.media.ExifInterface

@ReactModule(name = CameraModule.NAME)
class CameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        const val NAME = "PearCalCamera"
        const val CAMERA_REQUEST = 49375
        const val CAMERA_PERMISSION_REQUEST = 49376
        const val TAG = "PearCalCamera"
    }

    private var cameraPromise: Promise? = null
    private var photoUri: Uri? = null

    init { reactContext.addActivityEventListener(this) }

    override fun getName() = NAME

    @ReactMethod
    fun capture(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "No activity"); return }

        if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "Requesting CAMERA permission")
            cameraPromise = promise
            val permissionActivity = activity as? PermissionAwareActivity
            if (permissionActivity == null) {
                promise.reject("NO_PERMISSION_ACTIVITY", "Activity does not support permissions")
                return
            }
            permissionActivity.requestPermissions(
                arrayOf(Manifest.permission.CAMERA),
                CAMERA_PERMISSION_REQUEST,
                PermissionListener { requestCode, _, grantResults ->
                    if (requestCode != CAMERA_PERMISSION_REQUEST) return@PermissionListener false
                    val p = cameraPromise ?: return@PermissionListener true
                    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                        Log.d(TAG, "CAMERA permission granted")
                        cameraPromise = null
                        val act = reactApplicationContext.currentActivity
                        if (act != null) launchCamera(act, p)
                        else p.reject("NO_ACTIVITY", "No activity after grant")
                    } else {
                        Log.d(TAG, "CAMERA permission denied")
                        cameraPromise = null
                        p.reject("PERMISSION_DENIED", "Camera permission denied")
                    }
                    true
                }
            )
            return
        }

        launchCamera(activity, promise)
    }

    private fun launchCamera(activity: Activity, promise: Promise) {
        cameraPromise = promise
        try {
            val photoDir = File(reactApplicationContext.cacheDir, "camera_photos").also { it.mkdirs() }
            val photoFile = File.createTempFile("photo_", ".jpg", photoDir)
            Log.d(TAG, "Photo file: ${photoFile.absolutePath}")

            photoUri = FileProvider.getUriForFile(
                reactApplicationContext,
                "${reactApplicationContext.packageName}.fileprovider",
                photoFile
            )
            Log.d(TAG, "Photo URI: $photoUri")

            val cameraIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "image/*"
                addCategory(Intent.CATEGORY_OPENABLE)
            }
            val chooser = Intent.createChooser(galleryIntent, "Select photo").apply {
                putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
            }
            activity.startActivityForResult(chooser, CAMERA_REQUEST)
        } catch (e: Exception) {
            Log.e(TAG, "Camera launch failed: ${e.message}", e)
            cameraPromise = null
            promise.reject("CAMERA_ERROR", e.message ?: "Failed to open camera")
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != CAMERA_REQUEST) return
        val p = cameraPromise ?: return
        cameraPromise = null
        Log.d(TAG, "onActivityResult resultCode=$resultCode")
        if (resultCode == Activity.RESULT_OK) {
            try {
                val uri = data?.data ?: photoUri ?: throw Exception("No photo URI")
                // Pass animated formats through unmodified so frames aren't lost.
                val mime = if (data?.data != null) reactApplicationContext.contentResolver.getType(uri) else null
                if (mime == "image/gif" || mime == "image/webp") {
                    val raw = reactApplicationContext.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw Exception("Failed to read image bytes")
                    val base64 = Base64.encodeToString(raw, Base64.NO_WRAP)
                    Log.d(TAG, "Passthrough $mime length=${base64.length}")
                    p.resolve("data:$mime;base64,$base64")
                    return
                }
                val stream = reactApplicationContext.contentResolver.openInputStream(uri)
                var bitmap = BitmapFactory.decodeStream(stream)
                stream?.close()
                // Fix EXIF rotation
                val exifStream = reactApplicationContext.contentResolver.openInputStream(uri)
                if (exifStream != null) {
                    val exif = ExifInterface(exifStream)
                    exifStream.close()
                    val rotation = when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                        else -> 0f
                    }
                    if (rotation != 0f) {
                        val matrix = android.graphics.Matrix()
                        matrix.postRotate(rotation)
                        bitmap = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                    }
                }
                val maxDim = 512
                val scale = minOf(maxDim.toFloat() / bitmap.width, maxDim.toFloat() / bitmap.height, 1f)
                val scaled = Bitmap.createScaledBitmap(
                    bitmap,
                    (bitmap.width * scale).toInt(),
                    (bitmap.height * scale).toInt(),
                    true
                )
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
                val base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                Log.d(TAG, "Resolving base64 length=${base64.length}")
                p.resolve("data:image/jpeg;base64,$base64")
            } catch (e: Exception) {
                Log.e(TAG, "Photo process failed: ${e.message}", e)
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
