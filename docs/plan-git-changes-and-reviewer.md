# 修改計畫：Git 快照注入範圍（A 部分）

- 狀態：**修訂 5——A 部分已實作完成**；B 部分（reviewer edit digest）已評估、**暫緩**（見 §6）
- 日期：2026-10-26
- 範圍：`packages/agent-runtime/src/system-prompt/prompts.ts`、`agents/base2/base2.ts`、`agents/base2/base-deep.ts`、`agents/base3.ts`、`scripts/generate-desktop-agents.ts`、`packages/host-core/src/agents/bundled-agents.ts`（生成物）、`AnyBuff 專案全貌與維護者指南.md`（ADR-33 ＋ §5 帳本）
- 相關 ADR：**ADR-33**（本次新增，見 §8）。ADR-28（reviewer 剝除 reasoning，已回退）與本案**無關**——B 已暫緩。
- **不動 reviewer**：`agents/reviewer/*` 與 `packages/agent-runtime` 的 spawn / history 管線本次零改動，reviewer 維持繼承父線完整 history 的上游行為。

本文件自包含：不需要任何先前的討論脈絡。所有數字均為實測值。

> 修訂歷程摘要
> - 修訂 1：status 上限提高至 10,000；快照說明文字改為工具中立；reviewer 改用 edit digest。
> - 修訂 2–4：digest 的預算、`editor` 輸出路徑、`createAgentState` logger、ADR-28 對照與 planted-bug eval 等設計修正。
> - **修訂 5（本輪）**：使用者裁定 **reviewer 維持現行做法**、只實作 A 部分。B 的完整設計移到 §6 暫存；§7–§11 全部改為只涵蓋 A。實作已完成並通過測試（§9）。

---

## 1. 背景（名詞定義）

**Git 快照**：session 建立時由 `sdk/src/run-state.ts:354` 的 `getGitChanges()` 執行四個 git 指令（`git status`、`git diff`、`git diff --cached`、`git shortlog HEAD~10..HEAD`）的結果，存在 `fileContext.gitChanges`，只在 `initialSessionState` 計算一次（呼叫點 `run-state.ts:686`），**之後永不更新**。每個子程序輸出受 `MAX_SUBPROCESS_OUTPUT_CHARS = 10_000_000` 保護。

**system prompt 注入**：`packages/agent-runtime/src/system-prompt/prompts.ts` 的 `getGitChangesPrompt(fileContext)` 把快照渲染成 XML 區塊。

**桌面 bundle**：`packages/host-core/src/agents/bundled-agents.ts` 是 `scripts/generate-desktop-agents.ts` 從 `agents/` 生成的產物。生成時會對 `BASE_AGENT_IDS`（`:64`）追加 `run_terminal_command`、`code_search`（`:133` `EXTRA_TOOLS`）。因此**桌面版**的 base2 / base-deep 有 terminal 工具，`agents/` 原始定義（SDK/CLI 路徑）沒有，只能 spawn `basher`。

---

## 2. 現況（改動前）

### 2.1 整份快照被注入，最壞 66,000 字元

`getGitChangesPrompt` 的舊預算：

| 欄位 | 舊上限 | 說明 |
|---|---|---|
| `status` | 3,000 字元（`maxLength / 10`） | 唯一會列出**未追蹤檔案**的欄位 |
| `diff` | 30,000 字元 | 只涵蓋**已追蹤**檔案 |
| `diffCached` | 30,000 字元 | 同上 |
| `lastCommitMessages` | 3,000 字元 | 最近 10 筆 commit 主旨 |

**最壞合計 66,000 字元 ≈ 16,000–20,000 tokens**，永久佔用每個 session 的 context window（位於快取前綴內；平常按快取讀取價計費，但 compaction 或快取過期後要按全價重寫）。

`getGitChangesPrompt` 有兩個消費者：

