plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.anybuff.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anybuff.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 10000
        versionName = "1.0.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    description = "Copy desktop/dist-web renderer build into generated APK assets/www"
    group = "anybuff"
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
tasks.matching { it.name.matches(Regex("merge.*Assets")) }.configureEach {
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
