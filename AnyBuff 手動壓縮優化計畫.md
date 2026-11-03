# AnyBuff 手動壓縮優化計畫

> **狀態**：已實作（`d5c55f385` 十個工作項；實作後的補強見 §13）
> **適用版本**：`master`（`8f7687143` 之後）
> **範圍**：`packages/agent-runtime` 的手動 `/compact` 路徑與 per-turn scaffolding TTL、desktop 的 `/compact` 入口與一個顯示標籤
> **硬約束**：不改變機械式壓縮（`compact-history.ts`、`context-pruner`）的行為
> **文件性質**：本文件自足，不需要閱讀其他計畫或對話紀錄

---

## 1. 問題摘要

AnyBuff 的 `/compact` 是一條「模型寫摘要，然後整段歷史被換成那則摘要」的路徑。目前它有以下九個具體缺陷：

| #   | 缺陷                                                            | 後果                                                         |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `/Compact`、`/COMPACT` 會進入覆寫分支，但不會注入摘要指令       | 模型回一句普通話，歷史被換成那句話 → **整段對話消失**        |
| 2   | 指令表用 `in` 查詢                                              | 輸入 `toString` 會把函式源碼當系統指令注入                   |
| 3   | `/compact` 指令與其說明訊息沒有 TTL                             | 每次失敗永久留下約 100–150 tokens                            |
| 4   | 摘要 prompt 是自由格式，只擋空字串／think-only                  | 非空但無用的摘要（「我需要更多資訊」）仍會覆寫歷史           |
| 5   | 成功時整段歷史被換掉，包含最後一輪對話                          | 模型失去「剛剛在做什麼」，只剩摘要裡的一句話                 |
| 6   | 成功後歷史只剩一則 user 訊息，`getAgentOutput` 找不到 assistant | 回傳 `{type:'error'}`，host 把**成功的壓縮**標成「執行中斷」 |
| 7   | `stripThinkTags` 只認 `<think>`，不認 `<thinking>`              | `<thinking>`-only 回應被視為有內容，think-only 守衛失效      |
| 8   | 桌面／Android 沒有 `/compact` 入口                              | 功能存在但不可發現，只能靠使用者手打                         |
| 9   | `INSTRUCTIONS_PROMPT` 每輪新增、無 TTL                          | 跨輪累積；context 計數虛高、自動壓縮提前觸發                 |

另外有一個純顯示問題：Activity 面板把所有 `context_compaction` 事件標成「Context compacted」，包含「已跳過」的事件。

本計畫逐項修正，且**不新增訊息型別、不新增 tag、不改 `Message` schema、不改機械式壓縮的任何一行**。

---

## 2. 背景：AnyBuff 的兩套壓縮

### 2.1 手動壓縮（`/compact`）

使用者（或 SDK/CLI 呼叫端）把 `/compact` 當一般 prompt 送出。路徑如下：

1. **指令注入**：`packages/agent-runtime/src/run-agent-step.ts` 的 `loopAgentSteps()` 在組 `initialMessages` 時檢查 `prompt in additionalSystemPrompts`，命中就把對應文字包成 `<system_instructions>` 放進歷史（`run-agent-step.ts:989-996`）。
2. **指令表**：`packages/agent-runtime/src/system-prompt/prompts.ts:103-110`

   ```ts
   export const additionalSystemPrompts = {
     '/init': initPrompt,
     init: initPrompt,
     '/export': exportPrompt,
     export: exportPrompt,
     '/compact': compactPrompt,
     compact: compactPrompt,
   } as const
   ```
3. **摘要生成**：模型把摘要當普通文字回覆，`processStream()` 只累積 `type:'text'` 的 chunk 到 `fullResponse`。
4. **歷史替換**：`runAgentStep()` 結尾（`run-agent-step.ts:580-625`）比對 prompt，成功就執行：

   ```ts
   agentState.messageHistory = [
     userMessage(withSystemTags(
       `The following is a summary of the conversation between you and the user. ` +
       `The conversation continues after this summary:\n\n${fullResponse}`,
     )),
   ]
   ```

   這則訊息**刻意不帶 `CONVERSATION_SUMMARY` tag、不包 `<conversation_summary>` 信封**（ADR-37 的 D1）。
5. **既有守衛**（已於 commit `78d205370` 落地）：`fullResponse` 為空、只有 think 標籤、或本步有工具錯誤時，不改寫歷史，改送：

   ```ts
   onResponseChunk({
     type: 'context_compaction',
     action: 'compact_skipped',
     message: '...歷史已保留...',
   })
   ```

### 2.2 機械式壓縮（三條路徑、同一個引擎）

| 路徑                    | 觸發                                                   | 入口                                                             |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| inline `context-pruner` | base2 / base-deep，每步；預算超標或 cache gap ≥ 5 分鐘 | `agents/context-pruner.ts`（deterministic，不呼叫模型）          |
| `maybeCompactHistory`   | base3 / base3-lite / base-chat，每步開頭且超過 trigger | `run-agent-step.ts:1145` → `compact-history.ts`                  |
| overflow resume         | context-overflow 失敗後重試                            | `sdk/src/impl/resume-compaction.ts` → 同一個 `compactMessages()` |

三者共用 `packages/agent-runtime/src/compact-history.ts` 的 `compactMessages()`：

- 辨識既有摘要的條件是 **`<conversation_summary>` 加上 `SUMMARY_HEADER`**（`compact-history.ts:440-446`）。`context-pruner` 的副本只認 tag，這是已登記的 parity 分歧。
- 把歷史壓成 `[USER]` / `[ASSISTANT]` 條目，套用預設預算：assistant/tool 20k、user 50k；單則 user 訊息上限 13k（`USER_MESSAGE_LIMIT`），單則 assistant 1.3k。
- 從**最新往回**選条目（`selectEntriesWithinBudget`），預算用完就丟掉較舊的。
- 保留一段逐字 tail（`splitTail`：最多 8 組 tool pair、10k tokens）。

### 2.3 兩者唯一的交界：`messageHistory`

機械式壓縮**只讀寫 `agentState.messageHistory` 這個陣列**。因此：

- 任何被放進 `messageHistory` 的東西，機械式壓縮都會看到。
- 手動摘要目前是一則**無 tag 的 `user` 訊息**，所以機械式壓縮會把它當成一般 `[USER]` 條目：原文保留（2k < 13k 上限），但它是**最舊**的條目，user 預算（50k）用完時第一個被丟。
- 若手動摘要改成帶 tag／信封，`compact-history.ts` 會認出它並重新解析成條目；八段式摘要不是機械條目格式，會被降級。更麻煩的是 `context-pruner` 只認 tag，同一則訊息在兩份 compactor 眼中身分不同。

**這就是本計畫堅持「摘要保持無 tag、無信封」的原因**：不是為了美觀，是為了讓機械式壓縮完全不需要認識它。

### 2.4 由此得出的設計約束

> 手動壓縮的改進，只能發生在「產生摘要」與「寫入陣列」這兩個動作上；不能新增機械式壓縮需要理解的資料形狀。

---

## 3. 約束與非目標

### 3.1 硬約束

1. **不動** `packages/agent-runtime/src/compact-history.ts`。
2. **不動** `agents/context-pruner.ts` 與 `packages/host-core/src/agents/bundled-agents.ts`（不需重跑生成腳本）。
3. **不動** `common/src/types/messages/*`、不新增 `role` 或 `type`。
4. **不新增** `CONVERSATION_SUMMARY` tag 或 `<conversation_summary>` 信封。
5. 成功摘要維持「一則 `<system>` 包裹的普通 user message」。
6. 每一項可獨立 revert。

### 3.2 非目標（明確不做，含理由）

| 不做                                  | 理由                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 把摘要做成獨立訊息型別或帶 tag        | 會進入 `messageHistory`，強迫兩份 compactor 認識它 → 違反硬約束                                                                |
| 改成「不改寫歷史、讀取時套邊界」      | token 計數必須改成計算視圖，否則壓縮後立刻再觸發機械式壓縮；屬 3–5 天重構，且會改變機械式壓縮的觸發時機                        || 小對話的 no-op 門檻 | 不是「加一個 if」：AnyBuff 的手動路徑是後置的（模型先寫摘要才替換），要跳過呼叫必須在 `loopAgentSteps` 增一個前置分支，自帶 no-op output、事件與 turn 結束語意。上游能做是因為它的壓縮區塊本來就在 streaming 之前。成本高於本計畫其他項目，另開一張票。 |
| 摘要失敗後自動重試（nudge）           | 多一次 LLM call；先觀察實際失敗率                                                                                              |
| `finishReason === 'length'` 視為失敗  | `processStream()` 目前不回傳 finish reason，需改共用串流層                                                                     |
| provider-native compaction            | 與 BYOK 模型無關                                                                                                               || 成功時的額外「Context compacted」文案 | 摘要本身已顯示在聊天中；多一則只會重複 |

