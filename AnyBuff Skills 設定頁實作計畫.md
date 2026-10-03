# AnyBuff Skills 設定頁實作計畫

> **文檔版本**：v1.3（2026-10-03——v1.3：**P0＋P1＋P2 全部實作完成**並通過 §9 自動化測試與評審修復（8 findings 全修）；P1 含 `listGithubSkills`／`downloadGithubSkill` 雙通道、≤30 檔／200KB／2MB 配額與 warning、api.github.com＋raw.githubusercontent.com 白名單、整包原子安裝；P2 含 frontmatter `metadata.source` provenance（manual/file/github＋列表徽章）與 `github-token` DPAPI vault（saveSettings payload：delete 先於 save）；真 API 實測通過（trees HEAD／raw HEAD／UA header，2026-10-03）；ADR-29 尚未補進維護手冊；v1.2：**編輯/刪除改平台分流**（Desktop 唯讀、Android 可編輯刪除，依 `HostEnv.globalSkillsScope` 單一來源、host 端強制；§10 待決的 Android 移除管道缺口以 D6 解決）；v1.1 評審修訂：① 列表改唯讀（全域目錄與其他 harness 共用）；② GitHub 下載改為整個 skill 子目錄安裝（含 reference 附檔）；③ 移除 Android 公開資料夾掛載（Skills 頁內建通道即足）；④ UI 說明文字改英文）
> **對應 App 版本**：`1.1.0` 後續
> **適用對象**：專案維護者、核心開發者、AI 協作 Coding Agent。
> **關聯文件**：《AnyBuff 專案全貌與維護者指南.md》（§2 不可退讓、ADR-11/13/21/27）、《AnyBuff Android 版實作計畫.md》。
> **定位聲明**：在 Settings 新增「Skills」分頁——全域 skills 的檢視與安裝（手動新增／從檔案匯入／從 GitHub 下載），並接通從未接線的全域 skill 掃描開關（SDK `includeHomeSkills`）。

---

## 1. 背景與現況盤點

### 1.1 兩條 skill 路徑與其掃描範圍（現況）

AnyBuff 裡 skill 有兩條互相獨立的路徑，掃描範圍不同：

| 路徑 | 觸發者 | 掃描範圍 | 程式位置 |
|---|---|---|---|
| **① `/skill:name` 選單注入** | 使用者在 Composer 打 `/` | 專案 cwd ＋ `os.homedir()`（**含全域**） | renderer `App.tsx` `buildFinalPrompt` → host-core `AnyBuff:listSkills` / `AnyBuff:readSkillFile`（`handlers-agents.ts`，純 fs 掃描） |
| **② agent 的 `skill` 工具** | 模型自己決定載入 | **只有專案 cwd** | SDK `loadSkills()`（run 開始時注入工具 description）＋ `packages/agent-runtime/.../skill.ts` `loadSkillFromDisk`（執行期 disk lookup） |

路徑②受 SDK 選項 `includeHomeSkills` 控制，**預設 `false`**（`sdk/src/skills/load-skills.ts`），且有**兩道獨立閘門**：

1. run 啟動時 `loadSkills({ includeHomeSkills })` — false 時不掃 `~/.agents/skills`、`~/.claude/skills`，工具 description 裡沒有全域 skill；
2. `skill` 工具執行端 `loadSkillFromDisk` 依 `fileContext.includeHomeSkills === true` 決定是否把 home 路徑加入查找清單（`skill.ts:50`）——false 時模型**猜到名字硬呼叫也撈不到**，回 `Skill not found.`。

### 1.2 核心缺陷：全域開關從未接線

- SDK `RunOptions.includeHomeSkills`（`sdk/src/run.ts:132`）→ `run-state.ts:718-741` **同一個 flag 同時管 loader 與 `fileContext`**（官方註解明寫 "one flag has to govern both or the opt-in is only half real"）——**通道已完整存在，SDK 零改動**。
- 但 host-core 的 run 發動點（`packages/host-core/src/run/start-run.ts` 的 `client.run({...})`，第 1120 行）**從未傳這個參數** → 恆為 `false`。
- 全庫 grep：只有上游 CLI（`cli/src/utils/skill-registry.ts`、`codebuff-client.ts`）傳 `true`，而 `cli/` 已移出建置圖（ADR-2）。
- **後果（Desktop 與 Android 完全同病）**：家目錄放的全域 skill 只有路徑①（手動 `/` 呼叫）可用；模型永遠看不見、載不到。

SDK 對此選項的歷史註解說明預設 false 的原因：防**伺服器**行程誤掃「自己機器」的家目錄（Freebuff Cloud 事故：runner 內嵌 web server 行程、repo 在 Daytona sandbox，開啟 home 掃描讓每次 Cloud turn 把 web server 的 `~/.claude/skills` 喂給模型）。**AnyBuff host 是使用者自己的機器／自己的沙箱，完全符合 SDK 文件自己寫的 opt-in 條件**（"Set it when this process belongs to the user whose skills these are"）——這是預設開啟的正當依據（§3 D2）。

### 1.3 Android 的全域目錄問題

