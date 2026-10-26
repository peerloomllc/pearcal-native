package com.pearcal

import android.net.Uri
import android.provider.DocumentsContract
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// Writes into a folder the user granted through the Storage Access Framework,
// for the automatic .ics export (TODO #187). The folder is picked in the shell
// with expo-file-system, which keeps a persistable grant on the tree URI.
//
// Native rather than expo-file-system's writeAsStringAsync because that opens
// SAF documents in "w" mode, which several document providers do not
// truncate: a calendar file that got shorter would keep the old file's tail.
// "wt" truncates everywhere.
class FilesModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "PearCalFiles"

    private fun findChild(tree: Uri, name: String): Uri? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == name) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
            }
        }
        return null
    }

    // Create or overwrite `name` in the folder. Resolves { ok: true }.
    @ReactMethod
    fun writeToFolder(treeUri: String, name: String, contents: String, promise: Promise) {
        Thread {
            try {
                val tree = Uri.parse(treeUri)
                val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                val doc = findChild(tree, name)
                    ?: DocumentsContract.createDocument(ctx.contentResolver, parent, "text/calendar", name)
                    ?: throw Exception("could not create $name")
                ctx.contentResolver.openOutputStream(doc, "wt")!!.use { it.write(contents.toByteArray(Charsets.UTF_8)) }
                promise.resolve(Arguments.createMap().apply { putBoolean("ok", true) })
            } catch (e: SecurityException) {
                promise.reject("no_access", "PearCal lost access to the folder, pick it again", e)
            } catch (e: Exception) {
                promise.reject("write_failed", e.message ?: "could not write $name", e)
            }
        }.start()
    }

    // Delete `name` from the folder if it is there. Resolves { ok: true }.
    @ReactMethod
    fun deleteFromFolder(treeUri: String, name: String, promise: Promise) {
        Thread {
            try {
                val tree = Uri.parse(treeUri)
                findChild(tree, name)?.let { DocumentsContract.deleteDocument(ctx.contentResolver, it) }
                promise.resolve(Arguments.createMap().apply { putBoolean("ok", true) })
            } catch (e: Exception) {
                promise.reject("delete_failed", e.message ?: "could not delete $name", e)
            }
        }.start()
    }
}
