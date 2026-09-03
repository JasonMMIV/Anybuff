/**
 * Compatibility shim (ADR-21): the query-index contract types moved into
 * @codebuff/host-core/src/contracts/codebase-index.ts when the shared host
 * logic was extracted. Desktop preload/renderer imports re-export from there
 * so the desktop and Android shells share one source of truth.
 */
export type {
  QueryIndexMode,
  QueryIndexQuery,
  QueryIndexRelatedFile,
  QueryIndexResult,
  QueryIndexStatus,
  QueryIndexSnapshot,
  QueryIndexData,
} from '@codebuff/host-core'