Android 引擎跑在 proot 沙箱（`ProotRunner.kt`）：`HOME=/root`、`ANYBUFF_HOST_HOME=/root`、cwd 在 `/workspace/...`。因此：

- Android 的「家目錄 skill 位置」= guest `/root/.agents/skills/`，實體在 `<filesDir>/engine/rootfs/root/.agents/skills/`（rootfs 在 `SandboxPaths.kt`）——**app 私有**，檔案管理員不可達，**沙箱外沒有任何 harness 或 app 可達**（共用前提不成立，見 D6）。
- 現有掛載 `-b filesDir/workspaces/skills:/skills`（ProotRunner:222）是**空接線**：無任何 loader 掃它。
- **v1.1 裁定**：**不掛載公開資料夾、不依賴 AFA**——Android 的安裝一律走 Skills 頁 channels 寫入，使用者全程在 App 內操作。`ProotRunner`、`NativeBridge`、`file_paths.xml` **本計畫零改動**（舊 `/skills` bind 維持現狀，不在本計畫範圍）。

### 1.4 可複用的既有機制（全部已踩通）

| 機制 | 位置 | 本計畫用途 |
|---|---|---|
| Channel 註冊表（41 條） | `channels/channels.ts` + `dispatcher.ts`；Electron 端 `host-bridge.ts` **泛型循環註冊**（M-A4），Android 端 `server/ws-server.ts` 派發同一 dispatcher | 新增 skill 管理 channels，**雙端自動取得，desktop main 不用動** |
| HostEnv shell 接縫 | `host-core/src/env.ts` `installHostEnv`（Desktop：`desktop/src/main/host-bridge.ts:63`；Android：`host-core/src/server/anybuff-host.ts:136` 各自注入） | **D6 的 scope 分流單一來源** |
| Settings 讀寫（field-wise merge） | `settings/settings.ts` + `handlers-app.ts saveSettings`（逐欄位 merge，非整包覆蓋） | 新增 `globalSkillsEnabled` 欄位（鏡像 `webSearchProvider` 先例） |
| 檔案挑選 | Desktop：`AnyBuff.selectFiles()`（Electron 對話框）；Android：NativeBridge `pickFiles`（SAF `OpenMultipleDocuments` → `copyToUpload` → 回 **guest 路徑 `/upload/…`**） | 「從檔案匯入」——**兩端回傳的路徑 host 行程都讀得到**（desktop 絕對路徑 / Android 已綁進沙箱），單一 channel 通吃 |
| Desktop 開啟檔案位置 | `AnyBuff:openPathExternal`（shell-only，`desktop/src/main/index.ts:306`） | 全域 skill「在檔案總管中顯示」（僅 Desktop） |
| 原子寫入 | `host-core/src/files/atomic-write.ts`（ADR-13） | skill 檔安裝與編輯 |
| 驗證原語 | `common/src/constants/skills.ts`（`isValidSkillName` regex `^[a-z0-9]+(-[a-z0-9]+)*$`、`SKILL_FILE_NAME='SKILL.md'`、description ≤1024）、`common/src/types/skill.ts`（`SkillFrontmatterSchema`）、`common/src/util/parse-skill.ts`（`parseSkillFileContent`，不拖 tree-sitter） | `installSkill` 驗證鏈 |

---

## 2. 目標與非目標

### 2.1 目標

1. Settings 新增 **Skills 分頁**（位置：**Web Search 之後**），UI 文案全英文。
2. 分頁內含：
   - **Global skills 開關**（原 `includeHomeSkills` 重新命名，**預設開啟**）＋英文說明文字；
   - **已安裝全域 skills 列表**——**Desktop 唯讀**（共用目錄，見 D6）；**Android 可編輯／刪除**（app 私有目錄，管理權回給 App，並補上移除管道）；
   - **手動新增 skill**（表單 → 產生 `SKILL.md`，雙端）；
   - **從檔案匯入**（挑選 md 檔 → 安裝進全域目錄，雙端）；
   - **從 GitHub 下載**（owner/repo → 掃描 repo 內的 skill 資料夾 → 選擇安裝，**整目錄下載、含 reference 附檔**，雙端）。
3. 接通 run 的 `includeHomeSkills`：開關開啟時，**模型的 `skill` 工具自動看見全域 skill**（不再只是手動 `/` 可呼叫）。
4. **雙端一致的安裝體驗**：Desktop 落 `%USERPROFILE%\.agents\skills`（檔案總管同時可見可手動放）；Android 落沙箱內 app-private 目錄（Skills 頁即為操作介面，**無 AFA 依賴、無額外掛載**）。

### 2.2 非目標

- **Desktop 不提供全域 skill 的編輯與刪除**——`%USERPROFILE%\.agents\skills` 與其他 harness（Claude Code、`npx skills add` 生態等）共用，App 內改刪會影響其他 harness 的行為；Desktop 想修改／移除請用檔案總管或其他 harness 的介面。**Android 則提供編輯／刪除**（目錄 app 私有、無共用前提，見 D6）。分流由 host 端強制，非僅 UI 隱藏。
- **不掛載 Android 公開資料夾**（v1.1 裁定）：無 AFA 依賴、無 `ProotRunner` 改動，Skills 頁即足。
- 不做 skill 市集／registry 搜尋（上游 `npx skills find` 之類，ADR-2 CLI 不移植）；
- 不做 agent 自動安裝 skill 的工具面（模型只能**讀取**全域 skill，安裝是使用者在 Settings 的動作）；
- 不動 SDK 與 agent-runtime（`includeHomeSkills` 通道已存在；零上游 merge 風險）；
- 不做 skill 版本管理／更新檢查；
- 不移除路徑①（`/skill:name` 手動注入）——開關只管路徑②。

