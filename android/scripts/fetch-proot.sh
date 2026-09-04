#!/usr/bin/env bash
# fetch-proot.sh — fetch prebuilt proot (aarch64) + its runtime library deps
# from the Termux package repository and install them into app/src/main/jniLibs.
#
# proot is GPL-2.0-or-later (see ../NOTICE). We only redistribute the binaries,
# unmodified, as independently-launched programs (jniLibs → extracted to
# nativeLibraryDir by useLegacyPackaging).
#
# Everything is PINNED (version + SHA256) so a repo-side update can never
# silently change what ships inside the APK (same policy as
# fetch-engine-runtime.sh). To upgrade: bump the pins below after verifying
# against the termux-main package index:
#   https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages
#
# Termux builds link against libtalloc + libandroid-shmem. libandroid-shmem.so
# and libtalloc.so.2 both go to jniLibs? No — AGP jniLibs only packages files
# matching lib*.so, so libtalloc.so.2 (the exact soname proot NEEDs) is dropped
# silently. It therefore ships as an ASSET (assets/engine-libs/libtalloc.so.2)
# and ProotRunner copies it to filesDir + LD_LIBRARY_PATH at boot. libandroid-shmem.so
# matches the pattern and stays in jniLibs.
#
# Usage: bash scripts/fetch-proot.sh        (run from android/)
# Requires: bash, python 3 (tarfile/lzma — no binutils/ar/xz needed).

set -euo pipefail

cd "$(dirname "$0")/.."

exec python - <<'PY'
import hashlib, io, lzma, os, struct, sys, tarfile, urllib.request

REPO = "https://packages.termux.dev/apt/termux-main"
PREFIX = "data/data/com.termux/files/usr"

# (deb name, version, sha256, jniLibs name, deb-relative lib path)
PINS = [
    ("proot", "5.1.107.92",
     "1f1c983509701f6826f568482c70673ee453a9ba38c9f5fa445a472d6b7524e9",
     "libproot_exec.so", f"{PREFIX}/bin/proot"),
    ("proot", "5.1.107.92",
     "1f1c983509701f6826f568482c70673ee453a9ba38c9f5fa445a472d6b7524e9",
     "libproot_loader.so", f"{PREFIX}/libexec/proot/loader"),
    ("libtalloc", "2.4.3",
     "ac81ad623d74c209718b9f3acb2dd702cc8a88c431e820d212229910b4db29da",
     "ENGINE_LIBS/libtalloc.so.2", f"{PREFIX}/lib/libtalloc.so.2.4.3"),
    ("libandroid-shmem", "0.7",
     "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6",
     "libandroid-shmem.so", f"{PREFIX}/lib/libandroid-shmem.so"),
]

def deb_data_tar(deb: bytes) -> bytes:
    # Minimal ar parser: "!<arch>\n" + 60-byte headers.
    assert deb[:8] == b"!<arch>\n", "not an ar archive"
    off = 8
    while off + 60 <= len(deb):
        hdr = deb[off:off + 60]
        name = hdr[0:16].decode("ascii", "replace").rstrip()
        size = int(hdr[48:58].decode().strip())
        body = deb[off + 60:off + 60 + size]
        if name.startswith("data.tar"):
            print(f"  {name} ({size} bytes)")
            if name.endswith(".xz"):
                return lzma.decompress(body)
            if name.endswith(".gz"):
                import gzip
                return gzip.decompress(body)
            return body
        off += 60 + size + (size & 1)
    raise SystemExit("data.tar.* not found in .deb")

def member_bytes(tf: tarfile.TarFile, arcname: str) -> bytes:
    # Termux tars prefix paths with "./"; follow in-archive symlinks.
    for cand in (arcname, f"./{arcname}"):
        try:
            m = tf.getmember(cand)
            break
        except KeyError:
            continue
    else:
        raise SystemExit(f"{arcname}: member not found in deb")
    seen = set()
    while m.issym() and m.linkname not in seen:
        seen.add(m.linkname)
        target = os.path.normpath(os.path.join(os.path.dirname(m.name), m.linkname))
        m = tf.getmember(target if not target.startswith("./") else target)
    if not m.isfile():
        raise SystemExit(f"{arcname}: not a regular file (after symlink resolve)")
    return tf.extractfile(m).read()

