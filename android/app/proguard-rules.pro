# Keep line numbers for the on-device crash log (M-C3, no cloud crash reporting).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# AnyBuff engine host assets are data (JS/wasm) — no shrinking concerns.
