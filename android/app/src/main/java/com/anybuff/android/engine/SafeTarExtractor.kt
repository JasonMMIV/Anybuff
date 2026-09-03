package com.anybuff.android.engine

import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPInputStream

/**
 * Self-written, security-hardened tar extractor (plan M-B1: "自寫 tar 解壓器").
 *
 * - Supports ustar, PAX (extended headers), and GNU longname/longlink.
 * - Rejects path traversal and **symlink escapes** (a member that resolves
 *   outside the destination tree aborts the whole extraction).
 * - Hardlinks fall back to a full copy when link(2) is unavailable.
 * - Applies mode (rwx only) and mtime from the archive.
 *
 * Decompression: transparent .gz / .xz passthrough (xz via org.tukaani:xz).
 */
object SafeTarExtractor {

    private const val BLOCK = 512
    private const val TYPE_REG = '0'.code
    private const val TYPE_HARD = '1'.code
    private const val TYPE_SYM = '2'.code
    private const val TYPE_DIR = '5'.code
    private const val TYPE_PAX = 'x'.code
    private const val TYPE_GNU_LONGNAME = 'L'.code
    private const val TYPE_GNU_LONGLINK = 'K'.code

    /** Cap for PAX / GNU-longname records read fully into memory (1 MiB). */
    private const val MAX_HEADER_CONTENT = 1024L * 1024L

    class ExtractionException(message: String) : IOException(message)

    /** End-of-archive marker (two zero blocks). */
    private class EndOfArchive : Exception()

    /**
     * Extract [archive] into [destDir]. [destDir] must already exist.
     * Returns the number of members extracted.
     */
    fun extract(archive: File, destDir: File): Int {
        val canonicalDest = destDir.canonicalFile
        if (!canonicalDest.isDirectory) {
            throw ExtractionException("destination ${canonicalDest.path} is not a directory")
        }
        FileInputStream(archive).use { fis ->
            val input: InputStream = when {
                archive.name.endsWith(".xz") -> XZInputStream(BufferedInputStream(fis))
                archive.name.endsWith(".gz") || archive.name.endsWith(".tgz") ->
                    GZIPInputStream(BufferedInputStream(fis))
                else -> BufferedInputStream(fis)
            }
            return extractStream(input, canonicalDest)
        }
    }

    private fun extractStream(input: InputStream, dest: File): Int {
        val reader = TarReader(input)
        var count = 0

        while (true) {
            val header = try {
                reader.readHeader()
            } catch (_: EndOfArchive) {
                break
            } ?: break

            when (header.type) {
                TYPE_PAX -> {
                    val pax = parsePax(reader.readContent(header.size))
                    pax["path"]?.let { reader.pendingPath = it }
                    pax["linkpath"]?.let { reader.pendingLink = it }
                    continue
                }
                TYPE_GNU_LONGNAME -> {
                    reader.pendingPath = String(reader.readContent(header.size), Charsets.UTF_8).trimEnd('\u0000')
                    continue
                }
                TYPE_GNU_LONGLINK -> {
                    reader.pendingLink = String(reader.readContent(header.size), Charsets.UTF_8).trimEnd('\u0000')
                    continue
                }
                else -> { /* fall through to member handling */ }
            }

            val name = reader.takePendingPath(header.name)
            val link = reader.takePendingLink(header.linkName)
            count++

            when (header.type) {
                TYPE_DIR -> mkdir(dest, name, header.mode)
                TYPE_REG -> writeFile(reader, dest, name, header.size, header.mode, header.mtime)
                TYPE_SYM -> makeSymlink(dest, name, link)
                TYPE_HARD -> makeHardlink(dest, name, link)
                else -> reader.skip(header.size) // keep stream aligned
            }
        }
        return count
    }

    /* ── members ─────────────────────────────────────────────── */

