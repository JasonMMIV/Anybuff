// Copies the win32 ripgrep binary into build/bin/rg.exe so electron-builder can
// mount it via extraResources. The SDK's getBundledRgPath() honors CODEBUFF_RG_PATH,
// which the main process sets to <install>/resources/bin/rg.exe when packaged.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(scriptsDir, '..')
const repoRoot = join(desktopRoot, '..')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error(`[pre-dist] Unsupported platform: ${process.platform}-${process.arch}. This packaging step targets Windows x64 only.`)
  process.exit(1)
}

const candidates = [
  join(repoRoot, 'sdk', 'dist', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe'),
  join(repoRoot, 'sdk', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe')
]

const source = candidates.find((p) => existsSync(p))
if (!source) {
  console.error(
    '[pre-dist] ripgrep binary not found. Run:\n' +
      '  cd sdk && bun run fetch-ripgrep && bun run build\n' +
      'Tried:\n  ' +
      candidates.join('\n  ')
  )
  process.exit(1)
}

const destDir = join(desktopRoot, 'build', 'bin')
mkdirSync(destDir, { recursive: true })
copyFileSync(source, join(destDir, 'rg.exe'))
console.log(`[pre-dist] Copied ${source} -> ${join(destDir, 'rg.exe')}`)
