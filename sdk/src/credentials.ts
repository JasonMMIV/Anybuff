import fs from 'fs'
import path from 'node:path'
import os from 'os'

import { env } from '@codebuff/common/env'
import { userSchema } from '@codebuff/common/util/credentials'
import { z } from 'zod/v4'

import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { User } from '@codebuff/common/util/credentials'

const credentialsFileSchema = z.object({
  default: userSchema.optional(),
})

/**
 * Ensure the config directory exists with owner-only permissions (0700).
 * The credentials file holds provider API keys, so the containing directory
 * must not be group/world readable. Existing dirs are tightened best-effort.
 */
const ensureDirectoryExistsSync = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // mkdir mode is masked by umask on some platforms; chmod is a
      // best-effort enforcement and can fail on exotic filesystems.
    }
  }
}

export const userFromJson = (json: string): User | null => {
  try {
    const credentials = credentialsFileSchema.parse(JSON.parse(json))
    return credentials.default ?? null
  } catch {
    return null
  }
}

/**
 * Get the config directory path based on the environment.
 *
 * Resolution order:
 * 1. ANYBUFF_CONFIG_DIR (explicit override, also used by tests)
 * 2. %APPDATA%\anybuff (Windows)
 * 3. $XDG_CONFIG_HOME/anybuff
 * 4. ~/.config/anybuff
 */
type ConfigPathEnv = ClientEnv & {
  ANYBUFF_CONFIG_DIR?: string
  XDG_CONFIG_HOME?: string
  APPDATA?: string
}

export const getConfigDir = (clientEnv: ClientEnv = env): string => {
  const configEnv = clientEnv as Partial<ConfigPathEnv>
  if (configEnv.ANYBUFF_CONFIG_DIR) return configEnv.ANYBUFF_CONFIG_DIR
  if (process.platform === 'win32' && configEnv.APPDATA) {
    return path.join(configEnv.APPDATA, 'anybuff')
  }
  if (configEnv.XDG_CONFIG_HOME) {
    return path.join(configEnv.XDG_CONFIG_HOME, 'anybuff')
  }
  return path.join(os.homedir(), '.config', 'anybuff')
}

export const ensureConfigDirExists = (clientEnv: ClientEnv = env): string => {
  const dir = getConfigDir(clientEnv)
  ensureDirectoryExistsSync(dir)
  return dir
}

/**
 * Get the credentials file path based on the environment.
 */
export const getCredentialsPath = (clientEnv: ClientEnv = env): string => {
  return path.join(getConfigDir(clientEnv), 'credentials.json')
}

export const getUserCredentials = (clientEnv: ClientEnv = env): User | null => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  try {
    const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
    const user = userFromJson(credentialsFile)
    return user || null
  } catch (error) {
    // Redact raw error details: parse errors may embed file contents.
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 120)}${error.message.length > 120 ? '…' : ''}`
        : 'unknown error'
    console.error('Error reading credentials file:', detail)
    return null
  }
}