1. `${PLACEHOLDER.GIT_CHANGES_PROMPT}`（`packages/agent-runtime/src/templates/strings.ts:119`），被 `agents/base2/base2.ts`、`agents/base2/base-deep.ts`、`agents/base3.ts` 使用。三者的外層文案都寫「這是對話開始時的狀態，不會更新」。
2. `find_files` 的 `getSearchSystemPrompt()`（`packages/agent-runtime/src/system-prompt/search-system-prompt.ts:33-40`），其 token 數會從檔案樹預算（20,000 tokens 級距）中扣除。

### 2.2 一段指向不存在工具的指令

`scripts/generate-desktop-agents.ts` 舊版 `GIT_DISCIPLINE`（改動前行號 `:135-137`）在生成時（改動前 `:302-306`）附加到 base 家族：

```
# Git status discipline

If `git_status` reports that the current directory is not a git repository
(e.g. `fatal: not a git repository`), do not call `git_status` again for the
rest of this turn. Rely on the runtime-injected Git observation instead.
```

repo 內**不存在 `git_status` 工具**（`common/src/tools/list.ts`、`packages/agent-runtime/src/tools/handlers/list.ts` 均無此條目），也**不存在**「runtime-injected Git observation」這個機制。模型被要求「不要重複呼叫」一個從未擁有過的工具，並依賴一個不存在的資料來源。

> repo 中其他出現 `git_status` 字串的位置是 UI 的 silent-tool 過濾清單殘留（`desktop/src/renderer/src/App.tsx:90`、`packages/host-core/src/run/start-run.ts:463/514/535`、`packages/host-core/src/sessions/session-store.ts:52`）與 `prompts.ts` 的 `<git_status>` XML 標籤——都不是工具定義，**本次不動**。

---

## 3. 要解決的問題

### P1：最貴的欄位對「新檔案」完全無效，最有用的欄位卻被壓縮

`git diff` / `git diff --cached` 只顯示已追蹤檔案的變更。代理最常做的事是**建立新檔案**，而未追蹤檔案只出現在 `git status`。結果是：佔用 60,000 字元額度的兩個欄位，恰恰漏掉最需要被審查的內容；真正有用的檔案清單只分到 3,000 字元，在髒一點的 repo 裡就會被截斷。

### P2：凍結的快照會被模型當成事實

快照在 session 開始時計算，之後永不更新。session 越長，diff 內容越不真實：「這個檔案沒有改動」在十分鐘後可能就是錯的。**過期的行級細節比沒有更危險**，因為模型不會去驗證它。`status` 同樣會過期，但它體積小、語意粗（只是「哪些檔案 dirty」），且外層文案已明確標示為起點快照。

### P3：體積

66,000 字元 ≈ 16–20k tokens 的常駐開銷，對「知道哪些檔案是 dirty」這個實際用途而言不成比例。

### P4：一段指向不存在工具的指令

見 §2.2。這不是「模型不夠聽話」，而是指令本身不可能被滿足。

---

## 4. 決策

**D1**：`GIT_CHANGES_PROMPT` **只注入 `status`（上限 10,000 字元）與 `lastCommitMessages`（3,000 字元）**；不再注入 `diff` / `diffCached`。共用函式只留一句中性描述（「差異未內嵌」），**不指名工具、也不下指令**——因為 `find_files` 也用同一份 prompt，而它無法執行 git。如何取得差異寫在各代理的外層文案（各代理工具面不同，見 §1）。

**D2**：`gitChanges` 的**資料模型與計算保持不變**（`diff` / `diffCached` 仍計算、仍存在型別與 zod schema，`git status` 參數不變）。理由：移除欄位會擴散到 `common/src/util/file.ts:73` 的 zod schema 與多處 fixture，收益很小；保持資料層不動可讓改動維持在「只改呈現」，對 upstream merge 最友善（ADR-1）。**已知代價**：SDK 仍付出兩個 `git diff` 子程序的成本（各上限 10M 字元），只是不再進 prompt；要省掉必須另案處理（§11）。