---

## 3. 架構設計與決策

### D1：全域 skills 目錄位置（雙端單一事實來源）

| 端 | 全域目錄 | scope（D6） |
|---|---|---|
| **Desktop** | `%USERPROFILE%\.agents\skills\`（host-core `HostPaths.homeDir` = `homedir()`，`desktop/src/main/host-bridge.ts:67`） | `'shared'`——與上游 CLI、Claude Code 等共用；使用者可直接用檔案總管放置／修改／移除 |
| **Android** | 沙箱內 `/root/.agents/skills/`（`HOME=/root`），實體 `<filesDir>/engine/rootfs/root/.agents/skills/`，**app 私有** | `'managed'`——安裝／編輯／刪除一律經 Skills 頁 channels；**不掛載公開資料夾、不動 ProotRunner**（v1.1） |

- **維持 includeHomeSkills 原生掃描路徑，絕不傳 `skillsDir`**——`resolveSkillsDirs` 的 `skillsPath` 會**取代**專案目錄（`load-skills.ts:119`），用了專案 skill 會靜默失效（風險 R2）。
- `.claude/skills` 全域根照 `includeHomeSkills` 語意一併掃描（Android 不掛載、恆空；Desktop 正常掃）。
- 首次安裝時 `mkdirs` 建立全域根（Desktop 落在使用者家目錄，Android 落在 rootfs 內）。

### D2：開關重新命名＋預設開啟（登記的刻意偏離）

- **UI 標籤**：「**Global skills**」。
- **設定欄位名**：`globalSkillsEnabled: boolean`（`PersistedSettings.globalSkillsEnabled?` → `AppSettings.globalSkillsEnabled`，預設 `true`；沿用 `webSearchProvider` 的 default+merge 先例）。
- **說明文字（英文，顯示在開關下方）**：
  > Also scan your home directory's global skills folder (`~/.agents/skills`, plus the Claude Code compatible `~/.claude/skills`), shared across all projects. When off, only the current project's skills are loaded. Applies from your next message; typing `/skill:name` always works.
- **預設 ON 的依據**：AnyBuff host 行程屬於使用者本人（Desktop＝使用者機器；Android＝使用者自己的沙箱），正是 SDK 文件指定的 opt-in 適用情境；上游預設 false 是**伺服器**行程的安全設計，不適用於本專案。此為**登記的刻意偏離**，建議升格 ADR-29（§8）。
- **一個開關管兩處**：`client.run({ includeHomeSkills })` 進 SDK 後同時管 loader 與 `fileContext`（run-state 內建），**skill 工具的 disk lookup 與啟動清單永遠一致**。

### D3：新 channels（host-core，雙端自動取得）

`channels.ts` 在「Custom agents & skills」區塊後新增（順序與 dispatcher/preload/host-ws 對齊）：

| Channel | 參數 → 回傳 | 職責 |
|---|---|---|
| `listGlobalSkills` | `()` → `GlobalSkillInfo[]`（`{name, description, path, root: '.agents'\|'.claude'}`） | 只掃全域兩根（`homedir()/.agents/skills`、`homedir()/.claude/skills`），不依賴 cwd（Skills 頁在未開專案時也要能用） |
| `createSkill` | `{name, description, body}` → 安裝結果 | 表單新增：組 `SKILL.md`（frontmatter + body）→ `installSkill`。**雙端可用**（安裝是本計畫目的） |
| `importSkillFile` | `{sourcePath}` → 安裝結果 | 讀 picked 檔（desktop 絕對路徑／Android `/upload/…` guest 路徑，host 行程皆可讀）→ `parseSkillFileContent` → `installSkill`。**雙端可用** |
| `saveSkillFile` | `{path, content}` → 寫入結果 | **編輯既有 skill（僅 `managed` scope，D6 gate）**：path 限全域根內、`SkillFrontfrontmatterSchema.safeParse` 先驗後寫（**失敗拒絕、保留舊檔**）、ADR-13 原子寫入 |
| `deleteSkill` | `{path}` → 刪除結果 | **刪除 skill 資料夾（僅 `managed` scope，D6 gate）**：限全域根的**直接子資料夾**且含 `SKILL.md`（防 `..`、防刪全域根本身）→ `fs.rm(dir, {recursive})` |
| `listGithubSkills` | `{repo}` → `{skills: [{name, path, fileCount}], warning?}` | GitHub API `git/trees/HEAD?recursive=1`，收集**含 `SKILL.md` 的資料夾**（＝一個 skill 單位；僅 `api.github.com`／`raw.githubusercontent.com` 兩個固定 host，不接受任意 URL）。**雙端可用** |
| `downloadGithubSkill` | `{repo, path}` → 安裝結果 | **整個 skill 子目錄下載**（見下）→ `installSkill`。**雙端可用** |

**共用安裝 helper `installSkill`**（`host-core/src/skills/install-skill.ts`，單一實作，供 create/import/github 三路複用）：

1. **名稱驗證**：`isValidSkillName`（`^[a-z0-9]+(-[a-z0-9]+)*$`、≤64）；
2. **frontmatter 驗證**：`SkillFrontmatterSchema`（description >1024 自動截斷、metadata 開放 record）；
3. **資料夾名一律取 frontmatter `name`**（防 dir/name 不一致；`loadSkills` 以資料夾名做 key）；
4. **同名已存在** → 回 `{exists: true}`，UI 確認後帶 `confirm: true` 重呼——安裝（覆寫）是明確的使用者動作，等同「在檔案總管覆貼」，與「提供編輯介面」不同（2.2 非目標不擋此路）；
5. **ADR-13 原子寫入**（`writeFileAtomic`：同目錄唯一 temp + fsync + rename，永不預刪）；
6. **路徑 traversal 拒絕**：resolved path 必須落在全域根內——**channel 安全線，不得放寬**；
7. **多檔安裝原子性**：先在全域根下寫入唯一 temp 資料夾，全部檔案成功後 rename 成正式資料夾（整包成功或整包不落地，不產生半套 skill）。

**GitHub 下載＝整個 skill 子目錄（v1.1 修訂）**：

- `listGithubSkills` 回傳的候選是**資料夾**（不是單一檔案），`fileCount` 顯示在 UI；
- `downloadGithubSkill` 依 trees API 取該資料夾前綴下**所有檔案**（`SKILL.md` ＋ `references/`、`assets/`、`scripts/` 等同目錄附檔）逐一 raw 下載後**整包原子安裝**；
- **上限**：≤30 檔／單檔 ≤200KB（對齊 `readSkillFile` 上限）／總量 ≤2MB（依 trees 的 size 欄在下載前過濾，超限檔案跳過並在結果回報 `warning`）；
- **已知限制**：`SKILL.md` 內相對連結指向 skill 資料夾**之外**（`../../shared/…`）的檔案不涵蓋——跨目錄 reference 不在任何 skill 安裝慣例內，文件註明即可。

### D4：run wiring（一行）

`packages/host-core/src/run/start-run.ts` 的 `client.run({...})` 加：

```ts
// 開關接通：SDK 內部同一 flag 管 loader 與 fileContext（run-state 741）
includeHomeSkills: currentSettings.globalSkillsEnabled,
```

配套（`settings/settings.ts`）：`PersistedSettings.globalSkillsEnabled?`、`AppSettings.globalSkillsEnabled`、`getAppSettings()` 映射（`?? true` 預設 ON）、setter `setGlobalSkillsEnabled(enabled)`（load → 改 → save，鏡像 `setWebSearchProvider`）、`handlers-app.ts` 的 `SaveSettingsPayload` 加欄位 + `saveSettings()` merge 一行。

### D5：UI（SettingsModal `'skills'` tab）

檔案：`desktop/src/renderer/src/components/SettingsModal.tsx`（同一份 renderer，Desktop 與 Android WebView 共用；**所有 UI 文案英文**）。

1. `SettingsTab` union（line 38）加 `'skills'`；
2. `NAV_ITEMS`（line 1607）在 `'search'`（Web Search）與 `'mcp'` 之間插入 `{ id: 'skills', label: 'Skills', icon: <...> }`；
3. tab title switch 加 `{activeTab === 'skills' && 'Skills'}`；tab 內容 switch 加對應區塊；
4. **頁面結構（由上而下）**：
   - **Global skills 開關**（§3 D2 英文標籤＋說明）→ 變更即存（`saveSettings` payload **必須帶 `globalSkillsEnabled`**——R3 的 MC-0 教訓：缺欄位＝每次 Settings 存檔被抹除）；
   - **Installed global skills 列表**（`listGlobalSkills()`）：name、description、root badge（`.agents`/`.claude`）、path。**每列動作依 `settings.globalSkillsEditable`（D6 派生欄位）分流**：
     - Desktop（`false`）：「Show in file explorer」（`openPathExternal`），**無 Edit／Delete**；
     - Android（`true`）：**Edit**（modal：name 欄**唯讀**＝資料夾名、description＋body 可編輯，儲存走 `saveSkillFile`；frontmatter 壞值被擋時顯示錯誤並保留舊檔）＋ **Delete**（confirm 對話框 → `deleteSkill`）；
     - 空狀態英文文案（Desktop 提示可把 `<name>/SKILL.md` 直接放進顯示的路徑；Android 提示用下方按鈕安裝）；
   - **New skill** 按鈕（雙端）→ 表單（name 即時 regex 驗證＋路徑預覽、description、body 範本預填 frontmatter 骨架）→ `createSkill`；
   - **Import from file** 按鈕（雙端）→ `window.AnyBuff.selectFiles()`（Desktop 對話框／Android SAF picker——Android 已由 NativeBridge `copyToUpload` 把檔案帶進沙箱）→ 逐檔 `importSkillFile`（**壞檔不擋好檔**，逐檔回報結果，鏡像 `importModelCapabilities` 模式）；
   - **From GitHub**（雙端）：輸入 `owner/repo`（或 `github.com/owner/repo` URL）→ `listGithubSkills` → 候選列表（name ＋ fileCount）勾選 → `downloadGithubSkill` → 完成後列表刷新；有 `warning`（超限跳檔）時明確顯示。
5. **skill 檔案寫入一律走獨立 channels，絕不經 `saveSettings`**（skill 內容是任意文字，混進 settings JSON 會破壞單一檔案解析——ADR-27 #1「解析失敗致命」同形考量）；
6. **host-ws shim**（`desktop/src/renderer/src/host/host-ws.ts`）與 **preload 型別**加新方法（Android 走 WS、Desktop 走 IPC，兩者介面需對齊）。

### D6：管理範圍分流（Desktop 唯讀 / Android 可編輯刪除）——host 端強制

**理由鏈**：「列表唯讀」的唯一理由是「目錄與其他 harness 共用」。該前提**僅 Desktop 成立**（`%USERPROFILE%\.agents\skills` 是跨工具慣例目錄）；**Android 不成立**——全域目錄在 app 私有的 rootfs（`<filesDir>/engine/rootfs/root/`），沙箱外沒有任何 harness 或 app 可達，App 內改刪不可能影響別人。故：**Android 提供 Edit/Delete**（管理權回給 App，並一併補上原 §10 待決的「移除管道」缺口）；**Desktop 維持唯讀**。

**單一事實來源＝HostEnv**（`host-core/src/env.ts`，shell 接縫）：

```ts
export interface HostEnv {
  paths: HostPaths
  secrets: SecretStore
  /**
   * Who may mutate the global skills dir (~/.agents/skills).
   * 'shared'  — shared with other harnesses on the same machine (Desktop):
   *             the Skills page list is read-only.
   * 'managed' — app-private (Android rootfs; no other harness can reach it):
   *             full edit/delete in the Skills page.
   * Absent = 'shared' (fail-safe: an unregistered shell gets read-only).
   */
  globalSkillsScope?: 'shared' | 'managed'
}
```

- **注入點**：
  - Desktop `desktop/src/main/host-bridge.ts` `installHostEnv`：`'shared'`（或省略——缺省即 shared，但建議顯式宣告＋註解）；
  - Android `host-core/src/server/anybuff-host.ts:136` `installHostEnv`：`'managed'`（註解 rootfs 私有理由）；
  - **fail-safe**：未宣告的 shell（測試 host、smoke 腳本）一律 `'shared'` → 只讀，誤配的方向永遠是「少給權限」。
- **兩層落實（同一來源）**：
  1. **Host 端強制（安全線）**：`saveSkillFile`／`deleteSkill` handler 開頭 `requireManagedScope()`——`'shared'` 直接拒絕，回英文錯誤訊息（指引改用檔案總管）。**Channel 是邊界，不能只靠 UI 隱藏**（渲染層誤接按鈕、未來新增呼叫端都不該破線）；
  2. **UI 鏡像**：`AppSettings` 加**派生欄位** `globalSkillsEditable: scope === 'managed'`（**不持久化、絕不進 save payload**——它是 env 派生值），`getState`／`saveSettings` 回傳的 `settings` 自動帶出，SettingsModal 據此顯示／隱藏 Edit/Delete。
- **Edit 的語意限制**：name 欄唯讀（＝資料夾名；改名＝刪除後重建，避免 frontmatter name ≠ 資料夾名造成 `loadSkillFromDisk` 查找失敗）；儲存前 `SkillFrontmatterSchema.safeParse` 驗證，**失敗拒絕並保留舊檔**；僅 description/body 可編輯。
- **Delete 語意**：僅允許全域根的**直接子資料夾**（正規化後必須 `<root>/<valid-name>` 且含 `SKILL.md`）——防 `..`、防刪掉全域根本身；UI confirm 後呼叫。
- **安裝不受分流限制**：`createSkill`／`importSkillFile`／`downloadGithubSkill` 雙端皆允許（安裝是本計畫的目的；共用性質下的安裝是使用者明確意圖，與「改刪既有內容」不同）。

---

## 4. 資料流

```
SettingsModal 'skills' tab
  ├─ 開關 → AnyBuff:saveSettings {globalSkillsEnabled}
  │        → settings.ts setGlobalSkillsEnabled（merge，非整包覆蓋）
  │        → 下一 run：start-run client.run({includeHomeSkills})
  │           → SDK loadSkills（工具 description 掃全域）＋ fileContext（skill 工具 disk lookup）
  │
  ├─ 列表 → AnyBuff:listGlobalSkills → homedir()/.agents/skills + homedir()/.claude/skills 掃描
  │        動作分流（settings.globalSkillsEditable ← HostEnv.globalSkillsScope）：
  │        Desktop shared → Show in file explorer（openPathExternal）
  │        Android managed → Edit（saveSkillFile）／Delete（deleteSkill）
  │           ※ 兩個 channel 的 handler 一律 requireManagedScope()——host 端強制
  │
  ├─ 新增/匯入/GitHub（雙端）→ createSkill | importSkillFile | downloadGithubSkill
  │        → installSkill（name regex + frontmatter 驗證 + exists-confirm + ADR-13 原子寫入
  │           + traversal 拒絕 + 多檔整包原子安裝）
  │        → Desktop：落 %USERPROFILE%\.agents\skills\<name>\（檔案總管即時可見，與其他 harness 共用）
  │        → Android：落沙箱 /root/.agents/skills/<name>/（app 私有，Skills 頁即唯一介面）
  │
  └─ Edit/Delete（僅 Android managed；host 端 gate 雙層把關）
           → saveSkillFile / deleteSkill → 全域根內驗證 → 原子寫入 / 遞迴刪除
