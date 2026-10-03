plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ── Version facts (M-C2, ADR-14) ──────────────────────────────────────────
// desktop/package.json "version" is the SINGLE source of truth for the app
// version (ADR-14). The CI release workflow derives name + versionCode from
// it (1.0.0 → 10000 + patch·1 per ten-thousand) and passes them in via
// -Panybuff.versionName / -Panybuff.versionCode. Local builds fall back to
// the same defaults CI would derive from v1.0.0.
val anybuffVersionName = (project.findProperty("anybuff.versionName") as String?)?.takeIf { it.isNotBlank() } ?: "1.0.0"
val anybuffVersionCode = (project.findProperty("anybuff.versionCode") as String?)?.takeIf { it.isNotBlank() }?.toIntOrNull() ?: 10000

// ── Release signing ────────────────────────────────────────────────────────
// CI drives this through ANYBUFF_KEYSTORE_* (GitHub Secrets → env). Locally the
// keystore lives in android/keystore/ — gitignored, because keys are never
// committed — so when the env vars are absent we look there instead. That lookup
// is the whole point: before it existed, a local `./gradlew assembleRelease`
// with a keystore sitting right there in the tree silently fell through to the
// debug key and produced an installable APK with the wrong signer identity.
// Hence the unconditional log line below — the choice is never silent again.
// Escape hatch: -Panybuff.ignoreLocalKeystore=true forces the debug fallback.
val ignoreLocalKeystore = (project.findProperty("anybuff.ignoreLocalKeystore") as String?)
    ?.toBoolean() ?: false

// rootProject.file() — this is the :app module, so bare relative paths would
// resolve against android/app/. The keystore lives one level up, in android/.
val localKeystore = rootProject.file("keystore/anybuff-release.jks")
val localKeystorePassword = rootProject.file("keystore/keystore-password.txt")

