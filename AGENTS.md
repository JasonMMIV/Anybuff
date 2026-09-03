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
  SDK side: `provider-config.ts`. Host side (shared desktop+Android):
  `packages/host-core/src/files/atomic-write.ts`.
- **Compat rules have expiry dates** (§2 non-negotiable #5): verify against live vendor
  behavior before touching the deepseek/glm tool_choice list or stop-strip
  defaults; observability logs use the `[anybuff-compat]` prefix.

## Build & verify loop

```powershell
bun install                 # after workspace/package.json changes
bun run build:sdk           # REQUIRED after sdk|packages|common edits (desktop consumes dist/)
bun run build:host-core     # REQUIRED after packages/host-core edits (ADR-21: desktop consumes dist/)
bun run typecheck:host-core
bun --cwd desktop run typecheck
bun run test:host-core      # host-core channel/WS contract tests
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
- `packages/host-core/` — headless host business logic shared by the Electron
  desktop shell and (Phase B) the Android proot-Node shell (ADR-21). Never
  imports Electron; shells inject HostPaths/SecretStore/EventSink via
  `installHostEnv()` (`src/env.ts`, `src/events.ts`). Key modules (moved from
  desktop/src/main):
  - `src/run/start-run.ts` — run lifecycle, approval gate wiring,
    SILENT_AGENT_TYPES (context-pruner hidden), followups policy via SDK.
  - `src/settings/settings.ts` — DPAPI-mandatory key storage behind the
    SecretStore seam (ADR-11), getProviderApiKeyOverrides, self-healing
    model-id normalization.
  - `src/channels/` — channel registry + dispatcher (single source of truth
    for the AnyBuff:* business channels), `src/server/ws-server.ts` WS host.
- `desktop/src/main/host-bridge.ts` — Electron shell adapter: installs the
  host env (app.getPath + safeStorage), attaches the window EventSink, and
  registers ipcMain.handle over host-core CHANNELS (M-A4). `index.ts` keeps
  only window/dialog/updater/theme shell handlers.
- `scripts/generate-desktop-agents.ts` — regenerates the bundled agents into
  `packages/host-core/src/agents/bundled-agents.ts` (ADR-21: single artifact
  consumed by desktop + Android); bakes tool-surface patches
  (run_terminal_command/web_search/code_search/update_subgoal/think_deeply on
  base family), prompt discipline, and the AnyBuff prompt scrub (gravity_index
  copy + Codebuff/Freebuff meta removed, ADR-19). base-chat is re-bundled as
  the AnyBuff Chat root — UI mode 'chat' → AGENT_ID_FOR_MODE['chat'] =
  'base-chat' (see host-core/src/run/start-run.ts) — with a lightweight
  no-filesystem tool surface (web_search/read_url/render_ui/spawn_agents) and
  rewritten Buffy prompts (patch #7). Re-run it after every upstream agents/
  sync.

## Known debts (do not silently re-add)

- `cli/` source is on disk but out of the build graph (not maintained).
- Hosted-semantics tests are skipped or rewritten-as-local
  (`it.skip` blocks in sdk tests carry context).
- Fork's ChatGPT/Codex OAuth, harness services, PTD tiers were intentionally
  not ported — do not reintroduce without an ADR.