**D3**：刪除 `GIT_DISCIPLINE`。它描述的工具與機制都不存在，保留只會製造空指令。`INVISIBLE_FILES_DISCIPLINE` 不動。

**D4（範圍）**：reviewer 子代理**維持現行行為**——`includeMessageHistory: true`，繼承父線完整 history。任何 digest / 過濾方案（B）不在本次範圍，理由與設計紀錄見 §6。

---

## 5. 變更規格 A：Git 快照（已實作）

### A1 `packages/agent-runtime/src/system-prompt/prompts.ts`

`getGitChangesPrompt` 改為只輸出 `status` 與 commit 訊息，並以具名常數取代舊的 `maxLength = 30_000` 與 `/10`：

```ts
const GIT_STATUS_MAX_CHARS = 10_000
const GIT_COMMIT_MESSAGES_MAX_CHARS = 3_000
```

實際輸出：

```
Git Changes:
<git_status>
...
</git_status>

<git_commit_messages_most_recent_first>
...
</git_commit_messages_most_recent_first>

Diffs are not inlined here. Line-level detail is not part of this snapshot.
```

- 說明句是**中性述句**：`find_files` 的消費者無法「去抓 diff」，任何祈使句都會變成空指令；測試明文鎖定「不得出現 `run_terminal_command` / `basher`」。
- 「起點快照、不會更新」的語意由各代理外層文案負責（A2），共用函式不重複。
- 保留 `if (!gitChanges) return ''` 的防禦性早退（`ProjectFileContextSchema` 已是必填，這是純防禦）。
- **實測**：最壞 13,206 字元（status 10,003 ＋ commit 3,003 ＋ 固定文案；`truncateString` 會多附 `...`），約 **3.3k tokens**，比改前少 **52,794 字元**。典型（乾淨 repo）223 字元。

**已考慮但不採用**：

- 以 `git diff --stat` 取代完整 diff：需新增 `gitChanges.stat` 欄位並擴散至 zod schema 與兩處 fixture，換來的是低價值訊號。
- sdk 改跑 `git status --short --branch`：違反 D2「不動資料層」；提高上限已足以解決 P1。
- 直接把 `gitChanges.diff` 從型別移除：擴散面大於收益（D2 已登記代價）。

**連帶影響（無需改碼）**：`find_files` 的 `getSearchSystemPrompt()` 會把省下的 token 交給檔案樹預算（20k 級距），因此該路徑的 system prompt 淨縮減量會小於 13,206 字元。

### A2 三個代理的外層文案

| 檔案 | 改動 |
|---|---|
| `agents/base2/base2.ts:317` | 在 `${PLACEHOLDER.GIT_CHANGES_PROMPT}` 之後加：``Diffs are not included. To see line-level changes, run `git diff` (and `git diff --cached`) with run_terminal_command, or spawn a basher with that command if you do not have the terminal tool.`` |
| `agents/base2/base-deep.ts:102` | 同上；並把 `:98` 的「other files changed in the git status/diff」改為「git status」（不再宣稱有 diff）。 |
| `agents/base3.ts:184` | 加：``Diffs are not included; run `git diff` with run_terminal_command when you need line-level changes.``（base3 原生即有該工具，見 `agents/base3.ts:39`。） |

說明：base2 / base-deep 在桌面 bundle 有 `run_terminal_command`（`EXTRA_TOOLS`），在 `agents/` 原始定義則只能 spawn `basher`，因此文案同時涵蓋兩者。

### A3 移除指向不存在工具的指令

`scripts/generate-desktop-agents.ts`：

- 刪除 `GIT_DISCIPLINE` 常數與其附加邏輯（含 `systemPrompt.includes('not a git repository')` 判斷）。
- 檔頭 patch 說明 #3 改為只提 `"invisible files"` discipline。
- `INVISIBLE_FILES_DISCIPLINE` 不動。

