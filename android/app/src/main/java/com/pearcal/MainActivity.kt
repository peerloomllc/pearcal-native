package com.pearcal

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.pearcal.widget.DailyWidgetWorker
import expo.modules.ReactActivityDelegateWrapper
import org.json.JSONObject

class MainActivity : ReactActivity() {

  private fun isInviteLink(uri: Uri): Boolean {
    // https://peerloomllc.com/join?...
    if (uri.scheme == "https" && uri.host == "peerloomllc.com" && uri.path?.startsWith("/join") == true) return true
    // pear://pearcal/join?... (legacy)
    if (uri.scheme == "pear" && uri.host == "pearcal") return true
    return false
  }

  // #24: a calendar file opened (VIEW) or shared (SEND) into the app. Reads it
  // now, while the sender's read grant is valid, and queues the text for the
  // JS side, which opens the import sheet. Returns false for anything else.
  private val icsTypes = setOf("text/calendar", "application/ics", "text/x-vcalendar")
  private val icsMaxBytes = 5 * 1024 * 1024

  private fun captureIcs(i: Intent?): Boolean {
    if (i == null) return false
    val uri: Uri? = when (i.action) {
      Intent.ACTION_VIEW -> i.data
      Intent.ACTION_SEND ->
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> return false
    }
    val name = uri?.let { displayName(it) }
    val isCalendar = icsTypes.contains(i.type?.lowercase()) ||
      (name ?: uri?.lastPathSegment ?: "").lowercase().let { it.endsWith(".ics") || it.endsWith(".ical") }
    if (!isCalendar) return false
    var text: String? = null
    if (uri != null) {
      try {
        contentResolver.openInputStream(uri)?.use { s ->
          // InputStream.readNBytes needs API 33; minSdk is 29.
          val out = java.io.ByteArrayOutputStream()
          val buf = ByteArray(8192)
          while (out.size() <= icsMaxBytes) {
            val n = s.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
          }
          if (out.size() <= icsMaxBytes) text = out.toString("UTF-8")
          else Log.w("PearCal", "Calendar file over ${icsMaxBytes} bytes, ignored")
        }
      } catch (e: Exception) {
        Log.w("PearCal", "Could not read calendar file: ${e.message}")
      }
    }
    if (text == null && i.action == Intent.ACTION_SEND) text = i.getStringExtra(Intent.EXTRA_TEXT)
    if (text.isNullOrEmpty()) return false
    LinkModule.pendingIcs = JSONObject().put("text", text).put("filename", name ?: "calendar.ics").toString()
    Log.i("PearCal", "Queued calendar file: ${name ?: uri}")
    return true
  }

  private fun displayName(uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    return try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      }
    } catch (e: Exception) { null }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    val uri = intent?.data
    if (uri != null && isInviteLink(uri)) {
      Log.d("PearCal", "Storing link: $uri")
      LinkModule.pendingLink = uri.toString()
      intent = Intent(this, MainActivity::class.java)
    } else if (captureIcs(intent)) {
      intent = Intent(this, MainActivity::class.java)
    }
    val tab = intent?.getStringExtra("pearTab")
    if (!tab.isNullOrEmpty()) {
      LinkModule.pendingTab = tab
    }
    val gsid = intent?.getStringExtra("pearGroupSettingsId")
    if (!gsid.isNullOrEmpty()) {
      LinkModule.pendingGroupSettingsId = gsid
    }
    super.onCreate(null)
    DailyWidgetWorker.schedule(this)
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
    if (uri != null && isInviteLink(uri)) {
      Log.d("PearCal", "onNewIntent storing link: $uri")
      LinkModule.pendingLink = uri.toString()
      setIntent(Intent(this, MainActivity::class.java))
      super.onNewIntent(Intent(this, MainActivity::class.java))
    } else if (captureIcs(intent)) {
      setIntent(Intent(this, MainActivity::class.java))
      super.onNewIntent(Intent(this, MainActivity::class.java))
    } else {
      val tab = intent.getStringExtra("pearTab")
      if (!tab.isNullOrEmpty()) LinkModule.pendingTab = tab
      val gsid = intent.getStringExtra("pearGroupSettingsId")
      if (!gsid.isNullOrEmpty()) LinkModule.pendingGroupSettingsId = gsid
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
