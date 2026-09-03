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
val webAssetsDir = layout.projectDirectory.dir("src/main/assets/www")
val hostCoreDist = rootProject.file("../packages/host-core/dist")
val sdkDist = rootProject.file("../sdk/dist")
val engineAssetsDir = layout.projectDirectory.dir("src/main/assets/engine")

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    description = "Copy desktop/dist-web renderer build into APK assets/www"
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
    // Self-contained host bundle (host-core + inlined SDK). ws and
    // web-tree-sitter stay external (Bun keeps them as imports) — they are
    // shipped beside the bundle as plain node_modules copies + wasm assets.
    from(hostCoreDist) { include("anybuff-host.mjs") }
    from(sdkDist) {
        // sdkDist == sdk/dist; the vendored rg + wasm already live under it.
        include("vendor/ripgrep/arm64-linux/rg", "wasm/**")
    }
    into(engineAssetsDir)
    // Keep the engine dir free of files that were removed upstream (wasm set
    // changes, rg renames, bundle renames).
    delete(engineAssetsDir)
}

// Register the generated dirs as extra asset sources. AGP then treats the
// Sync outputs as real asset inputs (task graph wires them automatically), so
// assembleDebug always runs the syncs first without manual dependsOn hacks.
android {
    sourceSets.getByName("main").assets.srcDir(webAssetsDir)
    sourceSets.getByName("main").assets.srcDir(engineAssetsDir)
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