**生成物**：`packages/host-core/src/agents/bundled-agents.ts` 已重新產生（34 agents）。

---

## 6. 附錄：已評估但暫緩的 B 方案（reviewer edit digest）

**結論：本次不做。** reviewer 維持 `includeMessageHistory: true` 的上游行為。

### 6.1 原本要解決什麼

reviewer 沒有工具、沒有 diff 參數，唯一知道「改了什麼」的方式是重播父線完整 history。代價有四層：整份 transcript 以新前綴全價計費；每輪 review 都吃一次視窗；capped provider 的 cold-prefill admission control 可能直接拒絕（ADR-28 實測 `incoming_uncached_tokens=228,752 > cap 200,000`；**此限制僅見於自行實作 uncached-token 准入的私有 gateway，一般供應商只受模型視窗與速率限制**）；以及 reviewer 會讀到父代理的 `reasoning` 與自我辯護（錨定效應）。另外，base2 最常見的 `editor-multi-prompt` 路徑，reviewer 從父線 history **完全看不到編輯內容**。

### 6.2 設計要點（可直接續作）

- 新增 `messageHistoryFilter: 'edits-only'`；spawn 時以**純程式碼（0 次 LLM 呼叫）**從父線 history 拼出一則 `user` 訊息：`<user_requests>`（多輪時交錯保留前一輪 assistant 回覆、剝 `<think>`）、`<earlier_conversation_summary>`、`<user_decisions>`、`<edits>`（含 `editor` 的 `value.value.output.messages` 與 `editor-multi-prompt` 新增的 `unifiedDiff`）、`<files_before_edit>`、`<related_files_read>`。不含 reasoning、當前輪旁白、搜尋／終端機／網頁結果。
- 型別管線四處（`agents/types/agent-definition.ts`、`common/src/templates/initial-agents-dir/types/agent-definition.ts`、`dynamic-agent-template.ts` 的 zod、`agent-template.ts`），缺一則欄位在 runtime 被剝離。
- `createAgentState` 需補 `logger` 參數（兩個呼叫端）。
- digest 無法建立時 fallback 回完整 history，不得靜默輸出「沒有編輯」。

### 6.3 為何暫緩

1. **完整性優先**：任何有硬上限的 digest 都必然裁掉資訊；使用者要求 reviewer 看到完整資訊。
2. **拿掉上限就回到原點**：無上限 digest 仍是 O(session)（只是常數較小），若該 gateway 有 uncached-token 准入規則，問題與 ADR-28 相同，無法宣稱修好（一般供應商沒有這條規則）。
3. **ADR-28 的前例**：同一個問題在 2026-09-13 已嘗試過「剝除 reasoning」並同日回退（`f550529ea` → revert `c17208fdb`），理由是 strip 後仍是 O(session)、偏誤改善未經 evals 證實、且要背 bundle 烘焙分歧。
4. 因此現階段維持上游行為，是「不增加分歧、也不假裝解決」的選擇。

### 6.4 若未來重啟，必須先回答

- 採用有界 digest（需 planted-bug eval 證明命中率不低於現行），或
- 給 reviewer 檢索工具（`read_files` / `code_search`）＋最小種子，讓「完整」的定義變成「查得到」而非「已載入」。

在那之前，不應把 B 的半成品放進 runtime。

### 6.5 後續（2026-10-26）：改採 runtime 過濾，digest 仍暫緩

使用者裁定**只丟 `reasoning`**：visible `text` 全留，工具結果不動、也不做 digest。實作為 `messageHistoryFilter: 'review-context'`（ADR-34）：接縫在 `createAgentState`，agent 端只帶 flag；reviewer 仍繼承完整 history，只少了作者內部的 `reasoning`（最後一段 assistant run 例外）。§6.2 的 digest 設計保留為日後選項。

