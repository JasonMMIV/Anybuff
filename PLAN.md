# Anybuff 實作計畫書

> 版本：v2.1（2026-08-25）— **read-docs 本地化完成，§11 債務清零**
> 狀態快照：Phase 0–2 完成 + Phase 3 文件/測試整備完成（含使用者實機 UAT 通過 2026-08-25）。desktop `bun run typecheck` 綠、sdk `tsc --noEmit` 綠、agent-runtime 測試全綠（560）、SDK 單元測試綠（e2e/integration 套件需真實 provider key，本地未執行）、SDK dist 已重建、Electron 43.4.1 正式二進位已安裝（npmmirror）。
>
> **已知殘餘債務**：0 項（全部清零）
> 授權：Apache-2.0（沿襲上游，保留 LICENSE 與 NOTICE）

---

## 11. 已知殘餘債務（非阻塞，打包後可做）

~~- read-docs / docs-search 工具仍走 hosted facade，BYOK 下不可用 —— 與
  web_search 同模式的本地化候選~~

### 已完成（從本節移除）

- ✅ 六個 run-cancellation `it.skip` 測試已重寫為本地契約語義（2026-08-25）
- ✅ `resolveModelContextWindow` 已接入 context_meter（SDK + agent-runtime 注入 `resolveContextWindow` callback，fallback 回 `contextPrunerBudgetForModel`；2026-08-25）
- ✅ electron-builder NSIS + ripgrep win32-only 瘦身已在 `electron-builder.yml` + `pre-dist.mjs` 實作（排除 SDK vendor/ripgrep、extraResources 掛載單一 rg.exe；2026-08-25）
- ✅ read-docs 本地化：handler 改為直連 Context7 API（`fetchContext7LibraryDocumentation`），移除 hosted `callDocsSearchAPI` 依賴；typecheck 綠、既有測試綠（2026-08-25）
