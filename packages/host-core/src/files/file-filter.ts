/**
 * Sensitive-file filter (#1 資安級缺口).
 *
 * AnyBuff stores provider keys DPAPI-encrypted (ADR-11), but credentials living
 * inside the project tree (`.env`, SSH keys, kubeconfig, …) were previously
 * fully readable by the agent and would leave the machine inside the LLM
 * context. This module ports the upstream CLI's `isSensitiveFile` heuristics
 * into the desktop main process and is wired into `CodebuffClient.run()` via
 * the SDK's `fileFilter` option (which runs before the gitignore check and
 * also guards `requestOptionalFile`).
 */
import { basename as posixBasename, extname } from 'path'

import { isSensitiveEnvFilePath } from '@codebuff/common/util/env-file-path'

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer'
])

const SENSITIVE_BASENAMES = new Set([
  '.htpasswd',
  '.netrc',
  'credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'auth.json',
  '.pypirc',
  'terraform.tfvars',
  '.terraformrc'
])

// Pattern matches (grouped by match type)
const SENSITIVE_PATTERNS = {
  prefix: ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'], // SSH private keys
  suffix: ['_credentials'],
  substring: ['kubeconfig', '.tfstate']
}

function matchesPattern(str: string): boolean {
  return (
    SENSITIVE_PATTERNS.prefix.some((p) => str.startsWith(p) && !str.endsWith('.pub')) ||
    SENSITIVE_PATTERNS.suffix.some((s) => str.endsWith(s)) ||
    SENSITIVE_PATTERNS.substring.some((sub) => str.includes(sub))
  )
}

/**
 * Check if a file is a sensitive file that should be blocked from reading.
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = posixBasename(filePath)
  const basenameLower = name.toLowerCase()
  const ext = extname(filePath).toLowerCase()

  return (
    isSensitiveEnvFilePath(filePath) ||
    SENSITIVE_EXTENSIONS.has(ext) ||
    SENSITIVE_BASENAMES.has(basenameLower) ||
    matchesPattern(basenameLower)
  )
}
