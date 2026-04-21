package com.pearcal

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = LinkModule.NAME)
class LinkModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PearCalLink"
        var pendingLink: String? = null
        var pendingTab: String? = null
        var pendingGroupSettingsId: String? = null
    }

    override fun getName() = NAME

    @ReactMethod
    fun getPendingLink(promise: Promise) {
        promise.resolve(pendingLink)
        pendingLink = null  // consume it
    }

    @ReactMethod
    fun getPendingTab(promise: Promise) {
        promise.resolve(pendingTab)
        pendingTab = null
    }

    @ReactMethod
    fun getPendingGroupSettingsId(promise: Promise) {
        promise.resolve(pendingGroupSettingsId)
        pendingGroupSettingsId = null
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