### 6.6 後續（2026-10-26）：reviewer 看得到編輯（ADR-35）

reviewer 的資訊來源只有父線 history 中 `spawn_agents` 的 tool result（子代理自己的 tool call 不會回流父線），因此 `AgentOutput` 的保真度就是審查能力的上限。default 的 `editor` 把編輯埋在 `{ output: { messages } }` 三到四層巢狀裡；max 的 `editor-multi-prompt` 則完全不帶 diff（`unifiedDiffs` 是 selector 的輸入，用完即成死值）。已實作：

1. `editor-multi-prompt` 的 `set_output` 增 `unifiedDiff`（僅真 diff；`'No changes proposed'` 與 `Error: …` 省略）。
2. runtime 的 `render-subagent-output.ts` 在 `review-context` 下把 `spawn_agents` 結果攤成 `{ agentName, agentType, rendered }`（維持 `json` part、fail-open）。`write_file` 依使用者裁定渲染完整內容並標明 whole-file write。

刻意不比照 default 的 schema（會失去 `suggestedImprovements`，並把落選實作倒進父線）。已知成本：`unifiedDiff` 進入父線 history，之後每一步重送。

---

## 7. 預期效果（A 部分，實測）

| 指標 | 改前 | 改後 |
|---|---|---|
| `getGitChangesPrompt` 最壞輸出 | 66,000 字元 | **13,206 字元**（−52,794） |
| 約當 tokens（英文／程式碼 4 字元/token） | 16–20k | **≈3.3k** |
| system prompt 中的 `<git_diff>` / `<git_diff_cached>` | 有 | **無** |
| 未追蹤檔案在 prompt 中的預算 | 3,000 字元（易被截斷） | **10,000 字元** |
| `bundled-agents.ts` 中的 `git_status` 指令 | 8（`git show HEAD:… \| grep -c` 實測，`BASE_AGENT_IDS` 每個 id 一份） | **0** |
| `runtime-injected Git observation` | 存在 | **0** |

`find_files` 路徑的淨縮減會小於 13,206 字元，因為省下的 token 會被檔案樹預算（20k 級距）吸收。

---

## 8. 相容性與 repo 規範義務

1. **新增 ADR-33** 於 `AnyBuff 專案全貌與維護者指南.md`（現有最高為 ADR-32），文件版本頭推到 **v3.20**。內容：D1–D4、被否決的替代方案（`--stat`、`git status --short`、移除型別欄位）、UI `git_status` 殘留的說明、影響檔案清單。
2. **§5 維護帳本**補一列「Git 快照注入範圍（ADR-33）」。此改動屬於**已登記分歧**，性質與 ADR-22（context-pruner）、ADR-24（tagged run params）相同：upstream 檔案在 `git merge` 時須手動重新套用。
3. **上游檔案清單**（merge 時需重套）：`agents/base2/base2.ts`、`agents/base2/base-deep.ts`、`agents/base3.ts`、`packages/agent-runtime/src/system-prompt/prompts.ts`。
4. **AnyBuff 專有檔案**：`scripts/generate-desktop-agents.ts`；**生成物**：`packages/host-core/src/agents/bundled-agents.ts`（不得手改）。
5. **不得違反 ADR-10 / ADR-26 / ADR-32**：本案只改 prompt 文字，不觸碰請求層推理 wiring；子代理 history 形狀不變，因此不需要、也不得新增任何 `thinking:{type:'disabled'}` 或 `enable_thinking:false`。
6. **ADR-28 不受影響**：它仍維持已回退狀態；本案不引用、也不取代它。

---

## 9. 驗證

### 9.1 新增測試 `packages/agent-runtime/src/__tests__/git-changes-prompt.test.ts`

7 個測試，全部通過：

