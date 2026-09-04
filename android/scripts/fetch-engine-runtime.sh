#!/usr/bin/env bash
# fetch-engine-runtime.sh — fetch the pinned engine runtime payloads (Ubuntu
# base rootfs + Node.js) and install them into app/src/main/assets/runtime
# so the APK ships the complete engine (no first-boot downloads).
#
# Motivation (plan §4.0, 2026-09-03 incident): the previous design downloaded
# ubuntu-base on first boot; Ubuntu rotates point releases and REMOVES the old
# files, so the pinned URL 404'd and the app could not start at all. Shipping
# the runtime in the APK makes first boot offline-capable and immune to
# upstream URL rot. (User decision: 全部綁進 APK.)
#
# Everything is PINNED (version + SHA256, verified against the official
# SHA256SUMS of each source) — same policy as fetch-proot.sh.
#
# Artifacts produced:
#   app/src/main/assets/runtime/rootfs-ubuntu-base-24.04.4-arm64.tgz
#   app/src/main/assets/runtime/node-v22.23.2-linux-arm64.tar.xz
#   app/src/main/assets/runtime/manifest.json        (sha256s the app verifies
#                                                      against at install time)
#
# NOTE: the rootfs asset is stored as .tgz, NOT .tar.gz — AAPT2 special-cases
# assets ending in .gz (it gunzips them in-place and STRIPS the suffix),
# which would both rename the asset out from under manifest.json and store
# the 106MB uncompressed tar. .tgz skips that path and deflates normally.
#
# Usage: bash scripts/fetch-engine-runtime.sh     (run from android/)
# Requires: bash, python 3.

set -euo pipefail

cd "$(dirname "$0")/.."

exec python - <<'PY'
import hashlib, json, os, sys, urllib.request

OUT = os.path.join("app", "src", "main", "assets", "runtime")

# ── Pins (SHA256s from the official SHASUMS files, verified 2026-09-03) ────
ROOTFS = {
    "name": "rootfs-ubuntu-base-24.04.4-arm64.tgz",  # .tgz: avoids AAPT2's .gz handling
    "url": "https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/"
           "ubuntu-base-24.04.4-base-arm64.tar.gz",
    "sha256": "04207713ece899c3740823d33690441ad3a7f0ded1101aca744e2b0f37ac7ff2",
}
NODE = {
    "name": "node-v22.23.2-linux-arm64.tar.xz",
    "url": "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz",
    "sha256": "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8",
}

os.makedirs(OUT, exist_ok=True)

def fetch(url: str, sha256: str, label: str, dest_name: str) -> str:
    dest = os.path.join(OUT, dest_name)
    print(f"→ {label}: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "AnyBuff-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        h = hashlib.sha256()
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
        got = h.hexdigest()
    if got != sha256:
        os.remove(dest)
        raise SystemExit(f"SHA256 MISMATCH for {label}: got {got}, expected {sha256}")
    print(f"  sha256 ok → {dest} ({os.path.getsize(dest)} bytes)")
    return dest

files = {
    "rootfs": fetch(ROOTFS["url"], ROOTFS["sha256"], "rootfs", ROOTFS["name"]),
    "node": fetch(NODE["url"], NODE["sha256"], "node", NODE["name"]),
}


def uncompressed_size(path: str) -> int:
    """Sum the tar member sizes so the app can preflight ENOSPC."""
    import gzip
    import lzma
    import tarfile
    opener = gzip.open if path.endswith((".gz", ".tgz")) else lzma.open
    with opener(path, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as tf:
        return sum(m.size for m in tf)


manifest = {
    "rootfs": {"file": os.path.basename(files["rootfs"]),
               "sha256": ROOTFS["sha256"],
               "version": "ubuntu-base-24.04.4-arm64",
               "uncompressedBytes": uncompressed_size(files["rootfs"])},
    "node": {"file": os.path.basename(files["node"]),
             "sha256": NODE["sha256"],
             "version": "22.23.2",
             "uncompressedBytes": uncompressed_size(files["node"])},
}
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"manifest.json written ({json.dumps(manifest)})")
print("Done. assets/runtime now carries the pinned rootfs + node tarballs.")
PY