```

匯入來源路徑相容性：Desktop `selectFiles()` 回絕對路徑（host 直接可讀）；Android `pickFiles` 已由 `copyToUpload` 複製到 `/upload`（guest 路徑，host 綁定可讀）——**同一個 `importSkillFile` channel 雙端通吃，無分支**。

---

## 5. 分階段實作

### P0 — 核心（開關接通＋Skills 頁＋手動新增＋檔案匯入＋平台分流）

> 做完即得到：雙端「Global skills」開關與列表、手動新增、檔案匯入、模型自動載入全域 skill；Desktop 唯讀（Show in file explorer）、Android 可編輯刪除。

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `packages/host-core/src/env.ts` | `HostEnv.globalSkillsScope?`（缺省 `'shared'`，含文件註解）＋ accessor `globalSkillsScope()` |
| 2 | `packages/host-core/src/server/anybuff-host.ts` | Android shell `installHostEnv` 加 `globalSkillsScope: 'managed'`（附 rootfs 私有理由註解） |
| 3 | `desktop/src/main/host-bridge.ts` | `installHostEnv` 显式 `globalSkillsScope: 'shared'`＋註解（跨 harness 共用） |
| 4 | `packages/host-core/src/settings/settings.ts` | `PersistedSettings.globalSkillsEnabled?` ＋ `AppSettings.globalSkillsEnabled`（`?? true`）＋ **派生** `AppSettings.globalSkillsEditable`（不進 save payload）＋ `setGlobalSkillsEnabled()` |
| 5 | `packages/host-core/src/channels/channels.ts` | 註冊 `listGlobalSkills` / `createSkill` / `importSkillFile` / `saveSkillFile` / `deleteSkill` |
| 6 | `packages/host-core/src/skills/install-skill.ts`（新） | `installSkill` 驗證鏈＋原子寫入＋traversal 防護＋exists-confirm；`requireManagedScope()` gate；`saveSkillFile`／`deleteSkill` 的驗證與路徑約束 |
| 7 | `packages/host-core/src/channels/handlers-agents.ts` | 五個 handler（list 掃全域兩根；create/import 走 `installSkill`；save/delete 先過 scope gate） |
| 8 | `packages/host-core/src/channels/dispatcher.ts` | 對應綁定 |
| 9 | `packages/host-core/src/channels/handlers-app.ts` | `SaveSettingsPayload.globalSkillsEnabled?` ＋ merge 一行 |
| 10 | `packages/host-core/src/run/start-run.ts` | `client.run` 加 `includeHomeSkills: currentSettings.globalSkillsEnabled` |
| 11 | `desktop/src/preload/*`（型別＋轉發） | 新 channels 的 IPC 型別 |
| 12 | `desktop/src/renderer/src/host/host-ws.ts` | shim 加新方法（Android 用） |
| 13 | `desktop/src/renderer/src/components/SettingsModal.tsx` | `'skills'` tab：NAV_ITEMS（Web Search 後）、開關＋英文說明、列表（動作依 `settings.globalSkillsEditable` 分流）、New skill 表單、Import 按鈕、Edit modal＋Delete confirm（Android 顯隱） |
| 14 | host-core 測試 | §9 清單 |

### P1 — 從 GitHub 下載（整子目錄）

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `channels.ts` + `dispatcher.ts` + `handlers-agents.ts` | `listGithubSkills`（資料夾級候選）／`downloadGithubSkill`（整子目錄＋上限＋整包原子安裝；固定 host 白名單） |
| 2 | `packages/host-core/src/skills/install-skill.ts` | 多檔安裝（temp 資料夾 → rename） |
| 3 | SettingsModal | GitHub 輸入＋候選列表（name＋fileCount）＋下載＋warning 顯示 |
| 4 | preload ＋ host-ws | 對應方法 |
| 5 | 測試 | §9 清單 |

### P2 — 可選強化（不阻擋交付）

- **Provenance 欄位**：`installSkill` 寫入時在 frontmatter `metadata` 記 `source: manual|file|github`＋`installedAt`，列表顯示徽章（緩解 R1 種植 skill 的可見性）；
- **GitHub token**：DPAPI vault id `github-token`（ADR-11 通道，鏡像 `searchApiKey`）——解 60/hr rate limit。
  **〔2026-10-03 決定：整段移除**——token UI、vault 讀寫（`saveGithubToken`/`getGithubToken`）、`githubTokenSet`、saveSettings payload 欄位、`ghFetch` Authorization header 全數刪除；請求維持 unauthenticated，rate-limit 錯誤訊息保留 60/hr 說明。裁定理由：60/hr 對人工安裝情境綽綽有餘，token 是多餘的設計與安全面。詳 ADR-29〕

---

## 6. 驗收標準

### P0

- [ ] Settings 左欄在 **Web Search 後**出現 Skills 分頁，Desktop 與 Android WebView 皆可見、可操作；**文案全英文**。
- [ ] Global skills 開關預設為**開**；關閉 → 新對話的 `skill` 工具清單不含全域 skill、模型以名字呼叫回 `not found`；開啟 → 模型自動看見並可載入（`/skill:name` 手動路徑兩態皆可用）。
- [ ] Desktop 放 `%USERPROFILE%\.agents\skills\demo-skill\SKILL.md` → 列表、`/` 選單、模型 `skill` 工具三處皆可見（開關開時）。
- [ ] **平台分流（D6）**：
  - Desktop：列表**無 Edit／Delete 控制項**、有「Show in file explorer」；**直接呼叫 `saveSkillFile`／`deleteSkill` channel 回英文拒絕訊息**（host 端 gate，非僅 UI 隱藏）；
  - Android：Edit（name 欄唯讀、僅 description/body 可改、壞 frontmatter 被擋且**舊檔保留**）與 Delete（confirm → 資料夾移除、列表刷新、下輪 run 的 `skill` 工具與 `/` 選單皆不再見）皆可用；
  - **fail-safe**：未宣告 scope 的測試 host（缺省 `shared`）呼叫 save/delete → 拒絕。
- [ ] 手動新增（雙端）→ 檔案落在全域根 `\<name>\SKILL.md`（Desktop 檔案總管驗證；Android 由列表與 run 行為驗證）→ 下一則訊息模型可見；非法名稱（大寫／底線）被即時擋下。
- [ ] 檔案匯入（雙端）：合法 md 裝成 skill；**壞檔（無 frontmatter／名稱非法）回明確錯誤且不影響同批其他檔**；同名已存在走 confirm 流程。
- [ ] **R3 驗收線**：`globalSkillsEnabled: false` 設定後，隨便在任一 Settings 分頁存一次檔，回讀仍為 `false`（不被 save payload 抹除）；`globalSkillsEditable` 不出現在存檔內容（派生值不持久化）。
- [ ] 安裝檔一律原子寫入（ADR-13）；路徑 traversal 測試全數拒絕（含 delete 的「全域根本身」「`..` 子路徑」個案）。
- [ ] **Android**：Skill 頁安裝後，列表、`/` 選單、模型 `skill` 工具三處可見（**無需重啟引擎**——不涉及掛載）；全程無 AFA 依賴。

### P1

- [ ] `owner/repo`（或完整 URL）→ 列出 repo 內含 `SKILL.md` 的資料夾（含 fileCount）→ 勾選下載 → **SKILL.md 與同目錄 references/assets 附檔一併安裝**（多檔整包原子落地）→ 列表出現。
- [ ] 超限（>30 檔／>200KB 單檔／>2MB 總量）：跳過超限檔並回 `warning`，UI 明確顯示；安裝結果仍可用。
- [ ] rate limit（403/429）回明確訊息（含 60/hr unauthenticated 說明）；traversal 路徑、非 `SKILL.md` 資料夾、白名單外 host 一律拒絕。
- [ ] 同名已存在走 confirm 流程（覆寫＝整包原子替換）。

---

## 7. 風險登記

| # | 風險 | 處置 |
|---|---|---|
| **R1** | **全域 skill 自動載入 = prompt-injection 持久化面**：任何能寫入全域資料夾的行程都能在未來所有 run 種 skill，且模型自動載入 | **接受並登錄**——與上游 `npx skills add` 同風險面（上游既有）。**移除管道雙端俱備**（v1.2：Desktop＝檔案總管／其他 harness；Android＝App 內 Delete）；P2 provenance 徽章讓壞 skill 可辨識 |
| **R2** | `skillsPath` 與 `includeHomeSkills` 互斥：`resolveSkillsDirs` 的 `skillsPath` 會**取代**專案目錄 | 本計畫**只用 `includeHomeSkills`，絕不傳 `skillsDir`** |
| **R3** | **save-payload race**（ADR-27 MC-0 教訓）：新欄位缺任一處（renderer payload 或 handler merge）→ 每次 Settings 存檔被抹除 | 兩處同時落地；P0 驗收線必測「false 存檔後回讀仍 false」＋「`globalSkillsEditable` 不持久化」 |
| **R4** | GitHub unauthenticated rate limit 60/hr；惡意 repo 的巨大／超限 tree | 錯誤訊息說明；上限＋跳檔＋warning（D3）；~~P2 token（DPAPI vault）~~——token 已於 2026-10-03 決定移除（多餘設計，詳 P2 註記與 ADR-29），60/hr 全額開放 |
| **R5** | 跨目錄 reference（`SKILL.md` 內 `../../` 相對連結）不在子目錄下載涵蓋內 | 已知限制，文件註明（D3）；skill 慣例是自包含目錄 |
| **R6** | **scope gate 誤配**：Android 漏設 `'managed'` → Edit/Delete 消失（fail-safe 方向、無資料風險）；**Desktop 誤設 `'managed'` → 共用目錄暴露編輯面** | 兩 shell 的 `installHostEnv` 帶**顯式**欄位＋註解；handler gate 測試（shared 拒絕／managed 允許／缺省拒絕）鎖定；UI 只是鏡像、host gate 才是安全線 |
| **R7** | Agent 理論上可經檔案工具寫 `/root/.agents/skills`（沙箱內可寫）種 skill | AnyBuff 未給 agent 任何 home-skill 寫入通道或提示（agent prompt 一律指向**專案** `.agents/skills/`）；P2 provenance 可觀察；接受 |
| **R8** | 上游 merge | 改動全在 AnyBuff 自有層（host-core env/settings/channels/start-run、desktop renderer/shell）——上游無對應檔案；**SDK／agent-runtime／Android Kotlin 零改動** |

---

## 8. 維護注意

1. **`globalSkillsEnabled` 預設 ON 是登記的刻意偏離**：上游 SDK 預設 `false` 是伺服器行程安全設計；有人以「上游預設 false」之名改回 false，全域 skill 會**靜默退回半失效形態**（只剩 `/` 手動可用、模型看不見）——建議升格 **ADR-29** 連同本計畫一起入冊。
2. **平台分流是刻意設計**（v1.2）：唯讀的理由＝「目錄與其他 harness 共用」，Desktop 成立、Android（app 私有 rootfs）不成立。**單一事實來源是 `HostEnv.globalSkillsScope`**——改動分流必須改 shell 注入值，**不得只改 UI 顯隱**（host 端 `requireManagedScope()` 是安全線）；日後有人「順手讓 Desktop 也能刪」必須先回答共用性問題並走 ADR。
3. **`installSkill` 的路徑 traversal 防護是安全線**，與 `fileFilter`（`isSensitiveFile`）同級；不得放寬。`deleteSkill` 額外約束「僅直接子資料夾＋含 SKILL.md」（防刪全域根）。
4. **skill 檔案內容絕不經 `saveSettings`**——settings JSON 是單一解析點（ADR-27 #1 同形教訓）；寫入一律走獨立 channel ＋ ADR-13 原子寫入；`globalSkillsEditable` 是 env 派生值，**絕不進 PersistedSettings／save payload**。
5. **上游 merge 觸及** `sdk/src/skills/load-skills.ts`／`run-state.ts` 時：本計畫零改動 SDK，但需複查 run-state「一個 flag 管 loader 與 fileContext」的通道是否仍成立（`run-state.ts:741`）。
6. `listSkills`（Composer `/` 選單）行為**不變**（專案＋home 兩層）；Skills 頁用獨立的 `listGlobalSkills`（不依賴 cwd，未開專案也能用）。
7. **本計畫不動 Android 殼層的 proot/掛載面**（`ProotRunner`／`NativeBridge`／`file_paths.xml` 零改動）；`anybuff-host.ts` 僅加一行 scope 注⼊。舊 `/skills` bind 維持現狀（空接線，無害）。日後若真要掛公開資料夾，另立計畫。

---

## 9. 建置與驗證

```powershell
bun install                 # 若 workspace/package.json 無變更可跳過
bun run build:host-core     # 必跑：host-core 編輯後 desktop 消費 dist/（ADR-21）
bun run typecheck:host-core
bun --cwd desktop run typecheck
bun run test:host-core      # channel contract tests ＋ 下列新增測試
# SDK／agent-runtime／Android Kotlin 零改動 → build:sdk、gradle 不需要
```

**新增測試（host-core）**：

- `settings`：`globalSkillsEnabled` 預設 `true`、legacy settings（無此欄位）升級為 `true`、merge 不抹除；`globalSkillsEditable` 隨 scope 派生且**不進 persist 檔**；
- **scope gate**：`shared` 呼叫 `saveSkillFile`/`deleteSkill` → 拒絕（英文訊息）；`managed` → 允許；**缺省（未宣告）→ 拒絕**（fail-safe）；
- `install-skill`：name regex 拒絕（大寫／底線／traversal）、frontmatter 驗證（缺 name、description 截斷 1024）、資料夾名取 frontmatter name、同名 exists-confirm、原子寫入（ADR-13）、路徑必落全域根內；
- `saveSkillFile`：frontmatter 壞值 → 拒絕且**舊檔保留**；name 變更 → 拒絕（name 鎖定）；
- `deleteSkill`：僅直接子資料夾；全域根本身／`..` 路徑／無 SKILL.md → 拒絕；
- `listGlobalSkills`：雙根掃描（`.agents` 勝 `.claude` 同名）、無目錄回空陣列；
- `start-run` wiring：run options 收到 `includeHomeSkills === settings.globalSkillsEnabled`；
- `importSkillFile`：壞檔不擋好檔（逐檔回報）；
- P1：`listGithubSkills` 資料夾級收集、`downloadGithubSkill` 子目錄下載上限／跳檔 warning／多檔整包原子、host 白名單與 traversal 拒絕。

**手動驗收**：§6 P0（雙端，含平台分流個案）→ P1。
