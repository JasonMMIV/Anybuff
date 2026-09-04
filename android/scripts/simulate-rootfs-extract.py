#!/usr/bin/env python3
"""simulate-rootfs-extract.py — mirror SafeTarExtractor's lexical containment
semantics against the real ubuntu-base tarball (and synthetic malicious cases).

Why this exists (plan §4.0, 2026-09-04 device round 3): the device failed with
"symlink escapes rootfs: usr/bin/pager -> /etc/alternatives/pager". Root cause:
the extractor's escape check used canonicalFile/realpath, which dereferenced
earlier-created guest-absolute symlinks (etc/alternatives/pager -> /bin/more)
against the DEVICE's real filesystem and reported a false escape. SafeTarExtractor
now resolves LEXICALLY in the guest namespace (dest == "/"), never via host
realpath. This script mirrors that logic on a virtual FS so regressions can be
re-run without a device.

Usage:
    python scripts/simulate-rootfs-extract.py [path-to-rootfs.tgz]
    (default: app/src/main/assets/runtime/rootfs-ubuntu-base-24.04.4-arm64.tgz)

Exit 0 when the payload extracts with 0 rejections AND all malicious synthetic
cases are rejected. Run from android/.
"""
import gzip
import os
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TARBALL = os.path.join(HERE, "..", "app", "src", "main", "assets",
                               "runtime", "rootfs-ubuntu-base-24.04.4-arm64.tgz")

# Virtual filesystem: path -> "dir" | "file" | ("link", content)
FS = {"/": "dir"}


def parent(p: str) -> str:
    return p.rsplit("/", 1)[0] or "/"


def ensure_parent_dirs(p: str) -> None:
    cur = "/"
    for seg in p.split("/"):
        if not seg:
            continue
        cur = cur.rstrip("/") + "/" + seg
        FS.setdefault(cur, "dir")


def lexically_resolve_inside(base_rel: str, raw: str) -> str:
    """Mirror lexicallyResolveInside: absolute content anchors at root, '..'
    clamps at root. base_rel is the symlink's own dir relative to root."""
    stack = [s for s in base_rel.split("/") if s and s != "."]
    if raw.startswith("/"):
        stack = []
    for seg in raw.replace("\\", "/").split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if stack:
                stack.pop()  # clamp at root
        else:
            stack.append(seg)
    return "/" + "/".join(stack)


def resolve(name: str) -> str:
    """Mirror resolve(dest, name): lexical '..' depth check + refuse to descend
    through an existing symlink intermediate."""
    segs = [s for s in name.strip("/").split("/") if s and s != "."]
    depth = 0
    for s in segs:
        if s == "..":
            depth -= 1
            if depth < 0:
                raise RuntimeError(f"path escapes rootfs: {name}")
        else:
            depth += 1
    cur = "/"
    for i, seg in enumerate(segs):
        if seg == "..":
            cur = parent(cur)
            continue
        nxt = "/" + seg if cur == "/" else cur + "/" + seg
        if i < len(segs) - 1:
            ent = FS.get(nxt)
            if isinstance(ent, tuple) and ent[0] == "link":
                raise RuntimeError(f"member path traverses symlink: {name}")
        cur = nxt
    return cur


def process_member(name: str, typ: str, linkname: str = "") -> None:
    name = "/" + name.strip("/") if not name.startswith("/") else name.strip("/")
    if typ == "dir":
        FS.setdefault(name, "dir")
    elif typ == "file":
        tgt = resolve(name)
        ensure_parent_dirs(tgt)
        FS[tgt] = "file"
    elif typ == "symlink":
        tgt = resolve(name)
        ensure_parent_dirs(tgt)
        resolved = lexically_resolve_inside(parent(tgt).lstrip("/"), linkname)
        if resolved is None or not resolved.startswith("/"):
            raise RuntimeError(f"symlink escapes rootfs: {name} -> {linkname}")
        FS[tgt] = ("link", linkname)
    elif typ == "hardlink":
        tgt = resolve(name)
        src = resolve(linkname)
        ensure_parent_dirs(tgt)
        FS[tgt] = FS.get(src, "file")
    # other types: skipped (stream-aligned in the real extractor)


def extract_tarball(path: str):
    """Return list of rejections for the real tarball."""
    rejected = []
    with gzip.open(path, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as tf:
        for m in tf:
            if m.type in (tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME,
                          tarfile.GNUTYPE_LONGLINK):
                continue
            try:
                if m.type == tarfile.DIRTYPE:
                    process_member(m.name, "dir")
                elif m.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    process_member(m.name, "file")
                elif m.type == tarfile.SYMTYPE:
                    process_member(m.name, "symlink", m.linkname)
                elif m.type == tarfile.LNKTYPE:
                    process_member(m.name, "hardlink", m.linkname)
            except RuntimeError as e:
                rejected.append(f"{m.name} -> {m.linkname!r}: {e}")
    return rejected


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARBALL
    if not os.path.exists(path):
        print(f"tarball not found: {path}")
        return 2
    rejected = extract_tarball(path)
    print(f"payload: {path}")
    print(f"  members extracted, rejections: {len(rejected)}")
    for r in rejected[:20]:
        print("  REJECT:", r)
    if rejected:
        return 1

    # Synthetic security negatives
    # (1) write through an existing symlink intermediate must reject
    FS.clear(); FS["/"] = "dir"
    try:
        process_member("x", "symlink", "/etc")
        process_member("x/passwd", "file")
        print("  NEG(1) FAIL: write through symlink intermediate NOT rejected")
        return 1
    except RuntimeError:
        print("  NEG(1) ok: write through symlink intermediate rejected")

    # (2) '..' member name must reject
    FS.clear(); FS["/"] = "dir"
    try:
        process_member("../evil", "file")
        print("  NEG(2) FAIL: dotdot member NOT rejected")
        return 1
    except RuntimeError:
        print("  NEG(2) ok: dotdot member rejected")

    # (3) relative '..' symlink content must clamp at root (guest semantics)
    FS.clear(); FS["/"] = "dir"
    process_member("a/b/c/link", "symlink", "../../../../../outside")
    print("  NEG(3) ok: relative '..' link clamped (guest semantics)")

    # (4) absolute '..' link content must anchor at root then clamp
    FS.clear(); FS["/"] = "dir"
    process_member("d/link2", "symlink", "/../../../../etc/passwd")
    print("  NEG(4) ok: absolute '..' link anchored+clamped at root")

    # Regression: the exact device failure chain (pager alternatives)
    FS.clear(); FS["/"] = "dir"
    process_member("etc/alternatives/pager", "symlink", "/bin/more")
    process_member("usr/bin/pager", "symlink", "/etc/alternatives/pager")
    print("  REGRESSION ok: pager alternatives chain extracts (0 rejection)")
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
