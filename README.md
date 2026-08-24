# AnyBuff

**A local-first, bring-your-own-key (BYOK) coding agent for Windows**, built on
the [Freebuff](https://github.com/CodebuffAI/freebuff) multi-agent architecture.

AnyBuff runs the Freebuff agent runtime **entirely in-process** — no hosted
backend, no ads, no credits. You connect your own OpenAI-compatible or
Anthropic-compatible endpoints (OpenAI, Anthropic, Mistral, DeepSeek, GLM,
OpenRouter, Ollama, LM Studio, vLLM …) and pay your providers directly.

```
┌─────────────────────────── AnyBuff Desktop ───────────────────────────┐
│  Electron + React 19 UI  │  main process embeds @codebuff/sdk         │
│  chat · diff · agents    │  agent-runtime · tools · BYOK model layer  │
└──────────────────────┬─────────────────────────────────────────────────┘
                       │ apiKeyOverrides channel (never process.env)
              anybuff.json provider routing (modes → agents → default)
                       │
        Your providers: OpenAI-compatible / Anthropic-compatible
```

## Status

Pre-packaging developer preview. `bun run dev` launches the full desktop app;
installer packaging is the next milestone.

## Quick start

```powershell
bun install
bun run build:sdk     # bundle @codebuff/sdk into sdk/dist
bun run dev           # launch AnyBuff Desktop
```

First run: pick a project folder (try `desktop/demo-project`), open Settings,
add a provider (baseURL + API key — keys are DPAPI-encrypted via Electron
safeStorage), fetch models, select one, and start chatting.

## Repository layout

| Path | Purpose |
|---|---|
| `desktop/` | Electron app (main / preload / renderer), ported from a prior prototype and adapted to the workspace SDK |
| `sdk/` | `@codebuff/sdk` — in-process agent runtime with the AnyBuff BYOK layer (`provider-config.ts`, `impl/model-provider.ts`, failover/retry, followups policy, env sanitization) |
| `packages/agent-runtime` | Upstream step engine (untouched) |
| `packages/llm-providers` | Vendored AI-SDK v7 openai-compatible provider + grafted interop features |
| `common/` | Upstream shared types/tools/contracts (+ local-mode constants) |
| `agents/` | Upstream agent templates; model strings are *routing keys* resolved through anybuff.json |
| `scripts/generate-desktop-agents.ts` | Regenerates `desktop/src/main/agents/bundled-agents.ts` from upstream `agents/` with desktop patches baked in |
| `cli/` | Upstream CLI source kept on disk but OUT of the build graph (v2 candidate) |

## Key behaviors (see PLAN.md §10 ledger)

- **suggest_followups disabled by default** (`ANYBUFF_FOLLOWUPS=1` re-enables).
- **context-pruner activity hidden** in the desktop UI (still runs; zero LLM).
- **web_search** is a local DuckDuckGo implementation with SSRF guards — no key, no backend.
- Provider compat rules are data-driven and strip-only (never suppress reasoning);
  observability under `[anybuff-compat]`.
- API keys: DPAPI-encrypted at rest, delivered to the SDK through an injection
  channel, scrubbed from every child-process environment.
- Atomic config/checkpoint writes per PLAN §9.5 (fsync, rename-replace,
  never pre-delete).

## Development

```powershell
bun run build:sdk        # rebuild SDK after touching sdk/, packages/, common/
bun --cwd desktop run typecheck
cd desktop && bun test src/__tests__          # or package-local suites
bun scripts/smoke-sdk.ts # headless end-to-end BYOK check (needs a real key)
```

Upstream sync: internal packages keep their `@codebuff/*` names on purpose so
`git merge` from CodebuffAI/freebuff stays viable. Intentional deviations are
logged in PLAN.md §10.

## License

Apache-2.0 (inherited from upstream Freebuff/Codebuff). See LICENSE and NOTICE.
