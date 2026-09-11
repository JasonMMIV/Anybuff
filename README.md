# Anybuff

[English](./README.md) | [繁體中文](./README.zh-TW.md)

**A bring-your-own-key (BYOK) coding agent for Windows**, built on the
[Freebuff](https://github.com/CodebuffAI/freebuff) multi-agent architecture.

Anybuff runs the Freebuff agent runtime **entirely in-process** — no hosted
backend, no ads, no credits. You connect your own OpenAI-compatible or
Anthropic-compatible endpoints — cloud APIs (OpenAI, Anthropic, Mistral,
DeepSeek, GLM, OpenRouter …) or fully local ones (Ollama, LM Studio, vLLM) —
and pay your providers directly.

```
┌──────────────── Anybuff Desktop (Electron + React 19) ─────────────────┐
│       chat · diff · settings · thin main shell (window, updater)       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
┌────────────── Anybuff Android (Kotlin + WebView, arm64) ───────────────┐
│    WebView renderer · Keystore vault · proot sandbox → Node 22 host    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │  three shared tiers: renderer · host logic · engine
                                     ▼
┌───── host-core + @codebuff/sdk (shared host logic & BYOK runtime) ─────┐
│    run lifecycle · channels · settings · agent-runtime · BYOK layer    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │  apiKeyOverrides channel (never process.env)
                                     │  anybuff.json provider routing (modes → agents → default)
                                     ▼
                  Your providers: OpenAI-compatible / Anthropic-compatible
```

## Screenshot

![Anybuff welcome screen](docs/screenshots/welcome.jpg)

The welcome screen: pick a project folder, connect any OpenAI-compatible or
Anthropic-compatible provider, and start chatting.

## Features

- **Multi-agent engine (from Freebuff)** — Freebuff uses specialized agents
  instead of sending every task through one model and one prompt: depending
  on the task, agents gather context, plan, edit or research, run tools, and
  review the result. AnyBuff runs this engine entirely in-process on your
  machine.
- **Bring your own key (BYOK)** — no hosted backend or subscriptions: connect
  your own OpenAI-compatible or Anthropic-compatible endpoints — cloud or
  fully local (Ollama, LM Studio, vLLM) — and pay your providers directly.
- **Three modes** — Chat (lightweight Q&A), Build (full file access), Plan
  (planning without writes); `@agent` mentions spawn sub-agents inside the
  running root.
- **Safety rails** — sensitive-file filter (never reads `.env`, `*.pem`,
  `*.key`, `id_rsa`, `kubeconfig`, …), terminal-command approval gate, and a
  message queue while a run is active.
- **Web search** — switchable providers: DuckDuckGo (default, keyless),
  Firecrawl (keyless), Tinyfish (API key); automatic fallback when the active
  provider is rate-limited.
- **MCP servers** — manage stdio/http/sse servers in Settings, 3-tier
  `.agents/mcp.json` scan (project → parent → home), per-server target
  agents, DPAPI-encrypted inline tokens.
- **Context management** — proactive compaction plus reactive overflow
  trim-retry, model failover, and snapshot resume.
- **Conversation export** — save the entire conversation as a Markdown file
  from the sidebar menu.
- **File preview & run feedback** — click a file for a floating preview with
  quick actions, watch elapsed time on running tasks, and get a gentle
  notification sound when a run finishes, pauses, or is interrupted.

## Quick start

1. Download **`AnyBuff-Setup-<version>.exe`** (latest published release:
   **v1.2.1**) from the
   [latest release](https://github.com/JasonMMIV/Anybuff/releases/latest) and
   run it. The installer is unsigned, so SmartScreen shows "Unknown publisher"
   — click *More info → Run anyway*. After installation, updates are detected
   and applied automatically by electron-updater (GitHub Releases provider).
2. Pick a project folder (try `desktop/demo-project`), open Settings, add a
   provider (baseURL + API key — keys are DPAPI-encrypted via Electron
   safeStorage), fetch models, select one, and start chatting. Switch between
   Chat / Build / Plan modes from the composer.

## Security

The provider keys stored in Anybuff's settings are DPAPI-encrypted at rest.
This does **not** extend to files inside your projects — keep unencrypted
credentials (`.env`, `*.pem`, `*.key`, `id_rsa`, `kubeconfig`, …) out of any
project you open.

## Repository layout

| Path                                 | Purpose                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/`                           | Windows Electron app (React 19 renderer; thin main shell for window/dialog/updater/theme, business channels delegated to `packages/host-core` via `host-bridge.ts`)         |
| `android/`                           | Android (arm64) Kotlin thin shell: WebView renderer + proot sandbox running Node 22 with the same host bundle, Keystore secret vault (ADR-21)                               |
| `packages/host-core`                 | `@codebuff/host-core` — Electron-free host business logic (run lifecycle, `AnyBuff:*` channels/WS, settings, secret-store seam) shared by desktop and Android (ADR-21)      |
| `sdk/`                               | `@codebuff/sdk` — in-process agent runtime with the Anybuff BYOK layer (`provider-config.ts`, `impl/model-provider.ts`, failover/retry, followups policy, env sanitization) |
| `packages/agent-runtime`             | Upstream step engine (two registered AnyBuff divergences: ADR-22, ADR-24)                                                                                                   |
| `packages/llm-providers`             | Vendored AI-SDK v7 openai-compatible provider + grafted interop features                                                                                                    |
| `packages/code-map`                  | Code indexing and symbol-structure analysis                                                                                                                                 |
| `common/`                            | Upstream shared types/tools/contracts (+ local-mode constants)                                                                                                              |
| `agents/`                            | Upstream agent templates; model strings are *routing keys* resolved through anybuff.json                                                                                    |
| `scripts/generate-desktop-agents.ts` | Regenerates `packages/host-core/src/agents/bundled-agents.ts` from upstream `agents/` with AnyBuff patches baked in (single artifact shared by desktop + Android, ADR-21)   |
| `cli/`                               | Upstream CLI source kept on disk but OUT of the build graph (historical reference only)                                                                                     |

## License

Apache-2.0 (inherited from upstream Freebuff/Codebuff). See LICENSE and NOTICE.
