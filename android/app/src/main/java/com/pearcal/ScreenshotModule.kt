package com.pearcal

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = ScreenshotModule.NAME)
class ScreenshotModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object { const val NAME = "PearCalScreenshot" }
    override fun getName() = NAME

    override fun getConstants(): Map<String, Any> {
        var scene = 0
        var dark = -1
        val intent: Intent? = getCurrentActivity()?.intent
        if (intent != null) {
            scene = intent.getIntExtra("screenshotScene", 0)
            if (intent.hasExtra("screenshotDark")) {
                dark = if (intent.getBooleanExtra("screenshotDark", false)) 1 else 0
            }
        }
        return mapOf("scene" to scene, "dark" to dark)
    }
}
