# **Plan：移植上游「Send now / Mid-turn Steering」到 AnyBuff desktop**

## **Overview**

把上游 Freebuff desktop APP 的 "Send now"（mid-turn steering）移植到 AnyBuff：task 執行中送出的純文字訊息不再排隊等待回合結束，而是**注入正在跑的 live turn**，agent 在下一個 step boundary 回應，全程 run 維持 running、不中斷。引擎 hook（`drainSteeringMessages`）與其測試**已隨 2026-08-23 baseline 在本地 SDK/agent-runtime 中**，本計畫只動 host-core + renderer（皆為 AnyBuff 自有模組，無上游 merge 衝突面）。

## **Requirements**

**Host 端（host-core）**

- 新增 steering mailbox（建議 `packages/host-core/src/run/steering-mailbox.ts`，模式比照上游 `cli/src/utils/steering-buffer.ts` 的 claim/accept + owner-guard）：
  - `pushSteeringMessage(text)` — 無 active run 或 abort 已觸發時回 `accepted: false`
  - `takeSteeringMessages()` — 引擎 drain 的本體
  - run settle 時清空並回傳未 drain 的 leftovers
- `start-run.ts`：[`client.run`](http://client.run)`({...})`（L1124）補傳 `drainSteeringMessages`（aborted 時回 `[]`，與上游一致）；`RunResult` 增加 `steeredLeftovers`（未 drain 文字 + 對應 push id）
- Transcript 持久化：push 當下以新 session-store helper append 一則 role `'user'` 的 TaskMessage（即時 echo）；leftover 發生時自 transcript 收回（retract）— 參照 `beginUserTurn` / `trimLastTurn` 的既有模式
- 新 channel `AnyBuff:sendNow`：`CHANNELS` 註冊（`channels.ts`）+ `handlers-runs.ts` handler + `dispatcher.ts` 派發 — Electron（`host-bridge.ts`）與 Android WS（`ws-server.ts`）自動取得
- Steering 閘門（host 端最終防線，比照上游 `router.ts`）：僅在 run active 且純文字時接受

**Renderer（desktop，與 Android 共用同一份）**

- `App.tsx` `send()` 的 `if (running)` 分支改為雙路：純文字且可 steer → 呼叫 `window.AnyBuff.sendNow(...)`、立即 echo user chat item（帶 push id）、清空輸入，**不**加 assistant bubble；其餘（有附件／pending bash／steer 被拒）→ 維持現行 queue 路徑
- Run 結束時處理 `result.steeredLeftovers`：**requeue 到佇列最前**（FIFO 不亂序）+ 依 push id 收回 echo bubble — 對齊上游 bubble-retract 語意
- User-interrupt（Stop）：requeue 後**暫停佇列不自動派發**（`pause-if-pending` 對齊，防止使用者剛停掉的 turn 被立刻重啟）；新增最小 `queuePaused` 狀態 + MessageQueuePanel 顯示暫停態（⏸）與恢復入口
- `Composer.tsx`：running 區塊的主按鈕隨情況切換 — 可 steer 時顯示 **"Send now"**（title「注入執行中的 task」）、不可 steer 時維持 Plus/Queue 圖示與提示；Enter 鍵走同一路由，無需獨立處理
- Steered 訊息送**原始文字**（不過 `buildFinalPrompt` 烘焙 — 閘門已排除附件）；附件烘焙行為照舊留給 queue 路徑

**文件與登記**

- 新增 **ADR-30**：mid-turn steering 移植 — 決策（host-core mailbox + renderer Send now；steering 與既有 queue **並存**：純文字+空佇列 → steering，其餘 → queue）、理由、維護注意（引擎 hook 屬上游檔案不動刀；上游 merge 觸及 `run-agent-step.ts` drain 區塊時的對照點）
- 更新維護者指南（§3.4 或新小節 + §5 帳本）與 [README.md](http://README.md) 的 run-active 說明句

## **Notes**

- **引擎/SDK 零修改**：`sdk/src/run.ts`（L222–227、L865）與 `run-agent-step.ts`（L707–711、L1269）的 hook 已存在且有引擎測試（`loop-agent-steps.test.ts` "steering"）；steered 文字經 `userMessage({tags:['USER_PROMPT'], keepDuringTruncation:true})` append，ADR-24 語意正確（無 params → 無 `<system>` 區塊，讀作使用者語音）
- **單一 run 語意**：run 為 per-process singleton；steering 一律指向 active run（與現行全域 queue 行為一致），與使用者正在檢視哪個 task 無關
- **Analytics**：`DESKTOP_QUEUE_SEND_NOW` 常數已在 `common/src/constants/analytics-events.ts` L353；AnyBuff 遙測為本地 no-op（S7），可不接線（登記於 ADR-30）
- **閘門保守化**：v1 比照上游排除所有附件（含 @file）；未來可放寬
- **驗證迴路**：`bun run build:host-core` → `typecheck:host-core` → `test:host-core`（含新 mailbox 單元測試 + channel contract + WS parity）→ `bun --cwd desktop run typecheck` → `bun run dev` 手動驗證（起 run → 執行中輸入 → Send now → 確認訊息注入、task 維持 running、Stop 後 requeue 不自動重啟）
- 新測試：host-core mailbox（claim/accept/leftover/owner-guard/abort 回 `[]`）、desktop send 路由（steer vs queue vs 暫停派發）

## **Relevant files**

- `packages/host-core/src/run/start-run.ts`（[client.run](http://client.run) 接線 + RunResult）
- `packages/host-core/src/run/steering-mailbox.ts`（新）
- `packages/host-core/src/sessions/session-store.ts`（echo/retract helper）
- `packages/host-core/src/channels/channels.ts`、`handlers-runs.ts`、`dispatcher.ts`
- `desktop/src/preload/`（ContextBridge 型別化 `sendNow`）、`desktop/src/shared/`（contract re-export）
- `desktop/src/renderer/src/App.tsx`、`desktop/src/renderer/src/components/Composer.tsx`、`MessageQueuePanel.tsx`、`desktop/src/renderer/src/styles.css`
- `desktop/test/`、`packages/host-core/src/__tests__/`（新測試）
- `AnyBuff `[`專案全貌與維護者指南.md`](http://專案全貌與維護者指南.md)（ADR-30 + 帳本）、[`README.md`](http://README.md)