### 3.3 機械式壓縮影響審計

逐項檢查「是否改動機械式壓縮會讀到的東西」：

| 工作項 | 改到的檔案 | 機械式壓縮看到什麼 | 判定 |
|---|---|---|---|
| 1 | `prompts.ts`、`run-agent-step.ts` | `/Compact` 不再被替換，變成一則普通 user 訊息留在歷史 | 無影響（歷史變長是正確狀態） |
| 2 | `prompts.ts`、`run-agent-step.ts` | 少了 `toString` 被注入的假指令 | 無影響 |
| 3 | `run-agent-step.ts` | 跳過後少兩則殘留訊息 | 無影響（減少雜訊） |
| 4 | `prompts.ts`、`summary-format.ts`、`run-agent-step.ts` | 手動摘要仍是無 tag 的 user 訊息；內容變短且結構化 | 無影響（user 預算更寬鬆）；另加 envelope 拒絕 |
| 5 | `compaction-tail.ts`、`run-agent-step.ts` | 替換後的歷史多了 assistant + tool 尾段 | 無影響（形狀正常） |
| 6 | `run-agent-step.ts` | 不變（只改 output 與 break） | 無影響 |
| 7 | `ActivityPanel.tsx`、`activity-meta.ts` | 不變（renderer） | 無影響 |
| 8 | `think-tags.ts` | `compact-history.ts` 有自己 inline 的 `<think>` regex | 無影響 |
| 9 | `Composer.tsx`、`App.tsx`、modal | 不變（renderer；只是多一個入口） | 無影響 |
| 10 | `run-agent-step.ts` | 每輪少 N 則重複的 instructions；`contextTokenCount` 變準 | **正向**（不再提前觸發） |

**兩個刻意的行為改變（不是負面影響）**：

1. 工作項 10 讓 token 計數變準 → 機械式壓縮**延後**到實際需要時才觸發。這是修正「虛高」，不是放寬保護。
2. 工作項 5 讓壓縮後的歷史多出 10k 尾段 → 相對「只有摘要」會早一點再次觸發；但相對壓縮前仍大幅下降，且尾段本來就是模型需要的最新內容。

**不改的檔案**：`compact-history.ts`、`agents/context-pruner.ts`、`packages/host-core/src/agents/bundled-agents.ts`、`sdk/src/impl/resume-compaction.ts`。三條機械路徑（inline pruner、`maybeCompactHistory`、overflow resume）都不需要知道本計畫新增的任何東西。

---

## 4. 工作項

### 工作項 1：指令辨識精確化

**問題**

目前有兩套互相獨立的判定：

```ts
// 注入（run-agent-step.ts:989）
prompt in additionalSystemPrompts

// 覆寫（run-agent-step.ts:580-583）
prompt.toLowerCase() === '/compact' || prompt.toLowerCase() === 'compact'
```

`additionalSystemPrompts` 的 key 是小寫的 `/compact` 與 `compact`。所以 `/Compact` 會**進入覆寫分支但沒有注入摘要指令**，模型回一句普通話，然後歷史被換成那句話。

**設計**

在 `system-prompt/prompts.ts` 新增兩個 predicate，讓兩邊共用同一份事實來源：

```ts
export function hasAdditionalSystemPrompt(prompt: string | undefined): boolean {
  return prompt !== undefined && Object.hasOwn(additionalSystemPrompts, prompt)
}

export function isCompactCommandPrompt(prompt: string | undefined): boolean {
  return (
    hasAdditionalSystemPrompt(prompt) &&
    additionalSystemPrompts[prompt as keyof typeof additionalSystemPrompts] ===
      compactPrompt
  )
}
```

`Object.hasOwn` 是 AnyBuff 的追加硬化：上游的 predicate 內部仍用 `prompt in`，值相等比較擋住了 `toString` 的誤判，但**注入路徑沒有這層保護**。上游 merge 若帶回 `in`，不得回退（見 §10）。

**行為表（修正後）**

| 輸入                  | 注入摘要指令 | 覆寫歷史 | 說明                                   |
| --------------------- | ------------ | -------- | -------------------------------------- |
| `/compact`            | 是           | 是       | 不變                                   |
| `compact`             | 是           | 是       | 不變                                   |
| `/Compact`            | 否           | **否**   | 修正前會毀歷史                         |
| `/COMPACT`            | 否           | **否**   | 修正前會毀歷史                         |
| `Compact`             | 否           | 否       | 本來就不觸發                           |
| `compact this file`   | 否           | 否       | 本來就不觸發                           |
| `/compact `（尾空格） | 否           | 否       | 嚴格比對；若 composer 已 trim 則無影響 |

**為什麼不 normalize**

- `trim().toLowerCase()` 會讓 `/Compact`、`/COMPACT`、`Compact` 全部觸發，語意比現在更寬。
- 嚴格比對的最壞情況是「模型回一句話」，不會損失資料。
- 與上游 Freebuff 的 `isCompactCommandPrompt` 一致，未來 sync 不必重寫。

**變更點**

- `packages/agent-runtime/src/system-prompt/prompts.ts`
- `packages/agent-runtime/src/run-agent-step.ts`：`wasCompacted = isCompactCommandPrompt(prompt)`；注入處改用 `hasAdditionalSystemPrompt(prompt)`

**測試**

- `/Compact`、`/COMPACT`、`Compact`、`compact this file` 皆不改寫歷史。
- `/compact`、`compact` 仍改寫（既有案例）。
- `prompt = '/compact '` 不改寫。

**風險**：`/Compact` 從「會壓縮（但毀歷史）」變成「不壓縮」。這是刻意的行為改變，需在變更說明中標註。

---

### 工作項 2：指令表查詢硬化

**問題**

`'toString' in additionalSystemPrompts` 為 `true`，而 `additionalSystemPrompts['toString']` 是 `Function.prototype.toString`。使用者若把 `toString` 當訊息送出，函式源碼會被 `withSystemInstructionTags` 當系統指令注入。

**設計**

工作項 1 的 `hasAdditionalSystemPrompt()` 已使用 `Object.hasOwn`。把注入處的 `prompt in additionalSystemPrompts` 換成它即可。

`common/src/types/freebuff-session.ts:682` 已有同樣的註解與用法，照抄慣例。

**定性**：上游 `main` 的 predicate 與注入至今都仍是 `prompt in`；這不是回歸，是 **AnyBuff 追加硬化**。ADR-37 維護注意必須登記，否則上游 merge 會靜默覆蓋。

**測試**

- `hasAdditionalSystemPrompt('toString') === false`
- `isCompactCommandPrompt('toString') === false`
- 一般 prompt（例如 `init`）仍會注入。

**風險**：極低。可獨立 revert（把 `Object.hasOwn` 改回 `in` 仍能運作，值相等比較仍會擋住 `/Compact`）。

---

### 工作項 3：指令訊息不再殘留

**問題**

`/compact` 被跳過後，歷史會留下兩則訊息：

1. `USER_PROMPT` = `/compact`
2. `withSystemInstructionTags(compactPrompt)`（約 90 tokens）

兩者都沒有 `timeToLive`。`userMessage()`（`common/src/util/messages.ts:598`）不設 TTL，`expireMessages()`（`packages/agent-runtime/src/util/messages.ts:283`）只依 `timeToLive` 過濾，所以它們會永久留在歷史裡。

> 附帶事實：production 程式碼目前**沒有任何地方**設 `timeToLive: 'userPrompt'`（只有測試有）。`clearUserPromptMessagesAfterResponse` 對一般使用者訊息實際上是 no-op。本工作項會是第一個 production 使用點。

**設計**

在 `loopAgentSteps()` 組 `initialMessages` 時，只有 compact 指令的兩則加上 TTL：

```ts
const manualCompaction = isCompactCommandPrompt(prompt)

// USER_PROMPT
{
  role: 'user',
  content: buildUserMessageContent(prompt, spawnParams, content),
  tags: ['USER_PROMPT'],
  sentAt: Date.now(),
  keepDuringTruncation: true,
  ...(manualCompaction ? { timeToLive: 'userPrompt' as const } : {}),
}

// 說明訊息
userMessage({
  content: withSystemInstructionTags(additionalSystemPrompts[prompt]),
  ...(manualCompaction ? { timeToLive: 'userPrompt' as const } : {}),
})
```