- 髒 repo → 注入 status（含未追蹤檔）與 commit 主旨。
- 不注入 `<git_diff>` / `<git_diff_cached>`，也不含 diff 內文。
- 說明句存在，且**不含** `run_terminal_command` / `basher`（工具中立）。
- 最壞輸入 → 總長 ≤ 13,500；status 區塊恰 10,003、commit 區塊恰 3,003 字元。
- 四欄皆空 → 不 throw、無 `undefined` 字串。
- `gitChanges === undefined`（cast）→ 回空字串。
- `find_files` 的 `getSearchSystemPrompt()` 路徑：不 throw、仍含 status、不含 diff 區塊（第二個消費者的迴歸鎖）。

### 9.2 已執行的指令與結果

```bash
cd packages/agent-runtime && bun test src/__tests__/git-changes-prompt.test.ts   # 7 pass
cd packages/agent-runtime && bun run typecheck                                   # clean
cd packages/agent-runtime && bun test src/                                       # 600 pass, 0 fail
cd packages/host-core && bun x tsc --noEmit -p .                                 # clean
cd desktop && bun run typecheck                                                  # clean（node + web）
bun scripts/generate-desktop-agents.ts                                           # 34 agents
grep -c "git_status" packages/host-core/src/agents/bundled-agents.ts || true      # 0
grep -c "runtime-injected Git observation" packages/host-core/src/agents/bundled-agents.ts || true  # 0
grep -c "Diffs are not included" packages/host-core/src/agents/bundled-agents.ts  # 9（8 個 base id + 繼承 base3 prompt 的 base3-lite）
```

> `grep -c` 在 0 命中時 exit code 為 1，串在 `&&` 腳本裡會中斷，因此驗收指令一律加 `|| true`。

```bash
grep -rn "<git_diff" --include=*.ts --include=*.md . | grep -v node_modules   # 只剩測試斷言
```

### 9.3 驗收標準

- [x] `<git_diff>` / `<git_diff_cached>` 不再出現在任何 system prompt
- [x] `getGitChangesPrompt` 最壞輸出 ≤ 13,500 字元，且不指名工具、不含祈使句
- [x] `find_files` 的 search system prompt 同樣不含 diff 區塊（有迴歸測試）
- [x] `bundled-agents.ts` 中 `git_status` 與 `runtime-injected Git observation` 皆為 0
- [x] `agents/` 三個外層文案都說明 diff 未內嵌與取得方式
- [x] 指南版本頭 v3.20、ADR-33、§5 帳本已更新
- [x] 上述建置、型別、測試指令通過

---

## 10. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| 模型失去 diff 後不知道使用者改了什麼 | 體驗退化 | A2 外層文案明確給出取得方式；`status` 上限提高到 10,000，且**新檔案**本來就只有 status 看得到 |
| 模型反覆自行跑 `git diff` | 額外延遲 | 只在需要行級細節時才跑；外層文案已寫「需要行級變更時」；比每次 session 都預載 60k 字元便宜 |
| 快照仍是凍結的 | 長 session 下 `status` 過期 | 與改前相同（非本次新增）；外層文案已標示「起點狀態、不會更新」 |
| upstream merge 衝突 | 下次同步要手動重套 | ADR-33 ＋ §5 帳本列出四個 upstream 檔案；改動集中在單一函式與三句文案 |
| bundled-agents 與來源不同步 | 改了 agent 但 App 行為不變 | §9.2 一律透過生成腳本；grep 驗收 |

**回滾**：還原 `getGitChangesPrompt`、三處外層文案與生成腳本，重新產生 bundle。資料層未動，回滾是純呈現層操作。

---

## 11. 不在本次範圍

- **Reviewer 的上下文**（B 方案）：維持現行完整 history，見 §6。
- 移除 `gitChanges.diff` / `diffCached` 的計算，或改變 sdk 的 git 指令（D2 已登記代價）。
- 即時／定期刷新 git 快照。
- 清理 UI 端 `git_status` silent-tool 過濾殘留。
- 把 planted-bug eval 常設化。
