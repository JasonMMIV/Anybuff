package com.anybuff.android.crypto

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore-backed secret vault (plan §4 M-B2, ADR-11 Android arm).
 *
 * - AES/GCM/NoPadding 256-bit keys held in the AndroidKeyStore (TEE/StrongBox
 *   when the device provides it). The key material never leaves the Keystore.
 * - Each secret is stored as base64(IV || ciphertext). IV is random per write.
 * - Decrypt only ever returns into the caller's memory; nothing is persisted
 *   in plaintext. The app stores only the ciphertext records.
 *
 * Owns the durable provider-key store (filesDir/provider-keys.json, values
 * Keystore-encrypted) — moved here from NativeBridge in round 10 so the
 * app-process singletons (SandboxManager) can read the FRESH key set at
 * every host spawn without capturing an Activity.
 *
 * This is the Android analogue of Electron safeStorage/DPAPI on desktop.
 */
class KeyVault(context: Context) {

    private val appContext = context.applicationContext

    companion object {
        private const val TAG = "AnyBuffKeyVault"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "anybuff-vault"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128

        // Class-level lock: two vault instances exist by design (the
        // Activity's, injected into NativeBridge for WebView-thread saves,
        // and SandboxManager's own for engine-spawn reads), so a
        // per-instance @Synchronized monitor would not serialize
        // cross-instance file access (round-10 review).
        private val fileLock = Any()
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun isAvailable(): Boolean = try {
        getOrCreateKey()
        true
    } catch (e: Exception) {
        false
    }

    /** Encrypt [plain] → base64(iv || ciphertext). */
    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        val out = ByteArray(iv.size + ct.size)
        System.arraycopy(iv, 0, out, 0, iv.size)
        System.arraycopy(ct, 0, out, iv.size, ct.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** Decrypt base64(iv || ciphertext) → plaintext. Returns null on failure. */
    fun decrypt(encoded: String): String? = try {
        val raw = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = raw.copyOfRange(0, 12)
        val ct = raw.copyOfRange(12, raw.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    /* ── Durable provider key store (filesDir/provider-keys.json) ── */

    private fun keysFile(): File = File(appContext.filesDir, "provider-keys.json")

    private fun loadKeyMap(): MutableMap<String, String> = try {
        val raw = keysFile().readText()
        val obj = JSONObject(raw)
        val map = mutableMapOf<String, String>()
        obj.keys().forEach { k -> map[k] = obj.getString(k) }
        map
    } catch (e: Exception) {
        mutableMapOf()
    }

    private fun saveKeyMap(map: Map<String, String>) {
        val obj = JSONObject()
        map.forEach { (k, v) -> obj.put(k, v) }
        // Atomic write: a kill mid-write must not corrupt the whole key store
        // (same pattern as host-core files/atomic-write).
        val file = keysFile()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(obj.toString())
        if (!tmp.renameTo(file)) {
            tmp.delete()
            file.writeText(obj.toString())
        }
    }

    // All key-map file operations below run under the class-level fileLock:
    // callers span two vault instances and threads (WebView bridge saveKey
    // vs engine-spawn allPlaintextKeys), and the load→modify→write cycles
    // plus the shared `.tmp` path must never interleave. The nested delete
    // call is safe — intrinsic locks are reentrant.

    /** Persist a key (empty value deletes). False = the write failed. */
    fun saveProviderKey(providerId: String, apiKey: String): Boolean = synchronized(fileLock) {
        try {
            if (apiKey.isEmpty()) {
                deleteProviderKey(providerId)
            } else {
                val map = loadKeyMap()
                map[providerId] = encrypt(apiKey)
                saveKeyMap(map)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "saveProviderKey failed", e)
            false
        }
    }

    fun deleteProviderKey(providerId: String): Boolean = synchronized(fileLock) {
        try {
            val map = loadKeyMap()
            map.remove(providerId)
            saveKeyMap(map)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * JSON map of ALL decrypted keys ({ id: plaintext }) for the one-shot
     * host handshake (ANYBUFF_HOST_SECRETS). Called at every host spawn so
     * the engine always boots with the CURRENT key set — including keys
     * saved after the previous boot (SandboxManager, round 10).
     */
    fun allPlaintextKeys(): String = synchronized(fileLock) {
        val obj = JSONObject()
        loadKeyMap().forEach { (id, enc) ->
            decrypt(enc)?.let { obj.put(id, it) }
        }
        obj.toString()
    }
}
