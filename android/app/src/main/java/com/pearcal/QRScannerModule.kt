package com.pearcal

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = QRScannerModule.NAME)
class QRScannerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        const val NAME = "PearCalQRScanner"
        const val SCAN_REQUEST = 49374
    }

    private var scanPromise: Promise? = null

    init { reactContext.addActivityEventListener(this) }

    override fun getName() = NAME

    @ReactMethod
    fun scan(promise: Promise) {
        val activity = currentActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "No activity"); return }
        scanPromise = promise
        val intent = Intent("com.google.zxing.client.android.SCAN").apply {
            putExtra("SCAN_MODE", "QR_CODE_MODE")
        }
        try {
            activity.startActivityForResult(intent, SCAN_REQUEST)
        } catch (e: Exception) {
            scanPromise = null
            promise.reject("NO_SCANNER", "No QR scanner app installed")
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != SCAN_REQUEST) return
        val p = scanPromise ?: return
        scanPromise = null
        if (resultCode == Activity.RESULT_OK) {
            p.resolve(data?.getStringExtra("SCAN_RESULT") ?: "")
        } else {
            p.reject("CANCELLED", "Scan cancelled")
        }
    }

    override fun onNewIntent(intent: Intent) {}

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