def elf_needed(body: bytes) -> list:
    if body[:4] != b"\x7fELF" or body[4] != 2:
        raise SystemExit("not a 64-bit ELF")
    u16 = lambda o: struct.unpack_from("<H", body, o)[0]
    u64 = lambda o: struct.unpack_from("<Q", body, o)[0]
    e_shoff, e_shentsize, e_shnum, e_shstrndx = u64(0x28), u16(0x3A), u16(0x3C), u16(0x3E)
    shs = [(u16(b), u64(b + 0x18), u64(b + 0x20))
           for b in (e_shoff + i * e_shentsize for i in range(e_shnum))]
    shstr = shs[e_shstrndx]
    def sname(off):
        s = body[shstr[1] + off:shstr[1] + shstr[2]]
        return s[:s.find(b"\x00")].decode()
    dynstr = dyn = None
    for sh in shs:
        n = sname(sh[0])
        if n == ".dynstr":
            dynstr = sh
        elif n == ".dynamic":
            dyn = sh
    needed = []
    if dynstr and dyn:
        o, end = dyn[1], dyn[1] + dyn[2]
        while o < end:
            tag, val = u64(o), u64(o + 8)
            if tag == 1:  # DT_NEEDED
                s = body[dynstr[1] + val:dynstr[1] + dynstr[2]]
                needed.append(s[:s.find(b"\x00")].decode())
            if tag == 0:
                break
            o += 16
    return needed

jni_dir = os.path.join("app", "src", "main", "jniLibs", "arm64-v8a")
libs_dir = os.path.join("engine-libs")
os.makedirs(jni_dir, exist_ok=True)
os.makedirs(libs_dir, exist_ok=True)

for name, version, sha, jni_name, lib_path in PINS:
    pool = "p/proot" if name == "proot" else "libt/libtalloc" if name == "libtalloc" else "liba/libandroid-shmem"
    url = f"{REPO}/pool/main/{pool}/{name}_{version}_aarch64.deb"
    print(f"→ {name}_{version} (aarch64): {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "AnyBuff-fetch/1.0"})
    deb = urllib.request.urlopen(req, timeout=120).read()
    got = hashlib.sha256(deb).hexdigest()
    if got != sha:
        raise SystemExit(f"SHA256 MISMATCH for {name}: got {got}, expected {sha}")
    print(f"  sha256 ok")
    with tarfile.open(fileobj=io.BytesIO(deb_data_tar(deb))) as tf:
        body = member_bytes(tf, lib_path)
    engine_lib = jni_name.startswith("ENGINE_LIBS/")
    jni_name = jni_name.split("/", 1)[1] if engine_lib else jni_name
    dest = os.path.join(libs_dir, jni_name) if engine_lib else os.path.join(jni_dir, jni_name)
    with open(dest, "wb") as f:
        f.write(body)
    os.chmod(dest, 0o755)
    print(f"  installed {jni_name} ({len(body)} bytes)")

# Verify the final set + ELF deps against the Android system-lib allowlist.
expect_jni = ["libandroid-shmem.so", "libproot_exec.so", "libproot_loader.so"]
names = sorted(os.listdir(jni_dir))
if names != expect_jni:
    raise SystemExit(f"UNEXPECTED LIB SET: {names}\nExpected: {expect_jni}")
expect_libs = ["libtalloc.so.2"]
names = sorted(os.listdir(libs_dir))
if names != expect_libs:
    raise SystemExit(f"UNEXPECTED engine-libs SET: {names}\nExpected: {expect_libs}")
SYSTEM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "ld-android.so"}
bundled = set(expect_jni) | set(expect_libs)
for d_, n in [(jni_dir, x) for x in expect_jni] + [(libs_dir, x) for x in expect_libs]:
    body = open(os.path.join(d_, n), "rb").read()
    needed = elf_needed(body)
    print(f"{n}: NEEDED={needed}")
    for dep in needed:
        if dep not in bundled and dep not in SYSTEM_LIBS:
            raise SystemExit(f"{n}: unsatisfied NEEDED entry {dep!r} — bundle it or extend the allowlist")
print("Done. jniLibs: pinned proot + libandroid-shmem; assets/engine-libs: libtalloc.so.2 (aarch64).")
PY
