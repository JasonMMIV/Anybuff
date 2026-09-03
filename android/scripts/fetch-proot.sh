#!/usr/bin/env bash
# fetch-proot.sh — fetch prebuilt proot binaries (aarch64) from the Termux
# package repository and install them into app/src/main/jniLibs as
# libproot_exec.so / libproot_loader.so.
#
# proot is GPL-2.0-or-later (see ../NOTICE). We only redistribute the binary,
# unmodified, as an independently-launched program.
#
# Usage: bash scripts/fetch-proot.sh [version]
#   version defaults to the newest published in the Termux repo (queried).
#
# Requires: curl, unzip. Run from the android/ directory.

set -euo pipefail

cd "$(dirname "$0")/.."

AARCH64_DIR="app/src/main/jniLibs/arm64-v8a"
mkdir -p "$AARCH64_DIR"

# Termux apt package index (aarch64). proot's real name is "proot"; the .so
# artifacts are pulled from the package contents.
PROOT_DEB_URL="https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${1:-latest}_aarch64.deb"
echo "Fetching proot from Termux repo…"

# Resolve the newest proot version from the package index if not pinned.
if [ "${1:-}" = "latest" ] || [ -z "${1:-}" ]; then
  VERSION="$(curl -fsSL https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages \
    | awk '/^Package: proot$/{f=1} f&&/^Version:/{print $2; exit}')"
  echo "Newest proot version: ${VERSION}"
  PROOT_DEB_URL="https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${VERSION}_aarch64.deb"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${PROOT_DEB_URL}"
curl -fsSL -o "$TMP/proot.deb" "$PROOT_DEB_URL"
# .deb = ar archive; unpack with bsdtar if present, else ar+tar fallback.
if command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$TMP/proot.deb" -C "$TMP"
else
  ar x "$TMP/proot.deb" --output "$TMP" 2>/dev/null || {
    echo "need bsdtar or GNU ar (binutils)"; exit 1; }
fi
mkdir -p "$TMP/data"
tar -xf "$TMP/data.tar.xz" -C "$TMP/data" 2>/dev/null || tar -xf "$TMP/data.tar.zst" -C "$TMP/data"

# proot ships its loaders as libproot_exec.so / libproot_loader.so inside
# $PREFIX/lib — copy them into jniLibs (exec-able surface, W^X/R4).
find "$TMP/data" -name 'libproot_*.so' -exec cp {} "$AARCH64_DIR/" \;
chmod 755 "$AARCH64_DIR"/libproot_*.so

echo "Installed:"
ls -la "$AARCH64_DIR"
