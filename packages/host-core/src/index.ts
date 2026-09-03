/**
 * @codebuff/host-core — headless host shared by the Electron desktop shell
 * and (Phase B) the Android proot-Node shell (ADR-21). No Electron import
 * anywhere below; shells inject HostPaths / SecretStore / an event sink
 * through installHostEnv() and bridge the channel registry.
 */

/* Host environment seams (shell-injected) */
export * from './env'
export * from './events'

/* Pure contract types (single source of truth for the AnyBuff:* channels) */
export * from './contracts'

/* Business modules extracted from desktop/src/main (M-A1) */
export * from './run/start-run'
export * from './sessions/session-store'
export * from './settings/settings'
export * from './mcp/mcp-settings'
export * from './agents/local-agents'
export * from './agents/bundled-agents'
export * from './files/file-filter'
export * from './files/fs-utils'
export * from './files/atomic-write'

/* Channel dispatcher + WS server (M-A2) */
export * from './channels'
export * from './server/ws-server'
