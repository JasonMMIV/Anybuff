# Anybuff

[English](./README.md) | 繁體中文

**自帶金鑰（BYOK）的 Windows 編程代理**，基於 [Freebuff](https://github.com/CodebuffAI/freebuff) 多智能體架構。

Anybuff 在本機完整執行 Freebuff 智能體運行時——無後端、無廣告、無點數。連接你自己的 OpenAI 相容或 Anthropic 相容端點——雲端 API（OpenAI、Anthropic、Mistral、DeepSeek、GLM、OpenRouter 等）或全本地端點（Ollama、LM Studio、vLLM）——直接向你的供應商付費。

```
┌─────────────────────────── Anybuff Desktop ───────────────────────────┐
│  Electron + React 19 UI  │  main process embeds @codebuff/sdk         │
│  chat · diff · agents    │  agent-runtime · tools · BYOK model layer  │
└──────────────────────┬─────────────────────────────────────────────────┘
                       │ apiKeyOverrides channel (never process.env)
              anybuff.json provider routing (modes → agents → default)
                       │
        Your providers: OpenAI-compatible / Anthropic-compatible
```

## 截圖

![Anybuff 歡迎畫面](docs/screenshots/welcome.jpg)

歡迎畫面：選擇專案資料夾，連接任何 OpenAI 相容或 Anthropic 相容的
provider，即可開始對話。

## 快速開始

1. 從[最新 release](https://github.com/JasonMMIV/Anybuff/releases/latest)
   下載 **`AnyBuff-Setup-<version>.exe`**（目前 **v0.1.0-beta.3**）並執行。
   安裝包未簽章，SmartScreen 會顯示「不明發行者」——點選
   *更多資訊 → 仍要執行*。（歡迎畫面如上圖。）
2. 選擇專案資料夾（可試 `desktop/demo-project`），打開設定，
   新增 provider（填 baseURL + API key——金鑰經 Electron safeStorage 以
   DPAPI 加密儲存），取得模型清單，選擇模型，即可開始對話。

## 安全

存在 Anybuff 設定內的 provider 金鑰靜態以 DPAPI 加密。這**不及於**
專案內的檔案——請勿在開啟的專案中存放未加密的憑證
（`.env`、`*.pem`、`*.key`、`id_rsa`、`kubeconfig` 等）。

## 倉儲結構

| 路徑 | 用途 |
|---|---|
| `desktop/` | Electron 應用（main / preload / renderer），自先前原型移植並適配 workspace SDK |
| `sdk/` | `@codebuff/sdk` — 內嵌 Anybuff BYOK 層的進程內 agent runtime（`provider-config.ts`、`impl/model-provider.ts`、failover/retry、followups policy、env sanitization） |
| `packages/agent-runtime` | 上游步驟引擎（未動） |
| `packages/llm-providers` | 內嵌 AI-SDK v7 openai-compatible provider + 移植的互操作功能 |
| `common/` | 上游共用類型/工具/契約（+ local-mode 常量） |
| `agents/` | 上游 agent 模板；模型字串是經 anybuff.json 解析的*路由鍵* |
| `scripts/generate-desktop-agents.ts` | 從上游 `agents/` 重新產生 `packages/host-core/src/agents/bundled-agents.ts`（含 AnyBuff 修補；桌面 + Android 共用單一產物，ADR-21） |
| `cli/` | 上游 CLI 原始碼保留在磁碟但不在建置圖中（v2 候選） |

## 關鍵行為

- **suggest_followups 預設停用**（設 `ANYBUFF_FOLLOWUPS=1` 可重新啟用）。
- **context-pruner 活動在桌面 UI 中隱藏**（仍正常運作；零 LLM 呼叫）。
- **web_search** 是本地 DuckDuckGo 實作，含 SSRF 防護——免 key、無後端。
- Provider 相容性規則為資料驅動、只清除不抑制（絕不抑制推理）；
  觀測日誌使用 `[anybuff-compat]` 前綴。
- API 金鑰：靜態以 DPAPI 加密，經注入通道交付 SDK，
  並從所有子程序環境中清洗移除。
- 設定檔/檢查點原子寫入（fsync、rename-replace、永不預先刪除）。

## 開發

供貢獻者從原始碼建置（一般使用者只需安裝檔）：

```powershell
bun run build:sdk        # 修改 sdk/、packages/、common/ 後重建 SDK
bun --cwd desktop run typecheck
cd desktop && bun test src/__tests__          # 或各套件本地測試
bun scripts/smoke-sdk.ts # 無頭端到端 BYOK 檢查（需真實 key）
```

上游同步：內部套件刻意保留 `@codebuff/*` 名稱，使 `git merge`
CodebuffAI/freebuff 保持可行。

## 授權

Apache-2.0（沿襲上游 Freebuff/Codebuff）。詳見 LICENSE 與 NOTICE。
