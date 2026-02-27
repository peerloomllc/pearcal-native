package com.pearcal

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    val uri = intent?.data
    if (uri != null && uri.scheme == "pear" && uri.host == "pearcal") {
      Log.d("PearCal", "Storing link: $uri")
      LinkModule.pendingLink = uri.toString()
      intent = Intent(this, MainActivity::class.java)
    }
    super.onCreate(null)
    // Start foreground service to keep Bare worklet alive
    val serviceIntent = Intent(this, BareService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(serviceIntent)
    } else {
      startService(serviceIntent)
    }
  }

  override fun onNewIntent(intent: Intent) {
    val uri = intent.data
    if (uri != null && uri.scheme == "pear" && uri.host == "pearcal") {
      Log.d("PearCal", "onNewIntent storing link: $uri")
      LinkModule.pendingLink = uri.toString()
      setIntent(Intent(this, MainActivity::class.java))
      super.onNewIntent(Intent(this, MainActivity::class.java))
    } else {
      super.onNewIntent(intent)
    }
  }

  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
      this,
      BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {}
    )
  }

  override fun invokeDefaultOnBackPressed() {
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
      if (!moveTaskToBack(false)) super.invokeDefaultOnBackPressed()
      return
    }
    super.invokeDefaultOnBackPressed()
  }
}
