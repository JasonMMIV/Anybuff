# Anybuff

[English](./README.md) | 繁體中文

**自帶金鑰（BYOK）的 Windows 編程代理**，基於 [Freebuff](https://github.com/CodebuffAI/freebuff) 多智能體架構。

Anybuff 在本機完整執行 Freebuff 智能體運行時——無後端、無廣告、無點數。連接你自己的 OpenAI 相容或 Anthropic 相容端點——雲端 API（OpenAI、Anthropic、Mistral、DeepSeek、GLM、OpenRouter 等）或全本地端點（Ollama、LM Studio、vLLM）——直接向你的供應商付費。

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

## 截圖

![Anybuff 歡迎畫面](docs/screenshots/welcome.jpg)

歡迎畫面：選擇專案資料夾，連接任何 OpenAI 相容或 Anthropic 相容的
provider，即可開始對話。

## 功能

- **多智能體引擎（承襲 Freebuff）** —— Freebuff 以專門化智能體取代「把每個任務交給單一模型與單一 prompt」的做法：依任務不同，智能體會收集脈絡、規劃、編輯或研究、執行工具，並審查成果。AnyBuff 在本機完整執行這套引擎。
- **BYOK（自帶金鑰）** —— 無後端、無訂閱：連接你自己的 OpenAI 相容／Anthropic 相容端點（雲端或全本地，如 Ollama、LM Studio、vLLM），直接向你的供應商付費。
- **三種模式** —— Chat（輕量問答）、Build（完整檔案存取）、Plan（規劃不寫檔）；`@agent` 提及會在目前的 root 內 spawn 子代理。
- **安全防線** —— 敏感檔案過濾（絕不讀取 `.env`、`*.pem`、`*.key`、`id_rsa`、`kubeconfig` 等）、終端指令核准閘門、執行中訊息佇列。
- **Web 搜尋** —— 可切換 provider：DuckDuckGo（預設、免 key）、Firecrawl（免 key）、Tinyfish（需 API key）；provider 被限流時自動 fallback。
- **MCP 伺服器** —— 於設定頁管理 stdio/http/sse 伺服器、`.agents/mcp.json` 三層掃描（專案 → 父目錄 → 家目錄）、per-server 目標 agent、行內 token 以 DPAPI 加密。
- **上下文管理** —— 預防性壓縮加上反應式 overflow trim-retry、模型 failover 與快照 resume。
- **對話匯出** —— 從側邊欄選單即可將整段對話存成 Markdown 檔。
- **檔案預覽與執行回饋** —— 點擊檔案即浮動預覽並附快速動作、執行中的任務
  顯示已耗時間、任務結束/暫停/中斷時播放輕柔提示音。

## 快速開始

1. 從[最新 release](https://github.com/JasonMMIV/Anybuff/releases/latest)
   下載 **`AnyBuff-Setup-<version>.exe`**（目前最新已發佈版本為 **v1.2.0**）
   並執行。安裝包未簽章，SmartScreen 會顯示「不明發行者」——點選
   *更多資訊 → 仍要執行*。安裝後由 electron-updater（GitHub Releases
   provider）自動偵測並安裝更新。
2. 選擇專案資料夾（可試 `desktop/demo-project`），打開設定，
   新增 provider（填 baseURL + API key——金鑰經 Electron safeStorage 以
   DPAPI 加密儲存），取得模型清單，選擇模型，即可開始對話。
   並可於輸入框切換 Chat / Build / Plan 模式。

## 安全

存在 Anybuff 設定內的 provider 金鑰靜態以 DPAPI 加密。這**不及於**
專案內的檔案——請勿在開啟的專案中存放未加密的憑證
（`.env`、`*.pem`、`*.key`、`id_rsa`、`kubeconfig` 等）。

## 倉儲結構

| 路徑                                   | 用途                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop/`                           | Windows Electron 應用（React 19 renderer；main 為薄殼——視窗/對話框/updater/theme——業務頻道經 `host-bridge.ts` 委派 `packages/host-core`）                                  || `android/`                           | Android（arm64）Kotlin 薄殼：WebView renderer + proot sandbox 內以 Node 22 執行同一份 host bundle、Keystore 金鑰保管（ADR-21） |
| `packages/host-core`                 | `@codebuff/host-core` —— 無 Electron 依賴的 host 業務邏輯（run 生命週期、`AnyBuff:*` 頻道/WS、設定、secret-store 接縫），桌面與 Android 共用（ADR-21）                                |
| `sdk/`                               | `@codebuff/sdk` —— 內嵌 Anybuff BYOK 層的進程內 agent runtime（`provider-config.ts`、`impl/model-provider.ts`、failover/retry、followups policy、env sanitization） |
| `packages/agent-runtime`             | 上游步驟引擎（兩處已登記的 AnyBuff 分歧：ADR-22、ADR-24）                                                                                                                |
| `packages/llm-providers`             | 內嵌 AI-SDK v7 openai-compatible provider + 移植的互操作功能                                                                                                     |
| `packages/code-map`                  | 程式碼索引與符號結構分析                                                                                                                                           |
| `common/`                            | 上游共用類型/工具/契約（+ local-mode 常量）                                                                                                                          |
| `agents/`                            | 上游 agent 模板；模型字串是經 anybuff.json 解析的*路由鍵*                                                                                                               |
| `scripts/generate-desktop-agents.ts` | 從上游 `agents/` 重新產生 `packages/host-core/src/agents/bundled-agents.ts`（含 AnyBuff 修補；桌面 + Android 共用單一產物，ADR-21）                                          |
| `cli/`                               | 上游 CLI 原始碼保留在磁碟但不在建置圖中（僅供歷史參考）                                                                                                                         |

## 開發

供貢獻者從原始碼建置（一般使用者只需安裝檔）：

```powershell
bun install                     # 變更 workspace/package.json 後執行
bun run build:sdk               # 修改 sdk/、packages/、common/ 後重建 SDK
bun run build:host-core         # 修改 packages/host-core/ 後重建 host-core
bun run typecheck:host-core
bun run typecheck:desktop
bun run test:host-core          # host-core 頻道/WS 契約測試
bun --cwd desktop test src/__tests__   # desktop renderer/main 測試
bun run smoke:host-core         # 無頭冒煙測試（不需 Electron）
cd sdk && bun test src/impl/__tests__ src/__tests__/followups-policy.test.ts
bun run smoke:sdk               # 無頭端到端 BYOK 檢查（需真實 key）
bun run dev                     # 桌面開發（經 dev launcher 啟動 electron-vite）
bun run ci                      # 完整鏈：建置 + 型別檢查 + 測試
```

發佈 Release 時務必附上 `exe + .blockmap + latest.yml` 三個檔案——
electron-updater 缺一即無法偵測更新（後兩者由 electron-builder 自動產生）。

上游同步：內部套件刻意保留 `@codebuff/*` 名稱，使 `git merge`
CodebuffAI/freebuff 保持可行。

## 授權

Apache-2.0（沿襲上游 Freebuff/Codebuff）。詳見 LICENSE 與 NOTICE。