turn 結尾的 `expireMessages(history, 'userPrompt')`（`loopAgentSteps` 的正常結束、abort、error 三條路徑都有）就會清掉它們。

**不可**改 `userMessage()` 或共用 builder 的預設值：一般使用者訊息必須留在歷史裡。

**替代方案（不採用）**

OpenCode 把 `/compact` 當 control item，完全不讓它進歷史，摘要指令只附加在該次請求的 `messages`。這樣更乾淨，但要改 `hasUserMessage` 與 stream 的 messages 組裝，控制流改動較大；TTL 版本已消除 99% 的殘留問題（模型在該步仍看得到 `/compact`，但有指令解釋，無害）。

**測試**

- 跳過 `/compact` 後，歷史不含 `/compact` 字樣，也不含 `User has typed "compact"`。
- 一般 prompt（例如 `hello`）仍留在歷史（回歸）。
- 成功壓縮後歷史不含這兩則（本來就會被替換，回歸）。

**風險**：低。若 `clearUserPromptMessagesAfterResponse === false`（subagent），TTL 不會被執行；subagent 不接收 `/compact`。

---

### 工作項 4：摘要模板與驗證

**問題**

`compactPrompt` 目前是自由格式：

```
User has typed "compact". Summarize the current conversation and prepare it to replace the existing message history.

1. Summarize the entire conversation up to this point (excluding this 'compact' command).
2. The summary should be detailed and must capture the key decisions, analysis, changes, and outcomes.
```

既有守衛只擋「空字串／think-only／工具錯誤」。一則非空但無用的回覆（例如「我需要更多資訊才能摘要」）仍會覆寫歷史，而它正是壓縮後唯一的記憶。

**設計**

#### 4.1 新的 `compactPrompt`

改成固定段落，並要求模型只回摘要、不呼叫工具：

```
User has typed "compact". Replace the conversation history with a structured
summary that another agent can resume from.

Summarize the entire conversation up to this point, excluding this compact
command. Return ONLY the summary, using exactly these sections in this order.
Do not call tools. Do not mention the summary process or that context was
compacted.

## Objective
One or two sentences: what the user is trying to achieve.

## Requirements
Constraints and preferences that still apply.

## Decisions
Decisions made, one clause of reasoning each.

## Work State
What is done, what is in progress, what is blocked. Say whether changes are
uncommitted, committed, or pushed.

## Next Move
The single next action, specific enough to start without re-reading the
conversation.

## Relevant Files
Exact paths, with a one-line note on why each matters.

## Important Context
Facts, error strings, commands, identifiers, and URLs that must not be lost.

## Latest Exchange
What the user asked last, and what the assistant did or answered.

Rules:
- Terse single-line bullets. No prose paragraphs, no nested lists.
- Preserve exact paths, symbols, commands, error strings, URLs, identifiers.
- Prefer short references over restating code.
- Carry forward only user requests that are still unanswered or need action.
- If a section has nothing, write "- (none)".
```

#### 4.2 格式驗證

新增 `packages/agent-runtime/src/util/summary-format.ts`：

```ts
import { stripThinkTags } from './think-tags'

const MIN_SECTIONS = 6
const MIN_CHARS = 400

/**
 * 取摘要本體：
 * 1. 先找 `## Objective`（模板正常時的精準路徑）
 * 2. 找不到才退回「至少 6 個 `## ` 段落」的形狀判定
 *
 * 形狀判定是為了容忍模型翻譯標題（上游觀測到 GLM 5.3 Flash 有 12% 會翻）。
 * 沒有標題或段落不足時回空字串。
 *
 * 函式名與回傳型別（string）刻意與上游一致，降低 merge 摩擦。
 */
