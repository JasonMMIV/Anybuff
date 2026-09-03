// Build script for @codebuff/host-core using Bun's bundler — dual ESM + CJS
// output with bundled TypeScript declarations (mirrors the SDK's build).
//
// host-core depends only on the already-built @codebuff/sdk dist (externalized,
// like the desktop electron-vite main build) plus node built-ins and `ws`.
// The ESM/CJS dist pair is consumed by:
//   - the Electron main process (via desktop's rollup externalization),
//   - the Android sandbox Node 22 runtime (plain node import),
//   - contract tests (bun).

import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import { generateDtsBundle } from 'dts-bundle-generator'

async function build() {
  console.log('🧹 Cleaning dist directory...')
  await rm('dist', { recursive: true, force: true })
  await mkdir('./dist', { recursive: true })

  const pkgText = await Bun.file('./package.json').text()
  const pkg = JSON.parse(pkgText)
  const external = [
    // npm dependencies (never workspace packages)
    ...Object.keys(pkg.dependencies || {}).filter((dep) => !dep.startsWith('@codebuff/')),
    // Node.js built-ins + ws optional peers
    'fs', 'fs/promises', 'path', 'child_process', 'os', 'crypto', 'stream', 'util',
    'http', 'https', 'net', 'tls', 'url', 'events', 'buffer', 'string_decoder',
    'ws', 'bufferutil', 'utf-8-validate', 'assert', 'module', 'zlib', 'perf_hooks',
  ]

  console.log('📦 Building ESM format...')
  const esm = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'linked',
    external,
    naming: '[dir]/index.mjs',
    env: 'NEXT_PUBLIC_*',
    loader: { '.scm': 'text' },
  })
  if (!esm.success) throw new AggregateError(esm.logs, 'ESM build failed')

  console.log('📦 Building CJS format...')
  const cjs = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'cjs',
    minify: false,
    sourcemap: 'linked',
    external,
    naming: '[dir]/index.cjs',
    define: { 'import.meta.url': 'undefined', 'import.meta': 'undefined' },
    env: 'NEXT_PUBLIC_*',
    loader: { '.scm': 'text' },
  })
  if (!cjs.success) throw new AggregateError(cjs.logs, 'CJS build failed')

  console.log('📦 Building self-contained host bundle (Android sandbox / browser preview)...')
  // The sandbox Node 22 runtime has no node_modules for @codebuff/* or ws, so
  // anybuff-host.mjs inlines everything except node built-ins. Bundling `ws`
  // pulls in bufferutil/utf-8-validate as optional peers (harmless) but those
  // need native builds — keep them external so ws falls back to JS.
  const hostBundle = await Bun.build({
    entrypoints: ['src/server/anybuff-host.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    external: [
      // Node.js built-ins + the native-adjacent modules that must stay as real
      // node_modules files (Bun inlining them breaks emscripten glue / native
      // peer resolution). web-tree-sitter ships a wasm + emscripten runtime
      // that does not survive bundling — the SDK itself externalizes it.
      'node:*',
      'fs', 'fs/promises', 'path', 'child_process', 'os', 'crypto', 'stream', 'util',
      'http', 'https', 'net', 'tls', 'url', 'events', 'buffer', 'string_decoder',
      'assert', 'module', 'zlib', 'perf_hooks', 'bufferutil', 'utf-8-validate',
      'web-tree-sitter',
    ],
    naming: '[dir]/anybuff-host.mjs',
    env: 'NEXT_PUBLIC_*',
    loader: { '.scm': 'text' },
  })
  if (!hostBundle.success) throw new AggregateError(hostBundle.logs, 'host bundle failed')
  console.log('  ✓ dist/anybuff-host.mjs')


  console.log('📝 Generating and bundling TypeScript declarations...')
  try {
    const [bundle] = generateDtsBundle(
      [
        {
          filePath: 'src/index.ts',
          output: { exportReferencedTypes: false },
          libraries: {
            // Workspace packages resolve to their source at type time.
            importedLibraries: ['@codebuff/common', '@codebuff/sdk'],
          },
        },
      ],
      { preferredConfigPath: 'tsconfig.build.json' },
    )
    await writeFile('dist/index.d.ts', bundle)
    console.log('  ✓ Created bundled type definitions')
  } catch (error) {
    console.error('❌ TypeScript declaration bundling failed:', (error as Error).message)
    process.exit(1)
  }

  console.log('✅ host-core build complete!')
  console.log('  📄 dist/index.mjs (ESM)')
  console.log('  📄 dist/index.cjs (CJS)')
  console.log('  📄 dist/index.d.ts (Types)')
}

if (import.meta.main) {
  build().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
