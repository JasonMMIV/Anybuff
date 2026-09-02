# AnyBuff — agent guide

AnyBuff = upstream Freebuff architecture + a minimal local-first BYOK layer +
an Electron desktop shell. Read "AnyBuff 專案全貌與維護者指南.md" (§2 non-negotiables,
§4 ADRs, §5 maintenance ledger, §8 appendices) before making architectural changes.

## Non-negotiables

- **Upstream mergeability**: internal packages keep `@codebuff/*` names. Never
  bulk-rename symbols/paths; PowerShell `-replace` is case-insensitive and has
  already caused three regressions (see git log "Review round 1").
- **只清除、不抑制** (ADR-10): provider compat layers may strip parameters an
  endpoint rejects; they must never actively suppress native reasoning
  (no `thinking:{type:'disabled'}` injection).
- **Keys never enter process.env** (ADR-12): Desktop decrypts →
  `apiKeyOverrides` → SDK injection channel. Child processes get scrubbed env
  (`impl/env-sanitize.ts`). Don't add new spawns that bypass it.
- **Atomic writes** (ADR-13): unique same-dir temp + fsync +
  rename-replace; never pre-delete targets; preserve old file on failure.
  SDK side: `provider-config.ts`. Desktop side: `desktop/src/main/atomic-write.ts`.
- **Compat rules have expiry dates** (§2 non-negotiable #5): verify against live vendor
  behavior before touching the deepseek/glm tool_choice list or stop-strip
  defaults; observability logs use the `[anybuff-compat]` prefix.

## Build & verify loop

```powershell
bun install                 # after workspace/package.json changes
bun run build:sdk           # REQUIRED after sdk|packages|common edits (desktop consumes dist/)
bun --cwd desktop run typecheck
cd sdk && bun test src/impl/__tests__ src/__tests__/followups-policy.test.ts
cd packages/agent-runtime && bun test src/__tests__/web-search-local.test.ts
```

Desktop dev: root `bun run dev` → routes through
`desktop/scripts/dev-launcher.mjs`, which MUST seed the NEXT_PUBLIC_* env
defaults before electron-vite boots (ESM evaluates external deps before any
module body; an in-bundle shim cannot satisfy common/env validation).

## Architecture map

- `sdk/src/provider-config.ts` — anybuff.json schema/loader/router/writer
  (modes→agents→defaultModel routing, capabilities, presets, atomic writers).
- `sdk/src/impl/model-provider.ts` — BYOK resolution + keyMap injection
  (`setProviderApiKeyOverrides`) + compat rules v1.3 (§9.2.1 verification table).
- `sdk/src/impl/llm.ts` — two-tier retry/failover (§9.1), zero-output gate via
  StreamAttemptFlags {content, toolCall, reasoning}, pricing cost fallback,
  reasoningEffort namespace injection.
- `sdk/src/impl/local-database.ts` — hosted-backend stubs; run.ts imports from
  here, never from impl/database.ts.
- `desktop/src/main/start-run.ts` — run lifecycle, approval gate wiring,
  SILENT_AGENT_TYPES (context-pruner hidden), followups policy consumed via SDK.
- `desktop/src/main/settings.ts` — DPAPI-mandatory key storage (ADR-11),
  getProviderApiKeyOverrides, self-healing model-id normalization.
- `scripts/generate-desktop-agents.ts` — regenerates desktop bundled agents;
  bakes tool-surface patches (run_terminal_command/web_search/code_search/
  update_subgoal/think_deeply on base family), prompt discipline, and the
  AnyBuff prompt scrub (gravity_index copy + Codebuff/Freebuff meta removed,
  ADR-19) + base-chat bundle exclusion. Re-run it after every upstream
  agents/ sync.

## Known debts (do not silently re-add)

- `cli/` source is on disk but out of the build graph (not maintained).
- Hosted-semantics tests are skipped or rewritten-as-local
  (`it.skip` blocks in sdk tests carry context).
- Fork's ChatGPT/Codex OAuth, harness services, PTD tiers were intentionally
  not ported — do not reintroduce without an ADR.
