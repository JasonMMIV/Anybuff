package com.anybuff.android.engine

import android.content.Context
import java.io.File

/** Sandbox on-disk layout (all under Context.filesDir). */
class SandboxPaths(context: Context) {

    private val filesDir = context.filesDir

    /** Engine assets staged out of the APK. */
    val engineDir = File(filesDir, "engine")

    /** Host bundle + native assets expanded to (host bundle, rg, wasm). */
    val installDir = File(engineDir, "install")

    /** Rootfs tarball staged for extraction. */
    val rootfsArchive = File(engineDir, "rootfs.tar.gz")

    /** Node tarball staged for extraction. */
    val nodeArchive = File(engineDir, "node.tar.xz")

    /** Extraction staging, then rename-atomic swap into rootfs/node. */
    val rootfsStaging = File(engineDir, "rootfs.staging")
    val rootfs = File(engineDir, "rootfs")

    val nodeStaging = File(engineDir, "node.staging")
    val node = File(engineDir, "node")

    /** Pre-generated stat/loadavg/version files bound over /proc. */
    val procFakes = File(engineDir, "proc-fakes")

    /** Host data dir (ANYBUFF_HOST_DATA_DIR). */
    val hostData = File(engineDir, "hostdata")

    /** bionic-bypass.js + host launcher script. */
    val scripts = File(engineDir, "scripts")

    val rootfsMarker = File(engineDir, ".rootfs-ready")
    val nodeMarker = File(engineDir, ".node-ready")

    fun ensureDirs() {
        listOf(
            installDir, rootfsStaging, rootfs, nodeStaging, node,
            procFakes, hostData, scripts,
        ).forEach { it.mkdirs() }
    }
}
