package com.pearcal

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions

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
        val activity = reactApplicationContext.currentActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "No activity"); return }
        scanPromise = promise

        val intent = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan a PearCal invite QR code")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .createScanIntent(activity)

        try {
            activity.startActivityForResult(intent, SCAN_REQUEST)
        } catch (e: Exception) {
            scanPromise = null
            promise.reject("NO_SCANNER", e.message ?: "Failed to open scanner")
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != SCAN_REQUEST) return
        val p = scanPromise ?: return
        scanPromise = null
        if (resultCode == Activity.RESULT_OK) {
            val result = ScanIntentResult.parseActivityResult(resultCode, data)
            p.resolve(result.contents ?: "")
        } else {
            p.reject("CANCELLED", "Scan cancelled")
        }
    }

    override fun onNewIntent(intent: Intent) {}

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
