# AnyBuff Android (Phase B)

The Android Kotlin shell for AnyBuff — a thin native layer around the shared
three-tier architecture (renderer / host-core / engine):

```
┌──────────────────────────── WebView (renderer web build, assets/www) ──┐
│   https://appassets.androidplatform.net  ← WebViewAssetLoader           │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ WS (ws://127.0.0.1:<port>?token=…)  +  native message bridge
┌──────────────▼──────────────────────────────────────────────────────────┐
│   Kotlin shell (this project)                                          │
│   · EngineService (specialUse FGS)  · Keystore  · SAF pickers          │
│   · proot process tree (sandbox)                                       │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ spawn
┌──────────────▼──────────────────────────────────────────────────────────┐
│   proot Ubuntu rootfs  →  Node 22 arm64  →  anybuff-host.mjs           │
│   (sdk dist + host-core bundle + rg arm64 + tree-sitter wasm)          │
└─────────────────────────────────────────────────────────────────────────┘
```

Host business logic runs inside the proot sandbox as `anybuff-host.mjs` — the
same self-contained `@codebuff/host-core` bundle the desktop Electron shell
imports in-process — exposing the exact `AnyBuff:*` WS channel contract.
This directory is intentionally **not** part of the bun workspace (plan §4).

## Layout

| Path | Purpose |
|---|---|
| `app/src/main/java/com/anybuff/android/` | Kotlin shell |
| `.../MainActivity.kt` | WebView + WebViewAssetLoader (M-B0) |
| `.../engine/` | EngineService (FGS), proot runner, rootfs installer, host process (M-B1/M-B4) |
| `.../crypto/` | Keystore AES/GCM vault (M-B2) |
| `.../bridge/` | WebView ↔ native message channel (M-B3) |
| `app/src/main/assets/www/` | renderer web build (synced from `desktop/dist-web`) |
| `app/src/main/jniLibs/arm64-v8a/` | proot `libproot_exec.so` / `libproot_loader.so` / `libandroid-shmem.so` (exec surface) |
| `app/src/main/assets/runtime/` | bundled engine runtime: ubuntu-base rootfs (.tgz) + Node.js tar.xz + manifest.json (SHA256-pinned by `scripts/fetch-engine-runtime.sh`) |
| `engine-libs/` | `libtalloc.so.2` (proot dependency; packaged as an asset — AGP jniLibs only accepts `lib*.so` names) |
| `scripts/` | build & fetch helpers |

## Build

```powershell
# 1. (repo root) build the shared pieces the Android bundle consumes
bun run build:sdk
bun --cwd packages/host-core run build     # emits dist/anybuff-host.mjs
bun --cwd desktop run build:web            # emits desktop/dist-web/ (renderer)

# 2. fetch the bundled engine payloads (once; pinned + SHA256-verified)
#    → jniLibs proot binaries, engine-libs/libtalloc.so.2,
#      assets/runtime/ (ubuntu-base rootfs .tgz + Node.js tar.xz + manifest.json)
bash scripts/fetch-proot.sh
bash scripts/fetch-engine-runtime.sh

# 3. assemble (~117MB APK: the engine runtime ships inside — no first-boot downloads)
cd android
./gradlew :app:assembleDebug
```

The APK assets are assembled by `syncWebAssets` (copies `desktop/dist-web/`)
and `syncEngineAssets` (copies the host bundle + wasm + rg). See
`app/build.gradle.kts`.

## Versions (pinned in gradle.properties)

- AGP 8.13.2, Gradle 8.14, Kotlin 2.3.20, compileSdk 36 / minSdk 26 / targetSdk 36
- JDK ≥17 (JDK 24 works via Gradle 8.14)
- androidx.webkit 1.14.0 (+ activity, core-ktx, lifecycle, documentfile)

## License

AnyBuff is Apache-2.0. The bundled proot binaries are GPL-2.0-or-later —
see `NOTICE` in this directory.