export function summaryFromReply(reply: string): string {
  const text = stripThinkTags(reply)
  // `context-pruner` 只認 `<conversation_summary>` 這個字串；摘要本體若含有它，
  // 下一次機械壓縮會把它誤認成 previous summary。寧可拒絕，保留歷史。
  if (text.includes('<conversation_summary>')) return ''
  const english = text.indexOf('## Objective')
  if (english >= 0) return text.slice(english).trim()
  const sections = [...text.matchAll(/^## /gm)]
  if (sections.length < MIN_SECTIONS) return ''
  return text.slice(sections[0].index).trim()
}

export function isUsableSummary(summary: string): boolean {
  return summary.length >= MIN_CHARS
}
```

`stripThinkTags()` 重用 `util/think-tags.ts` 的既有實作（已處理未閉合與孤兒 `</think>`）。

#### 4.3 接進 `runAgentStep`

```ts
const summary = summaryFromReply(fullResponse)
const hasVisibleSummary = summary.length > 0 && isUsableSummary(summary)

if (!hasVisibleSummary || hadToolCallError) {
  // 既有 compact_skipped 路徑，額外記錄 headingCount / summaryLength
} else {
  agentState.messageHistory = [
    userMessage(withSystemTags(
      `The following is a summary of the conversation between you and the user. ` +
      `The conversation continues after this summary:\n\n${summary}`,
    )),
  ]
}
```

注意：寫入的是 `summary`，不是 `fullResponse`。這會自動丟掉模型在標題前的開場白。

**不做自動重試**：格式不符就走 `compact_skipped`（歷史保留、使用者可重試）。若實際失敗率偏高再加 nudge，屆時需能看到第二次呼叫的成本。

**變更點**

- `packages/agent-runtime/src/system-prompt/prompts.ts`（`compactPrompt` 文字）
- `packages/agent-runtime/src/util/summary-format.ts`（新）
- `packages/agent-runtime/src/run-agent-step.ts`

**測試**

- `summaryFromReply`：正常摘要、有開場白、只有 `<think>`、無標題、翻譯標題。
- 摘要本體含 `<conversation_summary>` → 視為不可用（跳過，保留歷史）。
- `isUsableSummary`：6 段通過、5 段失敗、標題齊全但內文 < 400 字失敗。
- `runAgentStep`：無效摘要 → 歷史不變 + `compact_skipped`。
- `runAgentStep`：有效摘要 → 歷史被替換，且內容不含開場白。

**風險**

- 模型可能把 `## ` 放進 code block；機率低，且失敗模式是「保留歷史」，不是資料遺失。
- **既有測試需更新**：`compact-command.test.ts` 的「clean summary」fixture 目前是 `'Earlier we fixed the login bug in auth.ts.'`，沒有標題，會落到跳過路徑。必須換成有效的八段 fixture。詳見 §5。

---

### 工作項 5：保留逐字尾段

**問題**

成功時整段歷史被換成 `[summary]`，包含最後一輪對話。摘要再怎麼寫，都會丟掉「剛剛的 tool 輸出長什麼樣」「使用者最後一句的確切措辭」。機械式壓縮有 `splitTail`（最多 8 組 tool pair、10k tokens）保留尾段；手動沒有。

**設計**

新增 `packages/agent-runtime/src/util/compaction-tail.ts`：

```ts
export const COMPACT_TAIL_MAX_TOKENS = 10_000

/**
 * 回傳可逐字接在摘要後面的尾段。
 *
 * - 排除 scaffolding（STEP_PROMPT / INSTRUCTIONS_PROMPT / USER_PROMPT / SUBAGENT_SPAWN）
 * - 以「assistant 訊息 + 其後的 tool 訊息」為一個 exchange
 * - 從最新往回取，總量不超過 maxTokens
 * - 結果一定從 assistant 開始（不會有孤兒 tool 訊息）
 * - 單一 exchange 就超過預算時回傳空陣列
 */
export function keepTailForCompaction(params: {
  messages: Message[]
  maxTokens?: number
}): Message[]
```

實作要點：

1. 先過濾掉 `STEP_PROMPT`、`INSTRUCTIONS_PROMPT`、`USER_PROMPT`、`SUBAGENT_SPAWN`、`role === 'system'`，以及**既有的機械摘要**——判定與 `compact-history.ts` 的 `isConversationSummary` 同形：同時含 `<conversation_summary>` 與 `SUMMARY_HEADER`。只用 tag 會誤丟「使用者貼了一段含該字串的文字」。
2. 掃描出所有 assistant 訊息的索引，切成 exchange。**exchange 只包含 assistant 及其後的 `role:'tool'` 訊息；遇到任何非 tool 訊息（含 user-role 的 `TOOL_CALL_ERROR`）就結束當前 exchange**，避免跨 exchange 選取把孤兒 tool 結果帶進 tail。也因為它不屬於任何 exchange，`TOOL_CALL_ERROR` **不會**被帶進 tail。
3. 從最後一個 exchange 往前累加，直到超過 `maxTokens`。
4. 若第一個被選中的 exchange 本身超過預算，回傳 `[]`（不要為了保留尾段而讓壓縮失效）。

在 `runAgentStep` 的成功分支：

```ts
const tail = keepTailForCompaction({ messages: history })
agentState.messageHistory = [summaryMessage, ...tail]
```

`history` 是 `runAgentStep` 開頭已算好的 `dropUnansweredToolCalls(expireMessages(agentState.messageHistory, 'agentStep'))`，也就是**本步之前**的乾淨歷史。

**為什麼是 10k**：與 `compact-history.ts` 的 `DEFAULT_TAIL_BUDGET` 一致，讓手動與機械的結果大小落在同一個量級。

**不 import `compact-history.ts` 的 `splitTail`**：那會把兩個模組綁死。這裡只需 20 行，且規則不同（機械的 tail 以 tool pair 為單位，這裡以 assistant 為單位）。

**測試**

- tail 從 assistant 開始。
- tail 不含 `STEP_PROMPT` / `INSTRUCTIONS_PROMPT` / `USER_PROMPT`。
- tail 不含孤兒 tool 訊息。
- 預算內全部保留；超出時丟掉最舊的 exchange。
- 單一巨大 exchange → `[]`。
- 沒有 assistant 訊息 → `[]`。
- assistant 帶 reasoning + tool results → 整個 exchange 完整保留（鎖住與 ADR-26 `splitTail` 的等價語義）。
- 既有的機械摘要（同時含 tag 與 `SUMMARY_HEADER`）→ 不進 tail。
- 使用者訊息只含 `<conversation_summary>`（沒有 `SUMMARY_HEADER`）→ 保留在 tail。
- `SUBAGENT_SPAWN` 不進 tail。
- user-role 的 `TOOL_CALL_ERROR` **不進 tail**（它不屬於任何 exchange；失敗與重試指示由摘要承接）。
- exchange 不跨越非 tool 訊息（含 user-role 的 `TOOL_CALL_ERROR`）。

**風險**

- tail 邊界錯會讓 provider 回 400。上述測試必須覆蓋「tail 第一則不是 tool」。
- tail 之後會被機械式壓縮當普通歷史處理（跟現在一樣），沒有新風險。
- 既有測試 `expect(history).toHaveLength(1)` 會變成 `1 + tail`，需更新。

---

### 工作項 6：成功壓縮的回報形狀

**問題**

成功壓縮後 `agentState.messageHistory` 只剩一則 user 訊息。`loopAgentSteps()` 結尾呼叫 `getAgentOutput()`（`packages/agent-runtime/src/util/agent-output.ts`）；`outputMode: 'last_message'` 且找不到 assistant 訊息時回傳：

```ts
{ type: 'error', message: 'No response from agent' }
```

host 的 `classifyInterrupted()`（`packages/host-core/src/run/start-run.ts:1333`）看到 `output.type === 'error'` 就判定 `interrupted: true`。結果：**一次成功的 `/compact` 被回報成執行中斷**。

工作項 5 的尾段會讓歷史重新出現 assistant 訊息，因而「意外」掩蓋這個問題；但尾段可能為空（例如第一輪就壓縮），而且把上一輪的 assistant 訊息當成這一輪的 output 語意也不對。必須明確修正。

**設計（與上游同構）**

1. 在 `loopAgentSteps()` 開頭算一次：

   ```ts
   const manualCompaction = isCompactCommandPrompt(prompt)
   ```

2. 摘要步驟完成後顯式中止該輪（**不論成功或跳過**；跳過時使用者會看到 `compact_skipped` 通知）：

   ```ts
   if (manualCompaction) break
   ```

   （不要依賴 `shouldEndTurn`：模型若在摘要後成功呼叫工具，`shouldEndTurn` 會是 false。）

3. 迴圈結束、準備回傳時：

   ```ts
   output: manualCompaction
     ? { type: 'lastMessage', value: [] }
     : getAgentOutput(currentAgentState, agentTemplate)
   ```

4. `AgentOutputSchema` 的 `lastMessage` 是 `z.array(z.any())`，允許空陣列，**不需要新增 variant**。
5. `classifyInterrupted()` 看到 `type !== 'error'` 就回 `null` → `finishRun(..., { interrupted: false })`。

**為什麼不從 `runAgentStep()` 回傳旗標**

`runAgentStep()` 的回傳型別是上游 merge 會 reconcile 的面；新增欄位會讓每次 sync 都要處理。loop 級 predicate 與上游逐字同構，技術上等價：compact turn 是單步、`prompt` 不會被 steering 改動（ADR-30 只 append history）。

**不在範圍**：上游另外用 `initialAgentState.systemPrompt` / `toolDefinitions` 重用既有 prompt（省一次 file tree 計算）；AnyBuff 每個 run 本來就重建一次，這個優化沒有對應的接縫。

**為什麼是空 `lastMessage` 而不是 `allMessages`**

`allMessages` 會把摘要訊息當成這一輪的答案回給呼叫端，可能造成重複顯示。`lastMessage: []` 表示「這一輪沒有新的助手回覆」，語意正確。

**SDK/CLI 影響**

`run()` 的 `output` 會是空的。CLI 已經在串流中顯示摘要文字，不需要額外輸出。這是刻意的。

**測試**

- `loopAgentSteps` 回傳 `output.type === 'lastMessage'` 且 `value` 為空。
- 摘要後模型成功呼叫工具時，該輪仍然結束（`if (manualCompaction) break`）。
- 非壓縮的一般回合不受影響（回歸）。
- host 端以手動驗證：成功 `/compact` 後 `run_status` 應為 `idle`，不是 `interrupted`。

**風險**：低。改的是回傳形狀，不動歷史。

---

### 工作項 7：Activity 面板標籤

**問題**

`desktop/src/renderer/src/components/ActivityPanel.tsx:16`：

```ts
context_compaction: { icon: '□', label: 'Context compacted' },
```

`filtered` 對 `filter === 'all'` 不做型別過濾，所以 `compact_skipped` 事件也會進 Activity 分頁，被標成「Context compacted」——與事實相反。聊天區是對的（`compaction-note.ts` 走 `kind: 'system'`），只有右側面板誤導。

**設計**

把「事件 → 標籤」抽成純函式，沿用 `compaction-note.ts` 的模式：

```ts
// desktop/src/renderer/src/utils/activity-meta.ts
export function metaForEvent(event: { type: string; action?: string }) {
  if (event.type === 'context_compaction') {
    if (event.action === 'compact_skipped')
      return { icon: '⏸', label: 'Compaction skipped' }
    if (event.action === 'mechanical_trim')
      return { icon: '□', label: 'Context trimmed' }
    return { icon: '□', label: 'Context compacted' }
  }
  return EVENT_META[event.type]
}
```

`ActivityPanel` 改成呼叫它；`EVENT_META` 只留非 `context_compaction` 的條目。

**測試**：`desktop/test/activity-meta.test.ts`（新），覆蓋三種 `context_compaction` action 與一個非 compaction 事件。

**風險**：無（純顯示）。

---

### 工作項 8：`stripThinkTags` 支援 `<thinking>`

**問題**

`packages/agent-runtime/src/util/think-tags.ts` 只處理 `<think>`、未閉合的 `<think>` 與孤兒 `</think>`。部分 provider 會把 `<thinking>…</thinking>`（或 `</thinking>`）留在 content，這些回應會被視為「有內容」：

- `isThinkOnlyResponse()` 回 false → think-only 守衛失效。
- 在一般回合，模型可能因此直接結束 turn，而不是繼續。
- 在手動壓縮，`summaryFromReply()` 會拿到一段沒有 `## ` 的 thinking 文字 → 格式驗證仍會擋下（結果安全），但錯誤分類變成「格式不符」而不是「think-only」。

**設計**

把 `stripThinkTags()` 的 regex 擴充為同時接受兩種標籤：

```ts
export function stripThinkTags(text: string): string {
  return text
    .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/g, '')
    .replace(/<(?:think|thinking)>[\s\S]*$/g, '')
    .replace(/<\/(?:think|thinking)>/g, '')
    .trim()
}
```

（`(?:...)` 不用捕獲組；不比對大小寫，維持與現有行為一致。）

**影響範圍（必須知道）**

目前 `stripThinkTags()` 的唯一消費者是 `isThinkOnlyResponse()`（一般回合的「think-only 就繼續，不要結束 turn」判斷）。工作項 4 落地後會多第二個消費者：`summaryFromReply()` 直接呼叫它，因此摘要抽取也會一併免疫 `<thinking>` 洩漏——這是工作項 4 的增益。

手動壓縮的守衛在本計畫後不再直接呼叫 `isThinkOnlyResponse()`（改用 `summaryFromReply()` + `isUsableSummary()`），但一般回合的續跑判斷仍靠它。所以 `<thinking>` 的擴充仍然影響所有 agent，不只是 `/compact`。

**不影響機械式壓縮**：`compact-history.ts` 自己有 inline 的 `.replace(/<think>[\s\S]*?<\/think>/g, '')`，沒有使用這個 helper。因此機械式壓縮的行為不變（它仍然只剝 `<think>`）。這個不對稱是刻意的：改 `compact-history.ts` 會違反硬約束。

**變更點**

- `packages/agent-runtime/src/util/think-tags.ts`
- `packages/agent-runtime/src/util/__tests__/think-tags.test.ts`

**測試**

- `<thinking>…</thinking>` 被剝除。
- 未閉合的 `<thinking>…` 被剝除。
- 孤兒 `</thinking>` 被剝除。
- 混合 `<think>` 與 `<thinking>`。
- `isThinkOnlyResponse('<thinking>x</thinking>') === true`。
- 一般文字中的 `<thinking>` 字樣（若只是單一標籤、沒有內容）行為與 `<think>` 一致。

**風險**

- 若模型在正文裡合法地提到 `<thinking>`（例如解釋 XML），會被剝掉。與 `<think>` 既有的風險同級，可接受。
- 一般回合的 think-only 行為改變，需在變更說明中標註。

---

### 工作項 9：桌面／Android 的 `/compact` 入口

**問題**

`desktop/src/renderer/src/components/Composer.tsx:104-108` 的 `SLASH_COMMANDS` 只有 `init`、`review`、`interview`。`/compact` 可用但不可發現——使用者必須知道這個字串才能觸發。Android 共用同一份 renderer，同樣沒有入口。

**設計**

#### 9.1 指令清單

```ts
const SLASH_COMMANDS = [
  { id: 'init', ... },
  { id: 'review', ... },
  { id: 'interview', ... },
  {
    id: 'compact',
    label: 'compact',
    description: 'Summarize earlier messages to free context (the transcript stays visible)',
  },
]
```

`selectSkill()` 新增：

```ts
else if (skill.id === 'compact') onCompactRequest()
```

#### 9.2 確認對話框

`/compact` 會改變模型看到的歷史，不是純唯讀操作，所以先確認再送出。新增 `desktop/src/renderer/src/components/CompactConfirmModal.tsx`（樣式沿用 `ReviewScopePanel.tsx` 的 `modal-backdrop` / `modal` / `modal-actions`）：

- 標題：`Compact this conversation?`
- 說明：

  > Earlier messages will be replaced by a summary. The transcript stays visible in this chat, but the model will continue from the summary — details it leaves out are lost to the model.
- 目前用量：`Current context: {formatTokenCount(used)} / {formatTokenCount(max)} tokens`
- 主按鈕：`Compact`；次按鈕：`Cancel`
- `used === 0` 或 `running` 時停用主按鈕，並顯示對應說明（`Nothing to compact yet.` / `Wait for the current run to finish.`）

純邏輯抽成 `desktop/src/renderer/src/utils/compact-confirm.ts`：

```ts
export function compactConfirmState(params: {
  used: number
  max: number
  running: boolean
}): { canConfirm: boolean; note?: string }
```

#### 9.3 App 接線

- `App.tsx` 新增 `compactConfirmOpen` state。
- `onCompactRequest={() => setCompactConfirmOpen(true)}`。
- 確認時：`void send('/compact', '/compact')`（與 `runInitKnowledge` 相同模式：顯示文字與最終 prompt 相同），關閉 modal。
- `running` / `busyElsewhere` 時不允許開啟或送出。

#### 9.4 Android

Android 共用同一份 renderer，入口與 modal 自動生效。不需要額外程式碼；建置後手動確認 slash 清單與 modal 版面。

**變更點**

- `desktop/src/renderer/src/components/Composer.tsx`
- `desktop/src/renderer/src/components/CompactConfirmModal.tsx`（新）
- `desktop/src/renderer/src/utils/compact-confirm.ts`（新）
- `desktop/src/renderer/src/App.tsx`

**測試**

- `desktop/test/compact-confirm.test.ts`（新）：三種狀態（可用、太短、執行中）。
- `Composer` 的 slash 清單包含 `compact`（可把 `SLASH_COMMANDS` 抽到 `utils/composer-commands.ts` 以便測試；若不想搬，至少手動驗證）。
- 手動：桌面與 Android 各選一次 `/compact`，確認 modal 文案、送出、成功後摘要顯示、context meter 下降。
- 手動：在執行中的 run 上確認主按鈕停用。

**風險**

- 這個入口讓「小對話按了也會呼叫模型」變得更容易遇到。`compactConfirmState` 在 `used === 0` 時擋住，但 1k tokens 的對話仍會送出。這是刻意的取捨（沒有 no-op 門檻）；modal 的用量顯示可讓使用者自己判斷。
- 成功後若工作項 6 未完成，host 會把 run 標成中斷；因此工作項 9 依賴工作項 6。

---

### 工作項 10：`INSTRUCTIONS_PROMPT` 的 per-turn TTL

**問題**

`loopAgentSteps()` 每一輪都會：

1. 用 `getAgentPrompt({ promptType: 'instructionsPrompt' })` 產生當輪的 instructions。
2. 把它放進 `initialMessages`：

   ```ts
   userMessage({
     content: instructionsPrompt,
     tags: ['INSTRUCTIONS_PROMPT'],
     keepLastTags: ['INSTRUCTIONS_PROMPT'],
   })
   ```

但三個事實疊加，讓它永遠不會被移除：

- `userMessage()`（`common/src/util/messages.ts:598`）**不設 `timeToLive`**。
- `expireMessages()`（`packages/agent-runtime/src/util/messages.ts:283`）**只依 `timeToLive` 過濾**，完全不看 `keepLastTags`。
- `keepLastTags` 只出現在型別宣告（`common/src/types/messages/codebuff-message.ts:29`、`agents/types/util-types.ts:108`）與這一處賦值，**沒有任何程式碼讀它**。

唯一的清理點是機械式壓縮——`compact-history.ts` 把 `INSTRUCTIONS_PROMPT` 列在 `SCAFFOLDING_TAGS`（:421），壓縮時只保留最後一則（:1279）。

**實測大小**（`bundled-agents.ts` 的 `instructionsPrompt` 字元數 / 3）

| Agent              | 每輪                          | 10 輪累積     |
| ------------------ | ----------------------------- | ------------- |
| base-deep          | ~3,857 tokens                 | ~38.6k tokens |
| base2              | ~1,240 tokens                 | ~12.4k tokens |
| base2-lite         | ~1,108 tokens                 | ~11.1k tokens |
| base-chat          | ~551 tokens                   | ~5.5k tokens  |
| base3 / base3-lite | 0（沒有 instructions prompt） | 0             |

（實際注入值可能更大：`getAgentPrompt` 會再套模板變數與工具說明。）

**後果**

1. **`contextTokenCount` 虛高**：`estimateContextTokensLocally()` 計入整份 `messageHistory`，包含所有重複的 instructions。context meter 會比實際送出的內容大。
2. **自動壓縮提前觸發**：`maybeCompactHistory` 用同一個計數，因此會比實際需要更早壓縮。壓縮是資訊損失，提前發生就是成本。
3. **成本**：重複的 instructions 會被送出。它們在 `initialMessages` 的尾端，不破壞 prefix cache，但仍佔用視窗。
4. 只在「距離上次機械式壓縮」的區間內累積；有 `compactContext` 或 pruner 的 agent 會被定期清掉。但 base-deep 這種 instructions 很大的 agent，區間內就可能累積數萬 tokens。

**設計**

把它標成 per-turn scaffolding：

```ts
userMessage({
  content: instructionsPrompt,
  tags: ['INSTRUCTIONS_PROMPT'],
  timeToLive: 'userPrompt',
})
```

- turn 結尾的 `expireMessages(history, 'userPrompt')` 會清掉它。
- 下一輪 `loopAgentSteps` 會重新產生一則。
- 該輪中 `expireMessages(..., 'agentStep')` 不會移除 `userPrompt` TTL，所以模型看到的內容不變。

**不影響機械式壓縮**：`compact-history.ts` 本來就排除 `INSTRUCTIONS_PROMPT`，所以壓縮行為不變。

**subagent**：`clearUserPromptMessagesAfterResponse` 為 false，不會執行清理；其 state 也會被丟棄，無影響。

**與工作項 3 的關係**：兩者使用同一個 TTL 機制。建議一起實作、一起測，因為工作項 3 是這個機制的第一個 production 使用點。

**變更點**

- `packages/agent-runtime/src/run-agent-step.ts`

**測試**

- 新增 `packages/agent-runtime/src/__tests__/instructions-prompt-ttl.test.ts`：
  - 一輪結束後，`messageHistory` 不含 `INSTRUCTIONS_PROMPT`。
  - 連續兩輪不累積。
  - 一般 user prompt 仍在歷史（回歸）。
  - 該輪的模型請求仍包含 instructions（用 mock 的 `promptAiSdk` 斷言 messages）。
- 既有 `loop-agent-steps.test.ts` 若斷言歷史長度，需同步更新。

**風險**

- 這是**所有 agent** 的行為改變（persisted history 少一則），不是只有 `/compact`。
- 若某個 root agent 傳 `clearUserPromptMessagesAfterResponse: false`，清理不會發生；需確認沒有這種 root。
- 若未來有人依賴「instructions 跨輪存在」，會壞；目前沒有任何程式碼這樣做。
- 這是 **AnyBuff 分歧**（上游至今沒有 per-turn TTL、`keepLastTags` 也還在）。ADR-37 維護注意必須登記，否則上游 merge 會用無 TTL 版覆蓋。
- **不要刪 `keepLastTags`**：它雖然是死碼，但上游也留著；刪除只會增加 merge 面積。

---

## 5. 對既有測試的影響

| 檔案                                                            | 影響                                                                                          | 處理                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/agent-runtime/src/__tests__/compact-command.test.ts`  | 「clean summary」fixture 沒有 `## ` 標題，工作項 4 之後會落到跳過路徑                         | 換成有效的八段 fixture（可放在檔案常數 `VALID_SUMMARY`）             |
| 同上                                                            | `expect(history).toHaveLength(1)` 會變成 `1 + tail`                                           | 改成斷言 `history[0]` 是摘要、`history.length >= 1`，或明確斷言 tail |
| 同上                                                            | 需要新增 `/Compact`、`/COMPACT`、格式不符、`toString`、TTL、output 形狀的案例                 | 見 §6                                                                |
| `packages/agent-runtime/src/util/__tests__/think-tags.test.ts`  | 新增 `<thinking>` 案例（工作項 8）                                                            | 擴充既有檔案                                                         |
| `desktop/test/`                                                 | 新增 `compact-confirm.test.ts`；若抽出 slash 清單再加 `composer-commands.test.ts`（工作項 9） | 見 §6                                                                |
| `packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts` | 若斷言歷史長度，工作項 10 會少一則                                                            | 同步更新，或改用 tag 斷言                                            |
| 其他                                                            | 無                                                                                            | `compactPrompt` 文字沒有被任何測試直接斷言（已確認 grep 無命中）     |

---

## 6. 測試矩陣

| 檔案                                                                         | 案例                                        | 期望                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/agent-runtime/src/__tests__/compact-command.test.ts`               | `/compact` + 有效摘要                       | 歷史被替換；`history[0]` 含 `The following is a summary`；不含 `<conversation_summary>` |
| 同上                                                                         | `/Compact` / `/COMPACT`                     | 歷史不變；無 `compact_skipped`（因為根本沒進分支）                                      |
| 同上                                                                         | `/compact` + 只有 5 個 `## ` 段落           | 歷史不變；`compact_skipped`                                                             |
| 同上                                                                         | `/compact` + 標題齊全但內文 < 400 字        | 歷史不變；`compact_skipped`                                                             |
| 同上                                                                         | `/compact` + 空字串 / think-only / 工具錯誤 | 歷史不變（既有 4 案例）                                                                 |
| 同上                                                                         | `/compact` 成功                             | `output.type === 'lastMessage'`、`value` 為空                                           |
| 同上                                                                         | 跳過 `/compact` 後                          | 歷史不含 `/compact`，也不含 `User has typed "compact"`                                  |
| 同上                                                                         | 一般 prompt                                 | 該 prompt 仍在歷史（TTL 未被誤加）                                                      |
| `packages/agent-runtime/src/util/__tests__/summary-format.test.ts`（新）          | `summaryFromReply` 五種輸入                 | 見工作項 4                                                                              |
| `packages/agent-runtime/src/util/__tests__/compaction-tail.test.ts`（新）         | 六種邊界                                    | 見工作項 5                                                                              |
| `desktop/test/activity-meta.test.ts`（新）                                   | 三種 action + 一般事件                      | 見工作項 7                                                                              |
| `packages/agent-runtime/src/util/__tests__/think-tags.test.ts`               | `<thinking>` / 未閉合 / 孤兒 / 混合         | 全部剝除；`isThinkOnlyResponse` 為 true                                                 |
| `desktop/test/compact-confirm.test.ts`（新）                                 | used=0 / running / 正常                     | `canConfirm` 與 `note` 正確                                                             |
| `desktop/test/composer-commands.test.ts`（新，若抽出清單）                   | slash 清單                                  | 含 `compact`，id 不重複                                                                 |
| `packages/agent-runtime/src/__tests__/instructions-prompt-ttl.test.ts`（新） | 單輪 / 連兩輪 / 一般 prompt / 模型請求內容  | 不累積、一般 prompt 保留、請求仍有 instructions                                         |

---

## 7. 驗證指令

```bash
# runtime
cd packages/agent-runtime && bun test \
  src/__tests__/compact-command.test.ts \
  src/util/__tests__/summary-format.test.ts \
  src/util/__tests__/compaction-tail.test.ts \
  src/util/__tests__/think-tags.test.ts \
  src/__tests__/instructions-prompt-ttl.test.ts

# renderer
cd desktop && bun test test/activity-meta.test.ts test/compaction-note.test.ts test/compact-confirm.test.ts

# 型別
cd desktop && bun run typecheck

# SDK 建置（agent-runtime 改動後 desktop 消費 dist/）
bun run build:sdk

# host-core（§13.3 的用量還原會改到）
bun run typecheck:host-core
bun run build:host-core
bun run test:host-core
```

不需要：

- `bun scripts/generate-desktop-agents.ts`（`agents/` 未改）

> 只重跑 §4 的十個工作項時，host-core 未改，可略過上面的 host-core 指令；§13.3 的用量還原一定會動到它。
> `bun --cwd desktop run typecheck` 在此 Bun 版本會印出 usage、不執行任何檢查；正確寫法是 `cd desktop && bun run typecheck`。

---

## 8. 風險與回滾

| 工作項 | 風險                                                                                | 回滾                        |
| ------ | ----------------------------------------------------------------------------------- | --------------------------- |
| 1      | `/Compact` 不再壓縮（行為改變，但只影響非精確輸入）                                 | 還原一個函式 + 一行呼叫     |
| 2      | 極低                                                                                | 改回 `in`                   |
| 3      | 首次啟用 `timeToLive: 'userPrompt'` 的 production 路徑                              | 移除兩個條件散佈            |
| 4      | 模型不服從模板 → 失敗率上升（失敗模式是保留歷史，不是資料遺失）                     | 還原 `compactPrompt` 與驗證 |
| 5      | tail 邊界錯 → provider 400                                                          | 還原為 `[summary]`          |
| 6      | SDK `output` 變成空陣列                                                             | 還原回傳                    |
| 7      | 無                                                                                  | 還原元件                    |
| 8      | 一般回合的 `<thinking>`-only 行為改變（改為繼續而不是結束）                         | 還原 regex                  |
| 9      | 入口讓小對話誤按更容易；且依賴工作項 6 的回報形狀                                   | 移除清單項目與 modal        |
| 10     | 所有 agent 的 persisted history 少一則；依賴 `clearUserPromptMessagesAfterResponse` | 移除 `timeToLive`           |

**不可變式**（實作時必須守住）：

- 成功摘要維持無 tag、無信封。
- 守衛的三個條件（空、think-only、`hadToolCallError`）不得放寬。
- 機械式壓縮的檔案一行都不改。
- `/compact` 成功後仍然結束該 turn。

---

## 9. 已知限制（本計畫不處理）

1. **摘要在後續機械式壓縮中仍會被當一般 `[USER]` 條目**，且在 user 預算（50k）用完時是最先被丟的。這是「無 tag」設計的代價，也是本計畫刻意不改的部分。
2. **摘要步驟若同時有成功的工具呼叫**，歷史仍會被替換，該工具結果只存在於被丟棄的歷史中。模型在 `/compact` 時呼叫工具的機率低，暫不加入額外守衛。
3. **沒有小對話的 no-op 門檻**：在極短的對話上按 `/compact` 仍會呼叫模型一次（工作項 9 的確認框會顯示用量，但不會阻止）。
4. **機械式壓縮仍只剝 `<think>`，不剝 `<thinking>`**。工作項 8 只改 `stripThinkTags`（手動路徑與一般回合的守衛）；`compact-history.ts` 的 inline regex 不在範圍內。
5. **摘要被輸出上限截斷時，格式驗證不一定擋得住**：截斷點若仍留下 ≥6 個 `## ` 與 ≥400 字，`isUsableSummary` 會放行，歷史仍被替換。真正的防線是 `finishReason === 'length'`，但 `processStream()` 目前不回傳 finishReason。
6. **`/compact` 繼承使用者的 reasoning effort**：高 effort 的 thinking 模型可能把輸出預算餵給 reasoning，導致摘要很慢或被截斷（上游實測 150k 摘要 304 秒）。把 effort clamp 到 low 是階梯內的合法檔位（不違反 ADR-10 的「不抑制」），但仍應走一個新 ADR；本計畫不做。

---

## 10. 完成定義

- [x] `/Compact`、`/COMPACT` 不再覆寫歷史
- [x] `toString` 不再注入系統指令
- [x] 跳過後歷史不含 `/compact` 與其說明訊息；一般 prompt 不受影響
- [x] 無效摘要（段落 < 6 或內文 < 400 字）不改寫歷史
- [x] 成功摘要保留逐字尾段，且 tail 從 assistant 開始
- [x] 成功 `/compact` 的 `output` 不是 `type: 'error'`
- [x] Activity 面板顯示「Compaction skipped」
- [x] `<thinking>`-only 回應被視為 think-only
- [x] 桌面／Android slash 清單有 `compact`，確認 modal 可送出
- [x] 空對話或執行中時，確認 modal 的主按鈕停用
- [x] `INSTRUCTIONS_PROMPT` 不再跨輪累積，且該輪模型請求仍含 instructions
- [x] 手動 `/compact` turn 不觸發機會性機械壓縮（inline context-pruner／`maybeCompactHistory`）
- [x] 舊 runstate 的污染摘要會在手動 compact turn 被修復，且 host-core bundle 重建後生效
- [x] 上述測試全綠（`packages/agent-runtime` 691 pass；desktop 壓縮相關 17 pass；host-core 229 pass）
- [x] `cd desktop && bun run typecheck` 通過
- [x] `bun run build:sdk` 通過
- [x] ADR-37 的「維護注意」追加：**指令辨識一律使用 `isCompactCommandPrompt`／`hasAdditionalSystemPrompt`，不得用 `prompt.toLowerCase()` 比對，也不得用 `in` 查表**
- [x] §5 維護帳本新增一列「手動壓縮硬化」，列出與上游的分歧：`Object.hasOwn`、per-turn scaffolding TTL、10k verbatim tail、八段模板＋驗證、`<thinking>` 剝除
- [x] ADR-37 維護注意列出同一份分歧清單，並註明上游 merge 不得以 `in`／無 TTL 版覆蓋
- [x] 只有工作項 1（`isCompactCommandPrompt`）與工作項 6（`lastMessage: []`）是回歸上游，其餘不得標成「已與上游收斂」

實作後的追加（錯誤路徑 TTL、摘要後工具呼叫契約、用量還原）見 §13。

---

## 11. 檔案清單

**修改**

- `packages/agent-runtime/src/system-prompt/prompts.ts`
- `packages/agent-runtime/src/run-agent-step.ts`
- `packages/agent-runtime/src/util/think-tags.ts`
- `packages/agent-runtime/src/__tests__/compact-command.test.ts`
- `packages/agent-runtime/src/util/__tests__/think-tags.test.ts`
- `packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts`（視既有斷言）
- `desktop/src/renderer/src/components/ActivityPanel.tsx`
- `desktop/src/renderer/src/components/Composer.tsx`
- `desktop/src/renderer/src/App.tsx`
- `desktop/src/renderer/src/components/CompactConfirmModal.tsx`（§13.3 的用量顯示）
- `desktop/src/renderer/src/utils/compact-confirm.ts`（§13.3 的 `usageKnown`）
- `desktop/test/compact-confirm.test.ts`（§13.3 的未知用量案例）
- `packages/host-core/src/contracts/types.ts`（§13.3：`TaskViewSnapshot`）
- `packages/host-core/src/sessions/session-store.ts`（§13.3：讀取持久化用量）
- `packages/host-core/src/channels/handlers-projects.ts`（§13.3：回傳用量與 context window）
- `packages/host-core/src/run/start-run.ts`（§13.3：export `resolveRoutedModelForRun`）
- `AnyBuff 專案全貌與維護者指南.md`（ADR-37 維護注意；此檔被 `.gitignore` 排除，不進 commit）

**新增**

- `packages/agent-runtime/src/util/summary-format.ts`
- `packages/agent-runtime/src/util/compaction-tail.ts`
- `packages/agent-runtime/src/util/__tests__/summary-format.test.ts`
- `packages/agent-runtime/src/util/__tests__/compaction-tail.test.ts`
- `packages/agent-runtime/src/__tests__/instructions-prompt-ttl.test.ts`
- `desktop/src/renderer/src/utils/activity-meta.ts`
- `desktop/test/activity-meta.test.ts`
- `desktop/src/renderer/src/components/CompactConfirmModal.tsx`
- `desktop/src/renderer/src/utils/compact-confirm.ts`
- `desktop/test/compact-confirm.test.ts`
- `desktop/src/renderer/src/utils/composer-commands.ts` + `desktop/test/composer-commands.test.ts`
- `packages/host-core/src/__tests__/task-view-context-usage.test.ts`（§13.3：live 與重啟後的用量）

**不動（§4 的十個工作項）**

- `packages/agent-runtime/src/compact-history.ts`
- `agents/context-pruner.ts`、`packages/host-core/src/agents/bundled-agents.ts`
- `common/src/types/**`、`common/src/constants/compaction.ts`
- `packages/host-core/**`、`sdk/**`

> §13.3 的用量還原是唯一的例外：它只讀 `runState.sessionState.mainAgentState.contextTokenCount`、不改寫入格式，也不碰機械式壓縮。`compact-history.ts`、`context-pruner`、`bundled-agents.ts`、`Message` schema 在整個實作（含追加項）中一行都沒改。

---

## 12. 實作順序與依賴

```
1. 指令辨識精確化 ──┐
2. 指令表硬化     ──┤（同一組 predicate，一起做）
                    ├─→ 3. 指令不外洩（依賴 isCompactCommandPrompt）
                    │
4. 摘要模板與驗證 ──┼─→ 5. 逐字尾段（依賴成功分支的改寫）
                    ├─→ 6. 成功回報形狀（依賴 4/5 的成功判定）
                    └─→ 9. 桌面入口（依賴 6）
8. `<thinking>` 支援（與 4 同批，共用 stripThinkTags）
10. INSTRUCTIONS_PROMPT TTL（與 3 同一機制）
7. Activity 標籤（完全獨立）
```

- 工作項 1、2 應第一批完成：它們修的是資料遺失。
- 工作項 3 可在 1 之後任何時間做。
- 工作項 4、5、6、9 建議一起做並一起測，因為它們共同改變「成功壓縮後歷史長什麼樣、回報什麼、入口在哪」。
- 工作項 8 與 4 同批：兩者都決定「什麼算可用摘要」。
- 工作項 10 與 3 同批：兩者都是 per-turn scaffolding 的 TTL。
- 工作項 7 可隨時插入。

---

## 13. 實作後的補強（2026-11-03）

§4 的十個工作項在 `d5c55f385` 落地。之後的複查找到三個縫隙，補強如下。

### 13.1 `/compact` 錯誤路徑的 TTL 清理

**問題**：計畫原本寫「正常／abort／error 三條路徑都有 `expireMessages(..., 'userPrompt')`」，實際只有成功與 abort。`/compact` 途中拋錯時，`/compact`、其說明訊息與 `INSTRUCTIONS_PROMPT` 會留到下一次成功回合。

**修正**（`run-agent-step.ts` 的 error 分支，於 `recountContextTokensForTurnEnd()` 之前）：

```ts
expireMessages(history, 'userPrompt')
```

只清 per-turn scaffolding。一般使用者訊息沒有 TTL，因此不會被誤刪。

**測試**：`drops the /compact scaffolding when the step throws`——mock stream 拋錯後，歷史保留先前對話，但不含 `/compact` 與 `User has typed "compact"`。已反向驗證：暫時移除修正時此測試會失敗。

### 13.2 摘要後呼叫工具的契約測試

**問題**：計畫 §6 明列「摘要後模型仍成功呼叫工具時，該輪必須結束」，實作有 `if (manualCompaction) break`，但沒有測試鎖住。

**測試**：`ends the turn after a summary even when the step calls a tool`——摘要有效且模型成功呼叫工具時，`promptAiSdkStream` 只被呼叫一次，`output` 為 `{ type: 'lastMessage', value: [] }`。

### 13.3 重開 task 的用量還原（A + B）

**問題**：確認 modal 用 `tokenUsage?.used ?? 0` 判斷，但 `tokenUsage` 只由 live `context_window` 事件填入：

1. App 重啟／新 task／跨專案開 task → `null`，modal 顯示 `0 / 0` 並停用「Compact」。
2. 同專案切換 task → `onOpenProject` 的 `if (path === cwd) return` 跳過 reset，modal 沿用**前一個 task** 的數字。
3. 背景 run 的 `context_window` 在 task gate 之前就 `setTokenUsage(...)`，會覆蓋目前檢視的用量。

根因是語意缺陷：`used === 0` 同時代表「已知為空」與「尚未量測」。

**Renderer（A）**

- `onOpenTask` 先 `setTokenUsage(null)`，消除跨 task 殘留。
- `context_window` 分支加上 `event.taskId === currentTaskRef.current` 過濾。
- `compactConfirmState` 改為接受 `usageKnown` 與 `hasConversation`：
  - `running` → 停用（優先）。
  - 沒有 user/assistant 訊息 → `Nothing to compact yet.`
  - 用量未知 → 允許確認，顯示 `Context usage will be measured during compaction.`
  - 用量已知且為 0 → `Nothing to compact yet.`
- 顯示：有 `max` 時 `used / max tokens`，沒有時只顯示 `used tokens`。

**Host 與 snapshot（B）**

- `TaskViewSnapshot` 新增 `contextTokenCount`（optional）與 `contextWindowTokensByMode`。
- `getSessionSnapshot` 從 live session 或磁碟 `runState.sessionState.mainAgentState.contextTokenCount` 取值（非數字回 `undefined`，不當成 0）。
- `getTaskView` 用 `resolveRoutedModelForRun` + `resolveEffectiveContextWindow` 解析 chat／agent／review 三個 UI mode 的目前模型視窗；解析失敗只回退 used-only，不擋快照。
- `start-run.ts` 只把 `resolveRoutedModelForRun` 加 export，行為不變。

**語意規則（ADR-37 維護注意已登記）**

> `used === 0` 只代表「已知為空」。用量未知時不得當成空對話而停用 `/compact`；`context_window` 事件必須按 `taskId` 過濾。

**測試**：`packages/host-core/src/__tests__/task-view-context-usage.test.ts` 鎖住 live 與重啟後磁碟兩條路徑；`desktop/test/compact-confirm.test.ts` 新增未知用量與無對話案例。

**已知近似**：`max` 依「目前 routing」解析。若上次 run 之後換過模型，`used / max` 會是近似值，下一次 `context_window` 事件會校正。

### 13.4 手動 `/compact` 不觸發機械壓縮

**問題**：`/compact` 是使用者主動要求的 LLM 摘要，但 `loopAgentSteps` 在每個 step 前會先跑機械壓縮：

- base2 / base2-plan / base-chat / base-deep：`handleSteps` spawn inline `context-pruner`
- base3 / base3-lite：`compactContext` → `maybeCompactHistory`

當對話閒置超過 cache TTL（base2 30 分鐘、base3 5 分鐘）後送 `/compact`，機械壓縮會把 `/compact` 與其說明訊息視為 mid-turn，摘要成：

```
Goal: <system_instructions>User has typed "compact"...
```

然後用 `Continue the existing assistant turn...` 取代 live prompt。模型只看到「繼續既有回合」，回了正常答案；`summaryFromReply` 正確地判定沒有可用摘要並跳過。使用者的實際 runstate 就是這個形狀。

**修正**（`run-agent-step.ts`）：

```ts
const manualCompactionTurn = manualCompaction && !initialAgentState.parentId
```

- `agentTemplate.compactContext && !manualCompactionTurn` 才跑 `maybeCompactHistory`
- `agentTemplate.handleSteps && !manualCompactionTurn` 才跑 `runProgrammaticStep`
- 子代理（`parentId` 有值）不受影響；只有根代理的 `/compact` turn 跳過。
- 機械壓縮仍保留為 **context-overflow resume** 的 fallback；它壓縮的是上一個 run 的歷史，`/compact` prompt 仍完整送達。

**語意**：機會性 cache-gap 機械壓縮不應介入使用者主動要求的 LLM 摘要；`/compact` 應盡可能看到原始歷史，而不是先被壓成一份機械摘要。

**測試**：

- `does not run the agent programmatic step on a manual compact turn`
- `does not mechanically compact the history before a manual compact turn`
- 兩者已反向驗證：移除 skip 條件時會失敗，且失敗輸出正好重現 `Goal: <system_instructions>...`。

**舊 runstate 修復**：pre-fix build 產生的機械摘要若把 compact instruction 存成 `Goal`，手動 compact turn 會用 `repairPollutedCompactHistory()` 中和該 Goal 並移除機械 continuation（保留 historical memory）。測試：`repairs a stale mechanical summary that treated /compact as the goal`。

**建置注意**：desktop main 只 external import `@codebuff/host-core`，而 `packages/host-core/dist` 會 bundle SDK／agent-runtime。改 `packages/agent-runtime` 後只跑 `bun run build:sdk` 不會更新 app，必須再跑 `bun run build:host-core` 並完整重啟主程序。

### 13.5 驗證結果

| 項目 | 結果 |
|---|---|
| `packages/agent-runtime` 全量 | 691 pass / 0 fail |
| `compact-command.test.ts` | 22 pass / 0 fail |
| `compact-command` + `compact-history` + `context-pruner-parity` | 85 pass / 0 fail |
| host-core 全量（`--timeout 10000`） | 229 pass / 0 fail |
| desktop 壓縮相關 4 檔 | 17 pass / 0 fail |
| `bun run typecheck:host-core` | 通過 |
| `bun run build:host-core` | 通過 |
| `cd desktop && bun run typecheck` | 通過 |
| `bun run build:sdk` | 通過 |

備註：`packages/host-core/src/__tests__/probe-samples.test.ts` 的 FIFO cap 測試本身要 5.1–6.4 秒，Bun 預設 5 秒會偶發 timeout，與本計畫無關；全量驗證使用 `--timeout 10000`。

---

## 附錄 A：參考資料

- 上游 Freebuff 的 `isCompactCommandPrompt` 設計（2026-11 的 `a559ec68e`）：精確比對、模板驗證、anchor 的概念來源。
- OpenCode（`anomalyco/opencode`，`dev`）的手動壓縮：`/compact` 作為 inbox control item、摘要作為獨立 `compaction` 資料列、讀取時以 `seq` 為邊界。本計畫只借用「指令不進歷史」與「固定模板＋驗證」兩個概念；**不**借用訊息型別與讀取邊界重構，因為那會改變機械式壓縮的觸發時機。
- 上游對照（2026-11，`a559ec68e`）：predicate 同名同構且內部仍用 `prompt in`；`manualCompaction` 在 loop 級、輸出 `{type:'lastMessage', value: []}`；`summaryFromReply` 兩段式；`compact-history.ts` 仍只剝 `<think>`。本計畫的工作項 1、6 是回歸，其餘是 AnyBuff 分歧。