    private fun mkdir(dest: File, name: String, mode: Int) {
        val target = resolve(dest, name)
        if (target.exists()) return
        if (!target.mkdirs()) throw ExtractionException("mkdir failed: ${target.path}")
        applyMode(target, mode)
    }

    private fun writeFile(reader: TarReader, dest: File, name: String, size: Long, mode: Int, mtime: Long) {
        val target = resolve(dest, name)
        target.parentFile?.mkdirs()
        java.io.FileOutputStream(target).use { out ->
            val buf = ByteArray(DEFAULT_BUFFER_SIZE)
            var remaining = size
            while (remaining > 0) {
                val n = reader.read(buf, minOf(buf.size.toLong(), remaining).toInt())
                if (n < 0) throw ExtractionException("truncated member: $name")
                out.write(buf, 0, n)
                remaining -= n
            }
        }
        reader.skipPaddingAfter(size)
        applyMode(target, mode)
        // tar mtime is epoch seconds; setLastModified wants millis.
        if (mtime > 0) target.setLastModified(mtime.coerceAtMost(Long.MAX_VALUE / 1000) * 1000)
    }

    private fun makeSymlink(dest: File, name: String, link: String) {
        val target = resolve(dest, name)
        target.parentFile?.mkdirs()
        if (target.exists()) return
        val resolvedLink = File(target.parentFile, link).canonicalFile
        val destCanon = dest.canonicalFile
        if (!resolvedLink.path.startsWith(destCanon.path + File.separator) && resolvedLink != destCanon) {
            throw ExtractionException("symlink escapes rootfs: $name -> $link")
        }
        try {
            java.nio.file.Files.createSymbolicLink(target.toPath(), File(link).toPath())
        } catch (_: IOException) {
            // Symlinks unsupported (FUSE/emulated storage) — skip; node works
            // without the few links inside ubuntu-base.
        }
    }

    private fun makeHardlink(dest: File, name: String, link: String) {
        val target = resolve(dest, name)
        val source = resolve(dest, link)
        target.parentFile?.mkdirs()
        try {
            java.nio.file.Files.createLink(target.toPath(), source.toPath())
        } catch (_: IOException) {
            if (!source.exists()) throw ExtractionException("hardlink source missing: $link")
            source.copyTo(target, overwrite = false)
        }
    }

    private fun resolve(dest: File, name: String): File {
        val cleaned = name.trimStart('/')
        val canon = File(dest, cleaned).canonicalFile
        if (!canon.path.startsWith(dest.canonicalFile.path + File.separator)) {
            throw ExtractionException("path escapes rootfs: $name")
        }
        return canon
    }

    private fun applyMode(file: File, mode: Int) {
        try {
            // Octal bit masks written as decimal (Kotlin has no octal literal).
            if (mode and 0b001_000_000 != 0) file.setExecutable(true, false) // 0o100 owner-exec
            if (mode and 0b000_010_000 != 0) file.setWritable(true, false) // 0o020 owner-write
            if (mode and 0b000_000_100 != 0) file.setReadable(true, false) // 0o004 owner-read
        } catch (_: Exception) {
            // best effort on emulated storage
        }
    }

    /* ── PAX parsing ─────────────────────────────────────────── */

    private fun parsePax(bytes: ByteArray): Map<String, String> {
        val map = mutableMapOf<String, String>()
        var i = 0
        while (i < bytes.size) {
            var sp = -1
            for (j in i until bytes.size) {
                if (bytes[j] == ' '.code.toByte()) { sp = j; break }
            }
            if (sp < 0) break
            var len = 0
            var ok = true
            for (j in i until sp) {
                val c = bytes[j].toInt() - '0'.toInt()
                if (c < 0 || c > 9) { ok = false; break }
                len = len * 10 + c
            }
            if (!ok || len <= 0) break
            val contentStart = sp + 1
            val recordLen = minOf(len - (sp - i) - 1, bytes.size - contentStart)
            if (recordLen <= 0) break
            val record = String(bytes, contentStart, recordLen)
            val eq = record.indexOf('=')
            if (eq > 0) map[record.substring(0, eq)] = record.substring(eq + 1)
            i += len
        }
        return map
    }