val keystoreFromEnv = System.getenv("ANYBUFF_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
val keystoreFile = when {
    keystoreFromEnv != null -> rootProject.file(keystoreFromEnv)
    !ignoreLocalKeystore && localKeystore.isFile -> localKeystore
    else -> null
}
val keystorePassword = System.getenv("ANYBUFF_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
    ?: localKeystorePassword.takeIf { it.isFile }?.readText()?.trim()

val releaseSigningConfigured = keystoreFile != null && keystorePassword != null
val keystoreAlias = System.getenv("ANYBUFF_KEY_ALIAS") ?: "anybuff"

logger.lifecycle(
    if (releaseSigningConfigured) {
        "[signing] release key → ${keystoreFile?.path} (alias $keystoreAlias)"
    } else {
        "[signing] WARNING: no keystore found — assembleRelease will sign with the DEBUG key, " +
            "so the APK will NOT install over a build from GitHub Releases. " +
            "Fix: set ANYBUFF_KEYSTORE_FILE + ANYBUFF_KEYSTORE_PASSWORD, or place " +
            "anybuff-release.jks + keystore-password.txt in android/keystore/."
    },
)

android {
    namespace = "com.anybuff.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anybuff.android"
        minSdk = 26
        targetSdk = 36
        versionCode = anybuffVersionCode
        versionName = anybuffVersionName
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    signingConfigs {
        create("release") {
            // Resolved above from CI env, or from android/keystore/ on a dev
            // machine. Anything missing → leave this config inert and let
            // buildTypes.release keep the debug-signing fallback below.
            // A malformed config fails loudly at signing time — never
            // silently unsigned.
            if (releaseSigningConfigured) {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                keyPassword = System.getenv("ANYBUFF_KEY_PASSWORD") ?: keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                // AGP does NOT sign release builds with the debug key
                // implicitly — an unassigned release config produces
                // app-release-unsigned.apk, which no device accepts. The
                // debug-key fallback is deliberate (plan M-C2): local
                // assembleRelease and non-publish CI runs both expect an
                // installable APK; publishing without release secrets is
                // blocked upstream in the workflow.
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

// ── Asset sync (M-B0/M-B1): renderer + engine bundle → APK assets ────────
// The renderer and engine are shared with desktop; both are copied into the
// APK before the assets are merged so the WebView serves the same UI and the
// sandbox expands the same host bundle as every other shell.
val distWebDir = rootProject.file("../desktop/dist-web")
val hostCoreDist = rootProject.file("../packages/host-core/dist")
val sdkDist = rootProject.file("../sdk/dist")
val wtsPackage = rootProject.file("../node_modules/web-tree-sitter")

// Generated asset dirs live under build/ (NOT src/main/assets — putting them
// there caused every asset to be packaged TWICE: once via the srcDir mount
// and once because they sat inside the physical assets/ root AGP scans).
val genAssetsRoot = layout.buildDirectory.dir("generated/anybuffAssets")
val webAssetsDir = genAssetsRoot.get().dir("www")
val engineAssetsDir = genAssetsRoot.get().dir("engine")
val runtimeAssetsDir = layout.projectDirectory.dir("src/main/assets/runtime")

// ── Web-bundle freshness guard (stale-bundle incident, 2026-09-21) ────────
// syncWebAssets only COPIES desktop/dist-web — it never builds it. A local
// APK build that skipped `build:web` therefore silently ships whatever
// bundle was left on disk; that is how the §4.6 "Direct Folder Access" UI
// (plus the M-C1/M-C2/M-C3 renderer halves) missed every APK for six days.
// Fail the build instead of shipping a stale UI. CI is unaffected — the
// release workflow runs build:web before Gradle, so the check always passes
// there.
val checkWebAssetsFresh = tasks.register("checkWebAssetsFresh") {
    description = "Fail fast when desktop/dist-web is missing or older than the renderer sources"
    group = "anybuff"
    // A pure check: always executes, never up-to-date-skipped.
    outputs.upToDateWhen { false }
    doLast {
        val indexHtml = distWebDir.resolve("index.html")
        if (!indexHtml.exists()) {
            throw GradleException(
                "desktop/dist-web is missing — the APK would ship with no renderer UI. " +
                    "Build it first:  bun run build:web",
            )
        }
        val desktopDir = distWebDir.parentFile
        val newestSource = maxOf(
            desktopDir.resolve("src/renderer").walkTopDown()
                .filter { it.isFile }
                .maxOfOrNull { it.lastModified() } ?: 0L,
            desktopDir.resolve("web-vite.config.ts").lastModified(),
        )
        if (newestSource > indexHtml.lastModified()) {
            throw GradleException(
                "desktop/dist-web is older than the renderer sources — run  bun run build:web  " +
                    "before building the APK (a stale bundle silently ships an old UI).",
            )
        }
    }
}

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    description = "Copy desktop/dist-web renderer build into generated APK assets/www"
    group = "anybuff"
    dependsOn(checkWebAssetsFresh)
    from(distWebDir)
    into(webAssetsDir)
    // dist-web is emptyOutDir'd by vite; mirror that here so content-hashed
    // chunks from older builds never accumulate inside the APK.
    delete(webAssetsDir)
}

val syncEngineAssets = tasks.register<Sync>("syncEngineAssets") {
    description = "Copy host bundle + sdk native assets into APK assets/engine"
    group = "anybuff"
    // Self-contained host bundle (host-core + inlined SDK). ws is inlined by
    // the bundler, but web-tree-sitter stays external (Bun keeps it as an
    // import) — its JS module + tree-sitter.wasm ship beside the bundle.
    from(hostCoreDist) { include("anybuff-host.mjs") }
    from(sdkDist) {
        // sdkDist == sdk/dist; the vendored rg + wasm already live under it.
        include("vendor/ripgrep/arm64-linux/rg", "wasm/**")
    }
    // The host bundle's resolveTreeSitterWasm looks for tree-sitter.wasm
    // BESIDE the bundle (scriptDir) first — ship a copy at engine/ root.
    // (Distinct source dir so Gradle's duplicate detector doesn't fire — two
    // `from(sdkDist)` specs both walk the file before rename.)
    from(rootProject.file("../sdk/dist/wasm")) { include("tree-sitter.wasm") }
    from(rootProject.file("../node_modules")) {
        // web-tree-sitter is an external import of anybuff-host.mjs; node
        // resolves it from <bundleDir>/node_modules/, so keep the layout.
        include("web-tree-sitter/package.json", "web-tree-sitter/tree-sitter.js", "web-tree-sitter/tree-sitter.cjs")
        into("node_modules")
    }
    // libtalloc.so.2 ships as an ASSET (AGP jniLibs silently drops anything
    // not matching lib*.so; proot NEEDs the exact soname file). ProotRunner
    // copies it out and adds that dir to LD_LIBRARY_PATH. Source lives OUTSIDE
    // src/main/assets so AGP's default assets root does not package it twice.
    from(rootProject.file("engine-libs")) {
        include("libtalloc.so.2")
        into("lib")
    }
    into(engineAssetsDir)
    // Keep the engine dir free of files that were removed upstream (wasm set
    // changes, rg renames, bundle renames).
    delete(engineAssetsDir)
}

// Guard: the fetch scripts must have run, or the APK silently misses the
// runtime (the exact 404 class of failure this sync replaces).
val ensureRuntimeFetched = tasks.register("ensureRuntimeFetched") {
    group = "anybuff"
    doLast {
        val manifest = runtimeAssetsDir.file("manifest.json").asFile
        if (!manifest.exists()) {
            throw GradleException(
                "assets/runtime/manifest.json missing — run android/scripts/fetch-engine-runtime.sh " +
                    "and android/scripts/fetch-proot.sh before assembling (plan §4.0, 2026-09-03 incident).",
            )
        }
        listOf(
            "libproot_exec.so", "libproot_loader.so", "libandroid-shmem.so",
        ).forEach { lib ->
            val f = layout.projectDirectory.file("src/main/jniLibs/arm64-v8a/$lib").asFile
            if (!f.exists()) {
                throw GradleException(
                    "jniLibs/arm64-v8a/$lib missing — run android/scripts/fetch-proot.sh first.",
                )
            }
        }
        if (!rootProject.file("engine-libs/libtalloc.so.2").exists()) {
            throw GradleException(
                "engine-libs/libtalloc.so.2 missing — run android/scripts/fetch-proot.sh first.",
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(ensureRuntimeFetched) }

// Register the generated dirs as extra asset sources. AGP then treats the
// Sync outputs as real asset inputs (task graph wires them automatically), so
// assembleDebug always runs the syncs first without manual dependsOn hacks.
android {
    // src/main/assets (runtime/, engine-libs/) is packaged by AGP's default
    // assets root — mounting it a second time duplicates every payload. Only
    // the generated tree needs an explicit srcDir.
    sourceSets.getByName("main").assets.srcDir(genAssetsRoot)
    // .xz runtime payloads are STORED (AAPT2 would deflate otherwise, which
    // is pointless for an already-compressed tarball). .gz must NOT be listed:
    // AAPT2 special-cases .gz assets (gunzips + strips the suffix) — the
    // rootfs therefore ships as .tgz (fetch-engine-runtime.sh).
    androidResources {
        noCompress += listOf("xz", "tgz")
    }
}

// The generated asset tree lives OUTSIDE src/main/assets, so nothing in AGP's
// default graph produces it — wire the syncs into every variant's asset merge
// explicitly (they ran "by luck" before, only when invoked standalone).
// LintVital (release-only) reads the variant's asset source set without
// running the merges, which Gradle 8 flags as an implicit dependency and
// fails assembleRelease (generate*LintVitalReportModel, lintVitalAnalyze*).
// Same wiring class as merge tasks above.
tasks.matching {
    it.name.lowercase().contains("lintvital") || it.name.matches(Regex("merge.*Assets"))
}.configureEach {
    dependsOn(syncWebAssets, syncEngineAssets)
}

// Fresh-checkout resilience: ensure output dirs exist before the syncs write.
tasks.named("preBuild").configure {
    doFirst {
        webAssetsDir.asFile.mkdirs()
        engineAssetsDir.asFile.mkdirs()
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")
    implementation("androidx.documentfile:documentfile:1.0.0")
    implementation("org.tukaani:xz:1.10")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
