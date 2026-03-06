package com.pearcal

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = DeepLinkModule.NAME)
class DeepLinkModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object { const val NAME = "PearCalDeepLink" }
    override fun getName() = NAME

    @ReactMethod
    fun openURL(url: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPEN_URL_ERROR", e.message)
        }
    }

    @ReactMethod
    fun canOpenLightning(promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("lightning:test"))
            val pm = reactApplicationContext.packageManager
            val activities = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
            promise.resolve(activities.isNotEmpty())
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openLightning(address: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("lightning:$address")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("LIGHTNING_ERROR", e.message)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
