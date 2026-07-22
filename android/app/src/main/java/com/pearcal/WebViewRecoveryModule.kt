package com.pearcal

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// GrapheneOS/Vanadium WebView resume-freeze recovery (see WEBVIEW_FREEZE_FIX_PORT.md).
// The cached-app freezer freezes the out-of-process Vanadium renderer while
// backgrounded; on resume its compositor never re-attaches to the new window
// surface, so it never repaints. Only a FRESH render process recovers it.
// WebViewRenderProcess.terminate() (API 29+, minSdk 29) terminates just this
// app's renderer; the JS onRenderProcessGone handler then reloads a fresh one
// bound to the current surface. A view-remount does NOT work (reuses the pooled
// stale renderer).
class WebViewRecoveryModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "WebViewRecovery"

    @ReactMethod
    fun terminateRenderer(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) { promise.resolve(0); return }
        activity.runOnUiThread {
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { promise.resolve(0); return@runOnUiThread }
                val root = activity.window?.decorView
                var terminated = 0
                for (wv in findWebViews(root)) {
                    if (wv.webViewRenderProcess?.terminate() == true) terminated++
                }
                promise.resolve(terminated)
            } catch (e: Throwable) { promise.reject("terminate_failed", e) }
        }
    }

    private fun findWebViews(view: View?): List<WebView> {
        if (view == null) return emptyList()
        val out = ArrayList<WebView>()
        val stack = ArrayDeque<View>()
        stack.addLast(view)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v is WebView) out.add(v)
            if (v is ViewGroup) for (i in 0 until v.childCount) stack.addLast(v.getChildAt(i))
        }
        return out
    }
}
