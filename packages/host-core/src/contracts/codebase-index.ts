export type QueryIndexMode = 'search' | 'neighbors' | 'path' | 'explain' | 'commands' | 'references' | string

export interface QueryIndexQuery {
  query?: string
  limit?: number
  fileTypes?: string[]
  pathPrefixes?: string[]
  mode?: QueryIndexMode
  from?: string
  to?: string
}

export interface QueryIndexRelatedFile {
  path: string
  score?: number
  reason?: string
  via?: string
}

export interface QueryIndexResult {
  path: string
  indexedHash?: string
  score?: number
  matchedOn?: string[]
  symbols?: string[]
  headings?: string[]
  matchedSnippets?: string[]
  relatedFiles?: QueryIndexRelatedFile[]
  explanation?: string
}

export interface QueryIndexStatus {
  state?: string
  ready?: boolean
  stale?: boolean
  refreshing?: boolean
  semantic?: string
  totalIndexed?: number
  indexAge?: number
  diagnostics?: Array<{ filePath?: string; stage?: string; message?: string }>
  coverage?: {
    truncated?: boolean
    maxFiles?: number
    skippedFiles?: number
    skippedPrefixes?: string[]
    parser?: {
      requestedFiles?: number
      parsedFiles?: number
      skippedFiles?: number
      skippedLanguages?: string[]
      truncated?: boolean
    }
  }
  lastBuildError?: { stage?: string; message?: string; retryable?: boolean }
  message?: string
}

export interface QueryIndexSnapshot {
  schemaVersion?: number
  snapshotId?: string
  indexVersion?: string
  builtAt?: number
  workspaceRevision?: string | number
}

export interface QueryIndexData {
  kind?: string
  schemaVersion?: number
  results: QueryIndexResult[]
  totalIndexed?: number
  indexAge?: number
  snapshot?: QueryIndexSnapshot
  status?: QueryIndexStatus
  message?: string
}
