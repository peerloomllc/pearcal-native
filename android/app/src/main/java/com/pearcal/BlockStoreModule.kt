package com.pearcal

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

@ReactModule(name = BlockStoreModule.NAME)
class BlockStoreModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PearCalBlockStore"
        private const val KEY = "pearcal.identity.mnemonic"
    }

    override fun getName() = NAME

    private fun playServicesAvailable(): Boolean {
        return try {
            val status = GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(reactApplicationContext)
            status == ConnectionResult.SUCCESS
        } catch (t: Throwable) {
            false
        }
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(playServicesAvailable())
    }

    @ReactMethod
    fun saveMnemonic(value: String, promise: Promise) {
        if (!playServicesAvailable()) {
            promise.resolve(false)
            return
        }
        try {
            val client = Blockstore.getClient(reactApplicationContext)
            val req = StoreBytesData.Builder()
                .setBytes(value.toByteArray(Charsets.UTF_8))
                .setKey(KEY)
                .setShouldBackupToCloud(true)
                .build()
            client.storeBytes(req)
                .addOnSuccessListener { promise.resolve(true) }
                .addOnFailureListener { e -> promise.reject("block_store_save_failed", e.message, e) }
        } catch (t: Throwable) {
            promise.reject("block_store_save_threw", t.message, t)
        }
    }

    @ReactMethod
    fun readMnemonic(promise: Promise) {
        if (!playServicesAvailable()) {
            promise.resolve(null)
            return
        }
        try {
            val client = Blockstore.getClient(reactApplicationContext)
            val req = RetrieveBytesRequest.Builder()
                .setKeys(listOf(KEY))
                .build()
            client.retrieveBytes(req)
                .addOnSuccessListener { result ->
                    val entry = result.blockstoreDataMap[KEY]
                    val bytes = entry?.bytes
                    if (bytes == null || bytes.isEmpty()) promise.resolve(null)
                    else promise.resolve(String(bytes, Charsets.UTF_8))
                }
                .addOnFailureListener { e -> promise.reject("block_store_read_failed", e.message, e) }
        } catch (t: Throwable) {
            promise.reject("block_store_read_threw", t.message, t)
        }
    }

    @ReactMethod
    fun deleteMnemonic(promise: Promise) {
        if (!playServicesAvailable()) {
            promise.resolve(false)
            return
        }
        try {
            val client = Blockstore.getClient(reactApplicationContext)
            val req = DeleteBytesRequest.Builder()
                .setKeys(listOf(KEY))
                .build()
            client.deleteBytes(req)
                .addOnSuccessListener { promise.resolve(true) }
                .addOnFailureListener { e -> promise.reject("block_store_delete_failed", e.message, e) }
        } catch (t: Throwable) {
            promise.reject("block_store_delete_threw", t.message, t)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