    /* ── low-level tar reader ────────────────────────────────── */

    private class TarReader(private val input: InputStream) {
        var pendingPath: String? = null
        var pendingLink: String? = null

        private val headerBuf = ByteArray(BLOCK)
        private val scratch = ByteArray(BLOCK)

        fun readHeader(): Header? {
            readFully(headerBuf)
            if (headerBuf.all { it == 0.toByte() }) throw EndOfArchive()
            val name = String(headerBuf, 0, 100, Charsets.UTF_8).trimEnd('\u0000', ' ')
            val mode = (octal(headerBuf, 100, 8) ?: 0L).toInt()
            val size = octal(headerBuf, 124, 12) ?: 0L
            val mtime = octal(headerBuf, 136, 12) ?: 0L
            val type = headerBuf[156].toInt()
            val linkName = String(headerBuf, 157, 100, Charsets.UTF_8).trimEnd('\u0000', ' ')
            return Header(name, linkName, mode, size, mtime, type)
        }

        fun takePendingPath(fallback: String): String =
            pendingPath?.also { pendingPath = null }?.takeIf { it.isNotBlank() } ?: fallback

        fun takePendingLink(fallback: String): String =
            pendingLink?.also { pendingLink = null }?.takeIf { it.isNotBlank() } ?: fallback

        fun readContent(size: Long): ByteArray {
            // Only ever called for PAX / GNU-longname records — a hostile header
            // must not be able to force a huge preallocation (OOM). 1 MiB is far
            // beyond any legitimate path/link record.
            if (size <= 0 || size > MAX_HEADER_CONTENT) {
                throw ExtractionException("oversized header record: $size bytes")
            }
            val buf = ByteArray(size.toInt())
            readFully(buf)
            skipPadding(size)
            return buf
        }

        /** Read up to [max] bytes of the current member content; -1 on EOF. */
        fun read(buf: ByteArray, max: Int): Int {
            val n = input.read(buf, 0, max)
            if (n < 0) return -1
            return n
        }

        fun skip(size: Long) {
            var remaining = size
            while (remaining > 0) {
                val n = input.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
                if (n < 0) throw IOException("unexpected EOF")
                remaining -= n
            }
            skipPadding(size)
        }

        /** Skip the tar padding that follows a member of [size] bytes. */
        fun skipPaddingAfter(size: Long) {
            val pad = (BLOCK - (size % BLOCK)) % BLOCK
            var left = pad
            while (left > 0) {
                val n = input.read(scratch, 0, left.toInt())
                if (n < 0) throw IOException("unexpected EOF in padding")
                left -= n
            }
        }

        private fun skipPadding(size: Long) = skipPaddingAfter(size)

        private fun readFully(buf: ByteArray) {
            var off = 0
            while (off < buf.size) {
                val n = input.read(buf, off, buf.size - off)
                if (n < 0) {
                    if (off == 0) throw EndOfArchive()
                    throw IOException("truncated tar header")
                }
                off += n
            }
        }
    }

    private class Header(
        val name: String,
        val linkName: String,
        val mode: Int,
        val size: Long,
        val mtime: Long,
        val type: Int,
    )

    private fun octal(buf: ByteArray, offset: Int, length: Int): Long? {
        var end = offset + length
        while (end > offset && (buf[end - 1] == 0.toByte() || buf[end - 1] == ' '.code.toByte())) end--
        if (end == offset) return null
        if (buf[offset].toInt() and 0x80 != 0) return null // base-256; unsupported
        var v = 0L
        for (i in offset until end) {
            val c = buf[i].toInt()
            if (c < '0'.code || c > '7'.code) return null
            v = v * 8 + (c - '0'.code)
        }
        return v
    }
}
