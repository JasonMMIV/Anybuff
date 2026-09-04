# AnyBuff Android 版實作計畫

> **版本**:v1.1(2026-09-04 更新)
> **狀態**:已核准。**Phase A 已於 2026-09-03 完成**(host-core 抽取 / WS 契約 / renderer shim / desktop 薄殼化全數落地並通過兩輪 code-review,詳見 §3.0 執行紀錄);ADR-21 已併入指南 §4、§1/ADR-2/§3/§6 同步修訂。**Phase B 引擎鏈路與第六/七輪行動端 UI 重構已於 2026-09-04 實裝**——實機鏈路(rootfs → Node → proot → host → WS → WebView renderer)全通;直立手機小螢幕 UI 全面重構完成(雙抽屜側欄+遮罩點擊關閉、單行精簡工具列、Settings 分類按鈕原地展開下拉選單、全介面 English、自訂 Agent 依附專案檢查與即時提示、ws-server 關閉卡住修復,詳見 §4.0 第六/七輪紀錄)。剩餘:M-C2 出包管線、code-review 暫緩事項(secrets 走 channel / key 同步 / SAF replyProxy)。
> **依據**:2026-09 三輪查證——(1) RikkaHub 原始碼級調研(workspace 模組、proot 打包、rootfs 安裝、授權結構);(2) Android 官方文件 2025-2026 現況(WebView 橋接、Keystore、FGS、Network Security Config、W^X);(3) 四方案比對(Flutter / React Native / Tauri 2 / Capacitor)。關鍵結論已內嵌各節,本計畫只記結論與工作項,不重複論證。
> **授權紀律**:RikkaHub 為 **AGPL-3.0——僅採用其已公開驗證的架構模式,嚴禁抄襲任何程式碼**;proot 二進位為 GPL-2.0+,隨包散布義務見 §7 R2。

---

## 0. 一頁摘要

**目標**:在不重寫 React UI、不遷移 Windows GA 版、零修改引擎層的前提下,交付 Android 版 AnyBuff(arm64,首發 GitHub APK 側載)。

**架構一句話**:三層全共享(renderer / host 邏輯 / 引擎)+ 兩個薄殼(Windows Electron 為既有現狀、Android Kotlin 為唯一淨新原生面 ~1–1.5k 行),兩殼經**同一套 `AnyBuff:*` 契約**與**同一個 headless host 套件**對話。

| Phase | 內容 | 估時(兼職) | 出場條件 |
|---|---|---|---|
| **A** | Headless host 套件化 + WebSocket 契約 + renderer shim | 2–4 週 | smoke 於 headless 模式跑通;desktop 回歸全綠 |
| **B** | Android Kotlin 殼(sandbox / Keystore / WebView / FGS) | 3–5 週 | 實機跑通冒煙任務 + UI 完整可操作 |
| **C** | 觸控適配 + APK 出包管線 | 1–2 週 | 可側載 beta |
| **D** | 硬化(裝置矩陣 / 電池 / 穩定性)與 Play 上架評估 | 持續 | — |

**總計約 6–11 週。** 不設獨立「驗證 Phase」——引擎冒煙併入 M-A0(1 天,見 §1.3)。

---

## 1. 範圍與決策記錄

### 1.1 採用方案:雙薄殼 + 三層共享

```
┌── Windows App ─────────────┐   ┌── Android App ─────────────────────────┐
│ Electron(既有,GA,不遷移) │   │ WebView(https://appassets…net)        │
│  React renderer(16,787 行)│   │  React renderer(同一份)              │
│  preload ipcMain ──────────┼──┤  host-ws shim ── ws://127.0.0.1 ──┐    │
│  main = 薄 IPC 層          │   │                                  │    │
└──────────┬────────────────┘   │ Kotlin 殼 ~1–1.5k 行:proot 執行器│    │
           │ in-process          │ rootfs 安裝器、Keystore、FGS、     │    │
           ▼                     │ SAF picker、WebView 整合          │    │
┌── 共享:packages/host-core(@codebuff/host-core)◀── WS 契約 ──────┘    │
│  start-run 編排 / session-store / settings / mcp-settings /            │
│  local-agents / file-filter(自 desktop/src/main 抽出,無 Electron 依賴)│
├── 共享:引擎 sdk + packages/agent-runtime + common(零修改,ADR-1)     │
└── Windows:in-process │ Android:Node 22 arm64 於 proot Ubuntu rootfs 內 │
```

| 層 | 內容 | Windows 宿主 | Android 宿主 |
|---|---|---|---|
| UI | React renderer(16,787 行,零修改) | Electron Chromium | Android WebView |
| Host 業務邏輯 | `packages/host-core`(自 main 抽出,~6.3k 行) | in-process import | Node 於 proot sandbox 內,經 WS |
| 引擎 | sdk / agent-runtime / common | 同一 bundle | 同一 bundle |
| 殼 | 各自薄層 | Electron main(既有) | Kotlin ~1–1.5k 行(淨新) |

### 1.2 已否決替代方案(未來不再評估)

| 方案 | 裁定 | 關鍵理由(一句話) |
|---|---|---|
| Flutter(Dart)重寫 | ❌ 否決 | 框架統一的只有 UI 層——而 UI 層已由 React 統一;W^X 下的 proot+Node、Keystore、FGS 在 Flutter 下仍是每平台 platform-channel 原生碼,量不減反增(還要先重寫 16.8k 行 UI) |
| React Native 重寫 | ❌ 否決 | DOM/CSS renderer 無法移植進 RN(必須 `<View>/<Text>`+StyleSheet+Yoga 全重寫;React Native for Web 是反方向相容層);RNW 支援窗極短(約一版一季) |
| **Tauri 2 遷移** | ❌ **永久否決(2026-09-03 維護者裁定,列入不得回引清單,不再重新評估)** | ① Electron→Tauri 更新搬運無官方路徑(issue #6142 開至今),遷移即放棄 electron-updater 裝機連續性;② Tauri sidecar 在 Android 明文不支援(#9774),proot+Node 佈線照樣自寫;③ Android 頁面 origin `http://tauri.localhost` 非 secure context(wry #1709),WebCrypto/ServiceWorker 不可用;④ 需引入 Rust 成為第三門語言棧 |
| Capacitor | ❌ 否決 | Android 硬底層仍全為自寫 Kotlin plugin(無生態先例);Windows 端對既有 Electron GA 無增益,其社群 Electron 殼已宣告無維護 |

> 「write once」結論(2026-09 查證):**任何跨平台框架都統一不了本專案的真正工程量**(Android 10+ W^X 規則下的 sandbox 執行、Keystore、specialUse FGS)——這層在 Flutter/RN/Tauri/Capacitor 下都是自寫原生碼;而框架能統一的 UI 層,React + WebView 已經統一了。

### 1.3 驗證範圍劃分(2026-09-03 裁定)

**RikkaHub 已量產證明(Google Play 上架、targetSdk 37),不需重複驗證:**

- proot 在 Android app 內運行——二進位以 `lib*.so` 名義進 `jniLibs` + `useLegacyPackaging=true`,抽出至 `nativeLibraryDir`(唯讀可執行)後 exec;
- Ubuntu rootfs 首啟 HTTP 下載 → 解壓 → DNS/hosts/locale 修補 → 持久運行;
- rootfs 內 ELF(bash 等)位於 app filesDir 事實上可執行(量產先例成立);
- 「WebView 宿主 UI + sandbox 工具執行」產品形態可過 Play 審查。

**本計畫仍需實機確認的殘餘項(風險低,併入里程碑,不設獨立驗證階段):**

- **M-A0(1 天)**:Node 22 arm64 於 proot 內執行 AnyBuff 引擎——`bun run build:sdk` 產物在 Node ≥22 上跑通、vendored ripgrep(linux-arm64)可執行、tree-sitter WASM 載入、一輪 base2 真實任務的記憶體足跡。方法:Termux → `proot-distro install ubuntu` → Node 22 → clone 本 repo → 跑 `scripts/smoke-sdk.ts`。RikkaHub 的 sandbox 從未跑過 Node 引擎(其 agent loop 為 Kotlin),故此項不在其證明範圍內,但 sdk 零原生模組(全 WASM/純 JS)且 Node-in-proot 為 Termux 生態熟路,風險低。
- **M-B1**:自建 sandbox 於實機重現同款 exec 行為(先例已證明,確認用;fallback 見 §4 M-B1)。

---

## 2. 目標架構細節

### 2.1 契約:56 個 `AnyBuff:*` channel 的分流

Desktop preload(`desktop/src/preload/index.ts`)暴露 56 個方法。Android 版按去處分四類,**契約(方法名、參數、回傳形狀)完全不變**:

| 去處 | 數量 | 項目 |
|---|---|---|
| **經 WS 由 host-core 服務**(原樣) | ~40 | `runPrompt` `abort` `event` `getState` `getTaskView` `approvalResponse` `respondAskUser` `listProjects` `deleteTask` `renameTask` `searchHistory` `trimTaskLastTurn` `listFiles` `listDir` `pathInfo` `readFile` `listSkills` `readSkillFile` `projectName` `gitBranch` `gitDiff` `gitAccept` `gitRevert` `fetchModels` `saveSettings` `listLocalAgents` `readLocalAgentFile` `saveLocalAgentFile` `createLocalAgent` `deleteLocalAgent` `listMcpServers` `saveMcpServer` `deleteMcpServer` `updateMcpServerSettings` `testMcpServer` |
| **Android stub / 移除** | ~10 | `windowMinimize` `windowMaximize` `windowClose` `windowIsMaximized` `windowMaximizeChange` `windowReload` `windowForceReload` `windowToggleFullScreen` `setZoomFactor`(`App.tsx` 呼叫點本有 `IS_PREVIEW` 防護,shim 回 no-op / 預設值即可) |
| **Android 換實作** | ~6 | `getAppVersion` `checkForUpdates` `updateCheck` `updateDownload` `updateEvent` `updateInstall` → v1 為 GitHub Releases 版本比對 + 開啟下載頁(側載階段不安裝內建自更新) |
| **原生 bridge**(`addWebMessageListener`) | 2–3 | `selectFiles` `selectFolder` `getPathForFile` → SAF 選檔,複製進 sandbox bind mount `/upload`,回傳 sandbox 路徑 |

### 2.2 金鑰流(ADR-11 / ADR-12 對應)

```
Android Keystore(AES/GCM/NoPadding 256-bit,KeyGenParameterSpec,TEE/StrongBox 優先)
  → Kotlin 解密(唯一持有明文的原生碼)
  → 一次性 localhost 握手,直接注入 sandbox 內 host-core 記憶體
  → apiKeyOverrides → 引擎
  ✗ 金鑰不經 WebView(暴露面比桌面版更小)
  ✗ 不落 sandbox 磁碟、不進 process.env(ADR-12 原樣成立)
  ✗ sandbox 內 spawn 之子行程由 impl/env-sanitize.ts 照常清洗(引擎內建,免費)
```

- **不得使用 EncryptedSharedPreferences**:`androidx.security:security-crypto` 已於 2025-07 終版(1.1.0)全面棄用,官方指引為直接使用 Android Keystore + `AES/GCM/NoPadding` 256-bit(或 Tink)。
- `SecretStore` 介面於 host-core 定義:Windows 實作 = Electron safeStorage(DPAPI);Android 實作 = 握手填入的記憶體值。密文 + IV 存 DataStore(容器,非加密)。

### 2.3 loopback 安全面(兩顆必釘)

Android 的 `127.0.0.1` 為全裝置共享——其他 App 也能連你的埠。host-core 的 WS server 必須:

1. **驗證 `Origin` header**:僅接受 `https://appassets.androidplatform.net`(桌面 headless 模式則允許 localhost 開發來源);
2. **per-session 隨機 token**:Kotlin 生成,經 `addDocumentStartJavaScript` 注入 WebView 全域常數,handshake 首包出示,host 驗證後才服務後續請求;
3. **僅綁 loopback**、動態埠(127.0.0.1:0);未來「區網 UI」功能需另立 ADR(牽動 Android 16/17 Local Network Permission)。

---

## 3. Phase A:Headless Host 套件化(2–4 週)

**目標**:把 `desktop/src/main` 的業務邏輯抽成無 Electron 依賴的 workspace 套件 `packages/host-core`(npm 名 `@codebuff/host-core`,遵守 ADR-1),提供 WebSocket 契約實作;renderer 以啟動時 shim 無痛切換,**56 個呼叫點零修改**。

### 3.0 執行紀錄(2026-09-03 Phase A 完成)

> 本節為實際落地狀態,取代上方各里程碑的「規劃」文字作為現況基準。**已交付**皆通過 host-core typecheck / 31 項契約測試 / smoke / desktop typecheck + electron-vite build 全量驗證,並經兩輪 code-review 修復。

**已交付:**

- **M-A1 host-core 抽取(完成)**。`packages/host-core/src` 落地:env/events 接縫、contracts、run/、sessions/、settings/、mcp/、agents/(含 bundled-agents)、files/(atomic-write/file-filter/fs-utils)。產物經 `git mv` 搬遷(rename 保留歷史),bundled-agents 為 generator 產物、重跑後零漂移(僅時間戳)。
  - 接縫:`HostPaths`(dataDir/appDataDir/homeDir)、`SecretStore`(DPAPI→Android Keystore 對應)、`EventSink`/`EventBus`(含 `attachEventSink`/`detachEventSink` 多 sink Set、`bridgeEventBus` 把 bus 橋進 run sinks、`listenerCount` 供可用性判定)。
  - host-core build 產 ESM + CJS + **單檔 bundled d.ts**(`dist/`);tsconfig.build 以 paths 鏡像指到 common/agent-runtime/code-map source,使 dts-bundle-generator 沿 source 鏈解析、不檢查 sdk dist d.ts(繞過 `Pick<typeof fs.promises…>` 解析炸點)。
  - 子進程產物無 Electron import;`electron` 字樣僅存於註解。
- **M-A2 WS server 與契約(完成)**。`channels/channels.ts` 為 35 個**業務** channel 的單一事實來源(`CHANNELS` + `WsRequest`/`WsResponse`/`WsEventFrame`);`channels/dispatcher.ts` 提供 transport-agnostic `createHost({eventBus})` → `dispatch(channel,args)`(bare 值包 `{ok:true,result}`,handler 自帶 envelope 原樣過,錯誤回 `{ok:false,error}`,永不 throw);`server/ws-server.ts` 綁 loopback 動態埠 + bearer token + Origin allowlist,廣播訂閱動態化(僅在有 client 時訂閱,令互動 prompt 可用性正確反映連線狀態)。
- **M-A3 renderer shim(部分完成,1 項偏差見下)**。`renderer/src/host/host-ws.ts` = `createWsAnyBuff(url)` 回 `AnyBuffApi` 形狀物件(WS request envelope + event 幀消費;錯誤幀 resolve `{ok:false,error}` 與 IPC 一致;Electron-only 方法安全降級);`renderer/src/main.tsx` 在無 preload 且有 `__ANYBUFF_WS_URL__` 時注入。renderer 既有 56 個呼叫點零修改。
- **M-A4 Desktop 薄殼化(完成,較計畫提前)**。`desktop/src/main/` 僅存 index.ts / updater.ts / env-shim.ts / host-bridge.ts(薄);host-bridge = HostPaths/SecretStore/EventSink 注入 + ipcMain.handle 轉發 host-core dispatcher。`desktop/src/shared/codebase-index.ts` 重建為 host-core re-export 相容層。`git mv` 使 desktop→host-core 搬遷歷史完整。
- **ADR-21 併入指南**(詳見下方補充事項清單)。

**驗證結果:**

1. `bun run build:sdk` ✓;host-core typecheck ✓ + build(ESM/CJS/d.ts)✓;desktop `bun run typecheck`(node+web)✓;desktop electron-vite build ✓。
2. host-core 契約測試 **31 項全過**(dispatcher 20 + ws-server 11:每 channel 註冊、round-trip、WS auth/origin/event broadcast、bridge 回歸),smoke-host-core 全過。
3. 純瀏覽器 + WS host 的完整 smoke 任務(核准橫幅/工具卡/file-changes)尚未執行——需 web build(見下方偏差)與 M-A0 實機環境。
4. desktop 手動回歸未執行(環境限制)。

**偏差與補充事項(2026-09-03):**

- **偏差 1 — M-A3 缺純 web build 設定**:計畫要求 Vite `base:'./'` → `dist-web/`(Android assets 用),目前未建;desktop 僅有 electron-vite renderer build。Phase B M-B0 WebView assets 依賴此項——**列為 Phase B 前置待辦**。
- **偏差 2 — WS 事件幀形狀以實作為準**:計畫 §3 M-A2 原文寫推送 `{channel:'AnyBuff:event', event}`;實作採 `{event:'event', payload}`(WsEventFrame,host-ws client 對應消費)。若日後需要與計畫文件逐字一致再行對齊,契約以 channels.ts 型別為準。
- **補充 3 — dispatch envelope 契約**:renderer 端兩 transport 形狀一致性經 code-review 確認——bare handler 回 `{ok:true,result}`(host-bridge/ws-server 解包成裸值),envelope handler(`{ok,...fields}`,如 runPrompt/deleteTask/getTaskView)兩端皆保留全欄位;錯誤路徑一律 resolve `{ok:false,error}`(WS client 不 reject,與 IPC 一致)。
- **補充 4 — host-core 已 export 面**:`env`/`events`/`contracts`/`run/start-run`/`sessions/session-store`/`settings`/`mcp/mcp-settings`/`agents`/`files`/`channels`/`server/ws-server`,shell 只需 import 單一入口。
- **補充 5 — M-A0 查檢清單文件已備妥**:`docs/android-m0-engine-smoke.md`(local-only,未進 git)——Termux→proot ubuntu→Node 22 arm64 步驟與通過標準已寫成查檢清單;實機執行後請回填結果並更新 §3.0。
- **補充 6 — 第二輪 code-review 保留事項**:`createHost({eventBus})` bridge 為 process-singleton(一次附著、不 detach)——符合 run orchestrator 單例語意,已於 dispatcher.ts 文件註記;錯誤 envelope 的 `taskId` 等附加欄位在兩 transport 一致捨棄,renderer 僅消費 `.error`,無回歸。
- **補充 7 — 本計畫三大 .md(本檔 / 指南 / 缺口表)均 local-only(untracked 或 gitignore),不隨 commit;README.md / README.zh-TW.md / AGENTS.md 為追蹤檔,本次 ADR-21 已同步更新**(generator 產出路徑、host-core 位置、建置迴圈)。
- **補充 8 — 待 Phase B 決策點**:host-core dist 進 APK assets 的展開方式、Node 22 arm64 下 host-core 為 ESM 或 CJS 消費、`SecretStore` Android 實作與握手時機(§2.2 / §4 M-B2)。
- **補充 9 — M-A0 外部證據查證(2026-09-03,web research,來源均經直接核實)**:核心假設「Node ≥22(arm64 Linux ELF)可於 Android proot sandbox 內啟動」**已有第三方量產先例**,足以把 M-A0 從性質上由「可行性證明」降級為「AnyBuff 特定回歸確認」:
  - **OpenClawd-Termux(mithun50/openclawd-termux)**:Flutter 量產 App,在**App 自身 filesDir 的 proot Ubuntu 24.04 rootfs 內跑 Node.js 22 + OpenClaw(npm AI 閘道應用)**——不經 Termux shell、架構與本計畫 M-B1 幾乎相同(proot 二進位取自 Termux APT 源、以 `lib*.so` 進 nativeLibraryDir 取得 exec 權限)。其工程參數(`--sysvipc` 對 Node 功能必要性、`env -i` 環境隔離、bionic-bypass 預載)可直接為 M-B1 所用,詳見 M-B1 設計輸入。
  - **oonid/pr**:無 Termux 依賴的獨立 APK,以修補版 proot 跑 Alpine/Debian——**targetSdk 35 實機驗證 gcc/rust/cargo/git/openssh 全工具鏈 41 測試通過**,並完整記錄 W^X(SELinux 擋 filesDir ELF execve)與 zygote seccomp(chmod/chdir/clone3 ENOSYS)的破解機制(PROOT_LOADER + 18 個 SIGSYS handler + openat ENOENT 語意修正)。
  - **code-server(Coder)官方文件**:Android 官方路線之一為 UserLAnd(proot)內 `apt install nodejs` → `npm install -g code-server`;社群 launcher 亦普遍推薦 proot Ubuntu 路線勝於原生 Termux。
  - **Node 官方一級構件**:nodejs.org 發佈 v22 linux-arm64 tarball(查證當日 v22.23.2 存在)。
  - **V8 JIT 無 proot 失敗記錄**:V8 以 W/X 分離映射配置可執行記憶體,不違反 Android W^X;文件中找不到「V8 無法 JIT 於 proot」案例,已知失敗點均為 bionic getifaddrs / seccomp / execve,且有既有解法。
  - **已知坑與解法(皆有文件)**:① bionic `getifaddrs` 令 `os.networkInterfaces()` segfault → OpenClawd 以 `NODE_OPTIONS=--require bionic-bypass.js` monkey-patch(本專案 SDK 若於啟動期列舉網路介面需同款處理);② proot 下 npm 快取 bug(termux/proot-distro #548,proot-bug 標籤)——本計畫引擎 bundle 隨 APK 展開、不跑 npm install,天然免疫;③ 程序建立有顯著 ptrace 開銷(程序鏈上 proot 每次皆設 tracer)——本專案 run 期間 spawn rg / 子代理 / bash 頻繁,屬效能議題非正確性議題,I/O 慢 20–40% 為預期值。
  - **外部證據退休不掉的殘餘項(M-A0 剩餘獨特價值)**:① 本 repo sdk dist(純 JS + WASM + 靜態 rg)於 Node 22 arm64 proot 內 import;② vendored ripgrep ELF 於 proot ptrace 下 spawn;③ 一輪 base2 真實任務的 arm64 RSS;④ 工 workaround 集實測(bionic-bypass 是否需要 / env 衛生 / `--sysvipc`)。四項皆屬「已知模式」層級風險,無 unknown unknowns——故可安全併入 M-B1 首次實機運行一併驗證,不再構成 Phase B 前置阻斷。
  - **M-B1 設計輸入(自證據淬取,已併入 §4 M-B1)**:proot 參數補 `--sysvipc` 與 `--kernel-release`;`/dev/urandom→/dev/random` bind(Node crypto);假 `/proc/stat`、`/proc/loadavg`、`/proc/version`、`/proc/vmstat` 預生成 bind;空目錄 bind 到 `/sys/fs/selinux` 關閉 SELinux 檢查;`/dev/shm` bind 到 rootfs `/tmp` 供 POSIX shm;`env -i` 潔淨環境層(與 ADR-12 金鑰不落地、env 洗滻同向加成);W^X 主機制為 PROOT_LOADER(nativeLibraryDir 內 loader 代 exec guest ELF),非僅 fallback。

### M-A0 引擎冒煙(1 天,首里程碑)

> **現況(2026-09-03)**:核心假設已獲第三方量產先例背書(§3.0 補充 9),本里程碑自「Phase B 前置阻斷」降級為「AnyBuff 特定回歸確認」——可併入 M-B1 首次實機運行(屆時以本節同款查檢清單驗證本 repo dist / rg spawn / RSS),或隨時以 Termux 快速執行(步驟見下、查檢清單:docs/android-m0-engine-smoke.md)。原文保留如下。

- Termux → `proot-distro install ubuntu` → 進入 rootfs → 安裝 Node 22(arm64 官方 tarball)→ `git clone` 本 repo → `bun install && bun run build:sdk` → 設定相容 provider 的 key → `bun scripts/smoke-sdk.ts`。
- **通過標準**:`SMOKE OK`(calculator.js 被正確修改)+ 記錄 RSS / 耗時。
- 失敗時排查順序:① ripgrep 執行(`code_search` 會直接暴露);② tree-sitter WASM 路徑解析(`init-node.ts` 支援環境變數覆寫);③ ESM/CJS 載入路徑。

### M-A1 host-core 抽取(1–1.5 週)

搬遷與縫合清單:

| 現址(desktop/src/main) | 去向(packages/host-core/src) | 縫合點 |
|---|---|---|
| `start-run.ts`(run 編排、SILENT_AGENT_TYPES、normalizeToolInput / extractBlockedPaths、核准閘門、L3 重試) | `run/` | 拔除 Electron 依賴;`requestApproval` callback 語意不變 |
| `session-store.ts` | `sessions/` | 檔案根由 `app.getPath('userData')` → 注入 `HostPaths.dataDir` |
| `settings.ts`(明文設定 + `encryptedKeys` vault) | `settings/` | DPAPI → `SecretStore` 介面(§2.2) |
| `mcp-settings.ts`(三層掃描 + DPAPI secret) | `mcp/` | 同上 |
| `agents/local-agents.ts` + `agents/bundled-agents.ts`(產物) | `agents/` | 產物 import 路徑調整(generator 產出位置不動) |
| `file-filter.ts` | `files/` | 純邏輯,原樣搬 |

- 縫合原則:`app.getPath('userData')` → `HostPaths` 注入;Electron `ipcMain.handle` → `ChannelDispatcher` 介面(desktop 以 ElectronIPC 實作、Android 以 WsDispatcher 實作,host-core 兩者皆可掛)。
- **禁止**:本階段不得修改 `sdk/`、`packages/agent-runtime/`、`common/`(引擎零修改,ADR-1/ADR-6)。

### M-A2 WebSocket server 與契約 schema(0.5–1 週)

- 新 `packages/host-core/src/server/`:以 `ws`(sdk 既有依賴)實作,聽 `127.0.0.1:0`(動態埠)。
- 協議(request/response):`{id, channel, args}` → `{id, ok, result?, error?}`;事件推送:`{channel:'AnyBuff:event', event}`。
- 核准 / ask_user:複用 `approvalResponse` / `respondAskUser`,以 runId 關聯,語意與 Desktop 完全一致。
- 契約以 TypeScript 型別 + zod schema 定義為**單一事實來源**(照 ADR-18 慣例),契約測試直接消費。
- Origin 驗證 + session token(§2.3)。

### M-A3 renderer shim + web build(0.5 週)

- 抽 `window.AnyBuff` 介面到 `renderer/src/host.ts`(型別層);
- 新 `renderer/src/host-ws.ts`:啟動時若 `window.AnyBuff` 未定(Electron preload 不在)→ 建立 WS client 並綁到 `window.AnyBuff`;`IS_PREVIEW` 路徑保留(瀏覽器原型照用);
- 新增 Vite 純 web build 設定(供 Android assets):`base: './'`,輸出至 `dist-web/`;
- **不改 renderer 現有任何呼叫點**。

### M-A4(可滑動)Desktop 改接 host-core(0.5–1 週)

- `desktop/src/main` 改為薄 IPC 層 → 呼叫 host-core(ElectronIPC dispatcher)。
- **可延後**:Phase B 可先以兩套 host 並行推進;但 **M-A4 完成前凍結 `start-run.ts` / `session-store.ts` 的結構性大改**,避免雙份漂移。建議於 Phase B 期間完成收斂。

**Phase A 驗收:**

1. `bun run build:sdk`、`bun --cwd desktop run typecheck`、`cd sdk && bun test src/impl/__tests__ src/__tests__/followups-policy.test.ts` 全綠;
2. host-core 契約測試:每個 channel 至少一條 round-trip(bun test);
3. 純瀏覽器(preview vite)+ WS host:完整跑一輪 smoke 任務——核准橫幅、工具卡、file-changes 顯示全正常;
4. desktop 手動回歸(M-A4 完成後)。

---

## 4. Phase B:Android Kotlin 殼(3–5 週)

新 root 目錄 `android/`(獨立 Gradle 專案,不進 bun workspace,獨立 CI)。套件名建議 `com.anybuff.android`(實作時定案)。minSdk 26 / targetSdk 36 / `arm64-v8a`(+可選 `x86_64` 供模擬器)。

### 4.0 執行紀錄(2026-09-03 Phase B 開工;2026-09-04 實機第一輪回饋修復——引擎全量入 APK)

> 本節為實際落地狀態,取代下方各里程碑「規劃」文字作為現況基準。**所有程式碼層面已驗證**:host-core typecheck/build、31 契約測試、desktop typecheck + `build:web`、`gradlew :app:assembleDebug` 全綠。剩餘工作皆屬**實機驗證鏈**(需 Android 裝置 + 可執行 ELF),無法於本機完成。

**已交付(2026-09-03 下午起):**

- **M-A3 web build(完成,偏差 1 解除)**。`desktop/web-vite.config.ts`(root = renderer、`base:'./'`、alias 同 electron-vite)→ `desktop/dist-web/`(index.html + hashed assets);`desktop/package.json` 新增 `build:web` / `preview:web`。產物已同步進 APK `assets/www`。renderer `main.tsx` 於無 preload 時依 `__ANYBUFF_WS_URL__`(Android 注入)或 `?ws=`(preview)建立 WS shim;`host-ws.ts` 擴充 `AnyBuffNativeBridge`(`pickFolder`/`pickFiles`/`openExternal`/`getVersion`)+ GitHub Releases 更新檢查(`checkForUpdates`/`updateCheck`/`onUpdateEvent` 對應側載期「比對版本 → 開下載頁」語意)。
- **host-core 單檔 host bundle(完成)**。`scripts/build.ts` 增 `Bun.build` → `dist/anybuff-host.mjs`(self-contained ESM,external 表:node builtins + `bufferutil`/`utf-8-validate`/`web-tree-sitter`);`src/server/anybuff-host.ts` = 獨立 headless host 入口(env 設定 data dir / secrets / rg path / wasm dir / ts wasm / origins / port,stdout 印 `ANYBUFF_HOST_READY <port> <token>`,`ANYBUFF_HOST_SECRETS` 一次性金鑰注入記憶體)。`src/env.ts` 增 `keyOverrides`/`keyPersistence` 接縫、`settings.ts` 的 `saveProviderApiKey`/`getProviderApiKey`/`getProviderApiKeyOverrides`/`hasAnyApiKey` 改 overlay 優先(ADR-11/12 Android 臂)。

### M-B0 專案骨架(0.5 週)

> **現況(2026-09-03)**:✅ 完成(見 §4.0)——AGP 8.13 / Gradle 8.14 / Kotlin 2.2、compileSdk 36 / minSdk 26 / targetSdk 36、arm64-v8a、`useLegacyPackaging=true`、NSC loopback cleartext、WebView + AssetLoader 骨架、`EngineService`(specialUse FGS)。資產同步 `syncWebAssets`/`syncEngineAssets` 以 `sourceSets.assets.srcDir` 掛進 AGP task graph(無手動 dependsOn hack),APK 實含 `www/index.html` + engine bundle。原文保留如下。

- Gradle + AGP 現行穩定版;`useLegacyPackaging = true`(jniLibs 抽出至 `nativeLibraryDir` 才可 exec);
- Network Security Config:`<domain-config cleartextTrafficPermitted="true">` 限 `localhost` / `127.0.0.1`(API 28–36 必須明寫;Android 17 起才有隱式豁免);
- WebView 最小骨架:`WebViewAssetLoader` 載入 renderer web build(assets/www)。

- **M-B0 骨架 + 資產同步(完成)**。`android/` 獨立 Gradle 專案:AGP 8.13 / Gradle 8.14 / Kotlin 2.2(org.gradle.java.home=jdk-17,見偏差 3),`app/build.gradle.kts` 以 Sync task 自 `desktop/dist-web` → `assets/www`、自 `packages/host-core/dist`(anybuff-host.mjs)+ `sdk/dist`(vendored `rg` arm64 + tree-sitter wasm)→ `assets/engine`;`sourceSets.assets.srcDir` 掛進 AGP graph。Manifest 已備 INTERNET / FGS specialUse(+`PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 說明)/ POST_NOTIFICATIONS;`AnyBuffApp` 建 notification channel;`MainActivity` = WebViewAssetLoader + `WebViewCompat` 注入 + render-process-gone 重建 + SAF launcher + EngineService 啟動。
- **M-B1 Kotlin sandbox 子系統(初版完成,待實機驗證)**。`engine/`:`SandboxPaths`(filesDir 佈局)、`SafeTarExtractor`(自寫 tar 解壓器——ustar/PAX/GNU longname、**symlink 逃逸拒絕**、hardlink fallback、mode/mtime 套用、.gz/.xz 穿透)、`RootfsInstaller`(rootfs.tar.gz + node.tar.xz 下載→staging→rename 原子切換 + 修補)、`ProotRunner`(組裝 `libproot_exec.so --root-id --sysvipc --link2symlink --kill-on-exit --kernel-release=<6.1.0-android> -r <rootfs> -w /workspace -b … /usr/bin/env -i … <node> <anybuff-host.mjs>`,含 PROOT_LOADER / proc-fakes / selinux 空 bind / urandom→random 等設計輸入)、`SandboxManager`(assets 展開→安裝→啟動 host→發佈 WS URL;stop 殺 process tree)、`EngineService`(specialUse FGS 生命週期,通知含停止鈕;M-B1 啟動邏輯為 TODO 待實機)。
- **M-B2/B3/B5 Kotlin 初版(完成,待實機/收尾)**。`crypto/KeyVault.kt` = AndroidKeyStore AES/GCM/NoPadding 256(iv‖ct base64 落盤);`bridge/NativeBridge.kt` = `WebViewCompat.addWebMessageListener`(origin allowlist 精填 appassets)+ SAF folder/files picker 複製進 filesDir/upload + `openExternal` + `getVersion` + Keystore save/delete/get + `bootstrapJs(wsUrl)` 注入 `__ANYBUFF_WS_URL__/__ANYBUFF_APP_VERSION__/__ANYBUFF_NATIVE__`;`MainActivity` 啟動流程 = FGS → SandboxManager.start → onHostReady 注入 + reload。

**驗證結果(2026-09-03):**

1. host-core typecheck ✓、build(ESM/CJS/d.ts + anybuff-host.mjs)✓;契約測試 dispatcher 20 + ws-server 11 = 31 全過;desktop typecheck(node+web)✓、`bun run build:web` ✓(dist-web 產出)。
2. `android`:修正 local.properties 轉義炸點(SdkLocator)、`addDocumentStartJavaScript` 簽名(script 先、origins 為 `Set`)、KDoc 內 `assets/engine/*` 的 `*/` 提早關閉註解(致整檔 parse 失敗、連鎖 phantom errors)、Kotlin 無八進位字面值(`0o` → 二進位遮罩)後 **`:app:assembleDebug` BUILD SUCCESSFUL**;APK 20MB 實含 13 筆 engine asset(anybuff-host.mjs 14.7MB + rg + 12 wasm)+ www/index.html。
3. 尚未(需實機):proot ELF 注入 nativeLibraryDir 後 exec、rootfs/Node 下載解壓、host 於 sandbox 內起 WS、WebView 連線主流程。

**偏差與補充事項(2026-09-03):**

- **偏差 1 — web build 現況已解除**:`build:web` 落地並同步進 APK assets/www(見上)。
- **偏差 2 — 本機編譯環境**:AGP 8.13 於 Windows 需 JDK 17(`gradle.properties` 設 `org.gradle.java.home=/c/Program Files/Java/jdk-17`);原 JDK 24 造成 `ProviderBackedFileCollection` IOException(SdkLocator 層),換 JDK 17 並刪除錯誤轉義的 `local.properties`(改用 `ANDROID_HOME`)後解決。此為開發環境事項,不影響 CI。
- **偏差 3 — 計畫 §2.2 金鑰流程小幅演化**:`getProviderApiKeyOverrides` 改為 memory-overlay 優先(Android:Keystore 解密→`ANYBUFF_HOST_SECRETS`→host-core env `keyOverrides`);renderer 的 SettingsModal 存 key 時經 `__ANYBUFF_NATIVE__.saveKey` → Kotlin Keystore(不落 WebView、不落盤明文)。
- **補充 4 — proot 二進位尚未入庫**:`scripts/fetch-proot.sh`(自 Termux 源取 `libproot_exec.so`/`libproot_loader.so` → jniLibs)已備妥但未執行;`android/.gitignore` 已排除 `jniLibs/*/libproot_*.so`(GPL 二進位不進 git,NOTICE 已備聲明)。實機前需跑一次並確認 arm64 可用。
- **補充 5 — M-A3 瀏覽器驗證順延**:Node 24 本機環境使 host-core/ws 相容性未測(先前結論),web build + `?ws=` 連 anybuff-host 的瀏覽器 smoke 待 Android 實機或環境修正後補。
- **補充 6 — host bundle 的 web-tree-sitter**:`build.ts` external 保留 `web-tree-sitter`(emscripten 產物不宜 bundle),執行時以 `ANYBUFF_HOST_TS_WASM` / `ANYBUFF_HOST_WASM_DIR` 指向展開後 wasm;APK 內已含全部 12 個語言 wasm + 核心 tree-sitter.wasm(資產清單見前)。

**實機第一輪回饋(2026-09-03 夜——debug APK 首次上機):**

使用者回報:「引擎啟動失敗 download failed HTTP 404: cdimage.ubuntu.com/.../ubuntu-base-24.04-base-arm64.tar.gz」。根因鏈診斷出**五顆連續未爆彈**(前四顆皆屬「首啟 HTTP 下載」設計的 URL-rot/打包缺陷,與使用者直覺「引擎應該內建」一致):

1. **Rootfs URL 腐爛(引爆點)**:Ubuntu 將 24.04 目錄下的 arm64 tarball 下架(現行版移至 `releases/noble/` 24.04.4)。首啟下載 404 → app 完全無法啟動。此設計风險在計畫 §3.0 已部分預見(URL pin)但未預見「下架」而非「改版」。
2. **proot 二進位從未入 APK**:`fetch-proot.sh` 舊版從未執行、jniLibs 為空。即便修好下載,下一秒必炸「libproot_exec.so not found」。
3. **`web-tree-sitter` JS 模組未入包**:`anybuff-host.mjs` 對它有真實外部 import,但 Gradle sync 只搬了 wasm 未搬 JS 套件本體——sandbox 內 host 啟動即 `Cannot find package`。
4. **`libtalloc.so.2` 被 AGP jniLibs 靜默丟棄**:jniLibs 只打包 `lib*.so` 模式檔名,`libtalloc.so.2` 不符被無聲濾掉——proot 的 NEEDED 依賴必炸。
5. **ProotRunner `env -i` 環境剝除 bug**(本輪 code-review 發現):host 的 `ANYBUFF_HOST_*` 設在 Android 端 ProcessBuilder env,但 `env -i` 在 guest 內把它們全清了——host 拿不到 data dir/wasm/secrets,屬靜默啟動失敗類。

**決策(使用者拍板,2026-09-04)**:**引擎運行時全量入 APK**(rootfs + Node + proot;不再有任何首啟 HTTP 下載)。APK 20MB → 117.5MB(rootfs tgz 28.6MB + node tar.xz 28.8MB stored + proot 四件套 <0.3MB + engine bundle/www)。APP icon 沿用桌面版(adaptive 標準做法:邊緣藍 #0170FC background + 白 logo foreground + monochrome)。

**修復內容(2026-09-04):**

- **新增 `scripts/fetch-engine-runtime.sh`**:pin `ubuntu-base-24.04.4`(SHA256 對官方 SHA256SUMS 驗證)+ `node-v22.23.2-linux-arm64`(同)→ `assets/runtime/` + `manifest.json`(app 安裝時流式 SHA256 複驗)。**資產存檔名 `.tgz` 而非 `.tar.gz`**——AAPT2 對 `.gz` 結尾的 asset 會 gunzip+去尾綴(實證:APK 內出現 106MB 未壓縮 tar 且改名),`.tgz` 副檔名繞開此行為。
- **重寫 `scripts/fetch-proot.sh`**:pin proot 5.1.107.92 + **libtalloc 2.4.3(LGPL-3.0+,NOTICE 已補)** + **libandroid-shmem 0.7**;純 Python ar/tar 解包(Windows 無 binutils/bsdtar 也可跑);ELF DT_NEEDED 解析驗證閉合(jniLibs 三件套 + `libtalloc.so.2` 走 `engine-libs/` → assets → filesDir 暫存 + `LD_LIBRARY_PATH`,因 AGP jniLibs 檔名模式限制)。
- **RootfsInstaller 全面改寫**:安裝源從 HTTP 下載改為 APK assets(`assets/runtime/`);manifest 驅動、邊解邊 SHA256 複驗、marker 以 payload SHA256 為鍵(同 payload 不重裝)、staging→rename 原子切換保留 ADR-13 語意、安裝後刪除暫存 archive、進度取消支援。
- **Gradle sync 重構**:生成資產改至 `build/generated/anybuffAssets/`(舊法放在 `src/main/assets/` 內導致 AGP 預設 assets root + srcDir 雙重掛載,**每個 asset 打了兩份**);`merge*Assets` 顯式 `dependsOn(syncWebAssets, syncEngineAssets)`(srcDir 掛載在 AGP 8.13 對外部 build 目錄不會自動接線——先前是在 src/main/assets 內才碰巧掃到);`noCompress` 移除 `gz`(rootfs 改 .tgz)、保留 `xz`/`tgz` stored;sync 加帶 `node_modules/web-tree-sitter`(JS 模組)+ bundle 旁 `tree-sitter.wasm`(host 的 resolveTreeSitterWasm 找 scriptDir 旁)。
- **ProotRunner 修復**:`guestEnv()` 改為 `env -i` 引數傳遞(修 #5 環境剝除);Android 端 env 只留 proot 自身所需(`PROOT_LOADER`/`PROOT_TMP_DIR`/`LD_LIBRARY_PATH`=filesDir libs + nativeLibraryDir);補 `ANYBUFF_HOST_APPDATA`、wasm 路徑改用 bundle 實際讀取的 `CODEBUFF_TREE_SITTER_WASM_PATH`/`CODEBUFF_WASM_DIR`(對 dist 逐字驗證);`hostdata` bind 修復(先前漏掛);libtalloc 暫存 tmp+rename 原子化(半寫入永不毒化快取);proot-tmp 目錄 mkdirs。
- **SafeTarExtractor symlink 語意修復(裝置阻斷級,本輪審查抓到)**:**絕對路徑 link 目標**(tar 內實證 20 個,如 `etc/alternatives/awk → /usr/bin/mawk`)先前經 `File(parent, "/usr/bin")` 解析到 Android 實機路徑→必誤判逃逸→rootfs 安裝中止。改為絕對目標以 rootfs 為 `/` 解析;相對目標行為不變。symlink 失敗從「靜默跳過」改為 **fatal**(usrmerge 發行版的 /bin、/lib 連結是 node exec 命脈);同名舊檔案/空目錄讓位邏輯。**以 Python 移植同一語意對真實 tarball 全量驗證:2562 檔 + 194 symlink、0 拒絕,usrmerge 連結與絕對目標全部正確**。
- **SandboxManager**:`start()` 的 single-flight 分支改為**pending-listener 佇列**(先前 Activity 於首裝期間 recreate 時,新 listener 靜默丟失→新 WebView 永遠停在 splash)。
- **MainActivity**:錯誤頁「重試」鈕接真實重開(`addJavascriptInterface` 回調 bootEngine,`location.reload()` 無法重跑 Kotlin 啟動鏈)。
- **EngineService**:停止鈕接上 `SandboxManager.stop()`(先前為 TODO)。
- **Icon 全面換桌面版**(`scripts/gen-icons.py`,PIL):`icon-256.png` 白 logo 門檻提取(>200)+ 輕度模糊抗鋸齒;adaptive foreground 52%/60% 內縮(66dp safe zone 內)、monochrome 同形、背景取圓邊藍 `#0170FC`;legacy mipmap 全密度柵格;通知小圖示白 glyph 全密度。Manifest 接 `roundIcon`。
- **NOTICE 重寫**:proot(GPL-2.0+)、**libtalloc(LGPL-3.0+,新增)**、libandroid-shmem(Apache-2.0,新增)、Ubuntu base(随 APK 附帶條款)、Node.js(MIT)。

**驗證(2026-09-04)**:`:app:assembleDebug` BUILD SUCCESSFUL;APK 117.5MB 內含——runtime 雙 tarball + manifest(各一份,無重複)、engine bundle + `node_modules/web-tree-sitter` + bundle 旁 tree-sitter.wasm + 11 個語言 wasm + rg + `lib/libtalloc.so.2`、www/index.html + assets、jniLibs 三件套、全密度 icons;無 assets 根層雜物(strays=0);SafeTarExtractor 語意對真實 rootfs tarball 全量通過(0 拒絕)。

**實機第二輪回饋(2026-09-04 上午——引擎入 APK 後首次上機)**:

使用者回報三項:① icon 漸層遺失(桌面版是放射漸層光暈,Android 版做成了平色)+ 白 logo 比例過大;②「引擎啟動失敗 extraction of rootfs-ubuntu-base-24.04.4-arm64.tgz failed」——錯誤頁只顯示外層 wrapper 文字,真實 cause 被吞。

**診斷**:

1. **解壓失敗非解析問題**:同一語意的 Python 模擬器對真實 tarball 全量 0 拒絕、SHA256 亦通過 → tar 結構乾淨;失敗點在**裝置端環境**(ENOSPC / symlink EPERM / emulated-FS utimes),且 `RootfsInstaller` 的 `RuntimeException("extraction … failed", e)` 只把 wrapper 文字送上 UI——**cause 鏈斷在錯誤頁**。追查時另發現一顆裝置阻斷級 bug(見 3)。
2. **icon 主檔量測**:桌面版 `icon-256.png` 為放射漸層(亮部偏左下)→ 深藍圓邊,先前 Android 背景做成平色 `#0170FC`、logo 放到 52%——桌面版 logo 寬僅約圓徑 63%。
3. **Node 安裝 staging==live 刪除 bug(裝置阻斷級,追查 extraction 時發現)**:`extractFromAssets(nodeAsset, paths.nodeStaging, paths.nodeStaging, …)` 把**同一目錄**同時當 staging 與 live——swap 尾段把裝好的 tree rename 成 `node.staging` 後,`staging.deleteRecursively()` 立刻把剛裝好的 tree 刪掉 → marker 指向已刪除的 tree,下一次 boot 在 ProotRunner 才爆「node binary missing」(被誤導成另一個症狀)。
4. **`guestEnv()` 參數 bug**:`startHost` 誤傳 `paths.hostData.absolutePath` 而非 `hostSecretsJson` → `ANYBUFF_HOST_SECRETS` 內容錯誤(金鑰握手失效,靜默)。

**修復內容(2026-09-04,第二輪):**

- **RootfsInstaller**:Node 改安裝至 `paths.node`(非 nodeStaging);**刪除 `installNodeIntoRootfs()` 的整樹複製**(省 ~194MB device 空間 + 縮短首裝時間)。錯誤包裝帶入 cause(`extraction of X failed: <cause>`);manifest 增 `uncompressedBytes` → 安裝前 `StatFs` 空間預檢(淨需求 + 50MB margin,不足即明確拒絕,不再中段 ENOSPC)。
- **ProotRunner**:node 改為 **bind 進 guest `/opt/node`**(非拷入 rootfs;`/opt` 於 ubuntu-base 實存 0755 目錄,避開 bind 到缺目錄的 proot symlink 模擬坑);guest PATH 前綴 `/opt/node/bin`;命令改 `$guestNodeDir/bin/node`;`guestEnv(hostSecretsJson)` 參數修正。
- **SafeTarExtractor**:`Os.symlink` fallback(部分 OEM SELinux 拒 `Files.createSymbolicLink` 但 raw syscall 過);`setLastModified`/`setReadable` best-effort(emulated/FUSE EPERM 不再中斷);目錄成員強制 owner-write(0555 dir 仍可建子項)。
- **SandboxManager**:`onError` 併呈最內層 cause(ENOSPC/EPERM 等不再被吞,錯誤頁看得到真因)。
- **Icon 第二輪(`gen-icons.py`)**:背景層改**放射漸層 drawable PNG**(桌面版取樣:中心亮 `(26,161,253)` → 邊緣深 `(6,71,253)`;adaptive XML 的 `ic_launcher_background` 指向 drawable 而非純色);**foreground 白 logo 縮至 39.8% 寬**(172/432,桌面版忠實比例,66dp safe zone 內);monochrome 同步。

**驗證(2026-09-04 第二輪)**:`:app:assembleDebug` BUILD SUCCESSFUL(APK 123.2MB);背景漸層採樣確認(角隅深藍→中心亮);logo bbox 172/432=39.8%;無殘留 `installNodeIntoRootfs`/staging-as-live 參照。

**實機第三輪回饋(2026-09-04)——錯誤鏈診斷奏效**:第二輪把 cause 鏈接上錯誤頁後,使用者回報的訊息直接命中真因:

> 引擎啟動失敗 extraction of rootfs-ubuntu-base-24.04.4-arm64.tgz failed: **symlink escapes rootfs: usr/bin/pager -> /etc/alternatives/pager**

**根因(SafeTarExtractor escape check 的 realpath 語意漏洞)**:tar 內 `etc/alternatives/pager -> /bin/more`(member 9)先被建立,之後 member 352 `usr/bin/pager -> /etc/alternatives/pager` 的逃生檢查對目標做 `canonicalFile`(realpath)——**realpath 會沿著先前建立的 guest-absolute symlink 追到裝置真實檔案系統**(`/bin/more` → 裝置的 `/system/bin/more` 等)→ 誤判「逃出 rootfs」→ 中止。本機 Python 模擬先前會過,是因為模擬器在**空的**虛擬 FS 上解析絕對路徑(guest 語意),而裝置端 realpath 會跨 symlink 追蹤到 host。**錯誤鏈修復(第二輪)讓這顆潛伏 bug 現形——它是裝置阻斷的真正原因,不是 ENOSPC/EPERM。**

**修復內容(2026-09-04,第三輪)——解壓器改純詞法語意**:

- **`resolve()` 不再用 `canonicalFile`/realpath 判斷 containment**:改為「詞法 `..` 深度檢查 + 逐段組建 + **拒絕穿過既有 symlink 中間層**(member path traverses symlink)」。realpath 語意在此場景本質錯誤:guest-absolute symlink 內容只在 guest(proot,`/` == rootfs)內被 deref,host 端 realpath 會追到裝置路徑。
- **`makeSymlink` 逃生檢查改 `lexicallyResolveInside(dest, target.parentFile, link)`**:絕對內容以 rootfs 根為錨、相對內容以 symlink 自身目錄為基、`..` 在 root 鉗制(POSIX chroot 語意)——純字串運算,零檔案系統呼叫。
- **安全性不降**:寫入路徑仍不可穿過既有 symlink(`x/passwd` 在 `x -> /etc` 之後必拒)、member 名 `..` 越 root 必拒、symlink 內容詞法上永遠留在 root 內。對「真實 payload 不穿過 symlink 祖先」的保證已在註解標明(usrmerge 發行版內容全在 `usr/` 下)。
- **新增 `scripts/simulate-rootfs-extract.py`(in-repo,替代先前 /tmp 的臨時模擬)**:鏡像新詞法語意對真實 tarball 全量驗證 + 4 個合成攻擊負例(穿 symlink 寫入 / `..` member / 相對 `..` 內容鉗制 / 絕對 `..` 內容錨定鉗制)+ **pager 鏈回歸測試**。

**驗證(2026-09-04 第三輪)**:`:app:assembleDebug` BUILD SUCCESSFUL(APK 123.2MB);`simulate-rootfs-extract.py` → 真實 rootfs 全量 0 拒絕(3413 members / 194 symlinks)+ 全部負例與 pager 鏈回歸通過(EXIT 0)。

**實機第四輪回饋(2026-09-04)——rootfs 解壓已過,下一顆炸彈現形**:

> 引擎啟動失敗 host bundle missing at /data/user/0/com.anybuff.android/files/engine/install/anybuff-host.mjs

**進展**:第三輪詞法修復奏效——rootfs + Node 安裝已完整跑完;此錯誤來自 `ProotRunner.startHost` 檢查 `paths.installDir/anybuff-host.mjs` 不存在(engine assets 展開不完整)。

**根因(`SandboxManager.expandEngineAssets` 展開邏輯)**:`assets/engine/` 下**頂層同時有檔案與目錄**(`anybuff-host.mjs`、`tree-sitter.wasm` 兩個檔案 + `lib/`、`node_modules/`、`vendor/`、`wasm/` 目錄)。舊 `copyDir` 把每個頂層項目都當目錄餵進遞迴,而 `AssetManager.list()` 對**檔案**回 null/empty → 第一行 `?: return` 靜默返回——**兩個頂層檔案從未被複製**(以 APK 真實結構重現:舊邏輯拷 16 檔、漏這 2 檔;新邏輯拷滿 18 檔)。

**修復內容(2026-09-04,第四輪)**:

- `expandEngineAssets` 改 `copyPath`:每一層(含頂層)以 `list()` 回傳 null/empty = 檔案(stream 拷出)、非空 = 目錄(mkdirs + 遞迴),均勻分辨。
- `ASSET_LAYOUT` 1 → 2(marker 檔名 `.expanded-v<versionCode>-l2`):讓已寫過 buggy `l1` marker 的裝置強制重展開(舊 marker 不匹配)。
- 以 APK zip 實體結構逐步驗證:每個目錄 `list()` 均非空、每個檔案均空 → 無空目錄誤判風險;新邏輯拷滿 18 個 engine asset(含先前漏的 `anybuff-host.mjs` + `tree-sitter.wasm`)。

**驗證(2026-09-04 第四輪)**:`:app:assembleDebug` BUILD SUCCESSFUL;Python 模型對實際 APK 結構證明 OLD=16 檔(漏 2 頂層檔)、NEW=18 檔全拷。

**待實機驗證(第四輪修復後)**:重裝 APK(versionCode 未變,但 `ASSET_LAYOUT` bump 觸發重展開)→ rootfs/Node 已裝(跳過)→ engine assets 展開補上 host bundle → proot 起 host → WS ready → renderer 載入。新增風險項:APK 體積 123.2MB(側載可接受;未來 Play 上架需評估 AAB 拆分/按需模組)。

**實機第五輪回饋(2026-09-04)——引擎跑通!六項 UI/功能問題**(引擎鏈路 rootfs→Node→proot→host→WS→renderer 全通,進入 M-B1 UI 打磨階段):

1. UI 完全沒有針對手機螢幕優化;
2. 頂端列(File/Edit/View)在 Android 端完全不需要;
3. 點 attach file 沒出現 picker,反而自動載入 calculator.js;
4. portrait 下左側欄覆蓋主頁(應把頁面往右推);
5. 新增 provider 報 "Failed to fetch models: WS request timed out: fetchModels";
6. portrait 下左側欄下方跑到畫面外。

**根因診斷(第五輪)——三個深層 bug + 佈局錯位**:

- **#3+#5 同源:`IS_PREVIEW` 模組求值順序 bug(隱藏深層 bug)**。`App.tsx` 的 `const IS_PREVIEW = typeof window.AnyBuff === 'undefined'` 在**模組層**求值;ES import 提昇使 App.tsx 先於 `main.tsx` 的 `window.AnyBuff = createWsAnyBuff(...)` 執行 → Android WebView 上恆為 `true` → 整個 UI 跑在 demo/preview 模式(假 calculator.js 附件、模擬對話、不走真 WS)。桌面不受影響(preload 早於 bundle 注入)。
- **#5 直接原因:CSP 擋掉 WS**。`index.html` CSP `default-src 'self'` 無 `connect-src` → `ws://127.0.0.1` 被擋 → SettingsModal 的 fetchModels(第一個真 WS 呼叫)30s timeout。demo 模式遮蔽了其餘 WS 失效。
- **#4+#6:`@media (max-width:500px)` 把 sidebar 設成 `position:absolute` overlay** → 覆蓋主內容(#4);`height:100%` 配非定位祖先在 edge-to-edge 下溢底(#6)。
- **#3 第二層(修好 IS_PREVIEW 後會撞上):SAF picker 路徑錯位**。`NativeBridge` 把檔案拷到 `filesDir/upload/`,回傳**host 絕對路徑**(`/data/user/0/...`);但 `ProotRunner` bind 的是 `filesDir/workspaces/upload → /upload`,且 proot chroot 內**不存在** host 絕對路徑 → host 讀不到。

**修復內容(2026-09-04,第五輪)**:

- `App.tsx`:`IS_PREVIEW` 模組常數刪除,改元件內 `const [isPreview] = useState(() => typeof window.AnyBuff === 'undefined')`(首次 render 時 main.tsx 已完成指派 → Android 正確判 false;純瀏覽 preview 仍 true);40 處引用改名 + 6 個 effect dep 補 `isPreview`(mount-stable)。`leftOpen` 初始值改 ≤640px 時 false(手機預設收起側欄,開啟才 flex 推擠)。
- `main.tsx`:`if (wsUrl)` 分支指派 `window.AnyBuff` 後加 `document.documentElement.classList.add('is-webview')`(Electron 不進此分支)。
- `index.html`:**CSP 加 `connect-src 'self' ws: wss: https:`**(桌面 WebView 都放行 WS;先前 dist-web 是舊 bundle,需重建)。
- `styles.css`(檔尾新增 Mobile/WebView overrides):`.is-webview .titlebar{display:none}`(#2);`.app{height:100dvh}` + `.is-webview .app-body` safe-area padding(#6);**刪除** 500px absolute-overlay 塊,窄螢幕 sidebar 改 `width:min(232px,78vw)` flex 推擠(#4);≤640px mobile polish(composer margin、right-panel `min(276px,92vw)`、settings-page 改頂部橫向 tab strip + `.settings-page-main{flex:1;min-height:0}`)(#1)。
- `NativeBridge.kt`:**SAF 拷貝/回傳改 guest 路徑**——folder pick(選專案)拷到 `filesDir/workspaces/workspace/<name>` 回 `/workspace/<name>`;file pick(附件)拷到 `filesDir/workspaces/upload/<name>` 回 `/upload/<name>`(對齊 ProotRunner bind,chroot host 才讀得到)。

**驗證(2026-09-04 第五輪)**:desktop `tsc --noEmit`(node+web)0 error;`build:web` 出新 bundle(`index-CZgPrCSG.js`/`index-Bi8vFuCR.css` → 再修 CSS 後 `index-DqenxRW1.css`),dist-web 已含新 CSP + 全部 mobile overrides;`:app:compileDebugKotlin` + `:app:assembleDebug` BUILD SUCCESSFUL(APK 123.2MB,14:29);APK 內 `assets/www` 已含新 bundle 與 `connect-src ... ws:` CSP。code-review 無 blocking(兩點已吸收:舊 overlay 塊整段刪除不再殘留 `height:100%`;settings 補防禦性 `min-height:0`)。

**待實機驗證(第五輪修復後)**:重裝 APK 後應見——(a) 進入真 WS 模式(非 demo:無假對話、attach 開 SAF picker);(b) 無 File/Edit/View 頂端列;(c) portrait 側欄收合、開啟時推擠主內容不覆蓋、無底部溢位;(d) Settings 新增 provider 的 fetchModels 不再 timeout(需 host 可達 provider HTTPS——若 rootfs 無 CA 憑證會轉成 TLS 錯誤而非 timeout,屆時需在 guest 綁 Android CA store 或裝 ca-certificates)。已知產品行為(非回歸):Android「Add Project」是把 SAF 資料夾拷成 `/workspace/<name>` 副本,非 git checkout——host 的 `projectName`/`gitBranch` 在非 git 資料夾行為與桌面開任意資料夾一致。

**第六輪(2026-09-04 晚)——第五輪修復 commit,round-6 問題待列**:

- **狀態**:第五輪六項修復全部落地並驗證(desktop typecheck / `build:web` / `compileDebugKotlin` / `assembleDebug` 全綠;APK 內含新 bundle `index-CZgPrCSG.js`/`index-DqenxRW1.css` + `connect-src ws:` CSP;code-review 無 blocking 後已整批 commit)。
- **commit**:`feat(android): ship round-5 webview UI fixes —真 WS 模式 / mobile responsive / guest paths`(含 android Kotlin 側 SAF guest-path 修正 + icon 漸層/比例 + rootfs 三輪修復 + engine 資產展開修復 + renderer 五輪修復,與桌面版共用同批)。桌面 preview HTML 與計畫文件**不進 commit**。
- **使用者在第五輪實機後回報:「問題仍然很多」**——具體細項尚未列出(使用者表示將於**新 session** 提供)。已預先定位的**已知未解候選清單**(下 session 接手時逐一核對,勿假設全部屬實):
  1. **host-core `update_check.ts` 依賴 `electron`**(先前 `grep` 探測到)——`anybuff-host.mjs` bundle 若靜態 import 即會在 sandbox 內崩,需檢查 build.ts 的 external 處理與實機 host 啟動 log;
  2. **rootfs CA 憑證**:fetchModels 若報 TLS 錯誤(非 timeout)即此;修法 = guest 綁 Android CA store(`SSL_CERT_DIR`/`SSL_CERT_FILE`)或 rootfs 裝 `ca-certificates`;
  3. **proot 殘留 process tree**:`SandboxManager.stop()` 對 proot 子程序(host/node)的清理是否完整,重複 start/stop 是否累積 zombie;
  4. **FGS 通知與無頭重啟**:Activity 殺掉/旋轉後 `booted` 短路是否正確重指 WS URL(先前 code-review 暫緩項);
  5. **M-C1 觸控 pass 未啟動**:context menu / hover-only 控制 / IME / 44px 觸控目標等(§5 清單)。
- **風險提示**:第六輪修復後部分裝置層行為(鍵盤 adjustResize、safe-area inset 在各 OEM 的差異、WebView 記憶體)未經全矩陣驗證——本輪 commit 後優先收 round-6 細項。

**第七輪(2026-09-04 晚)——手機直立螢幕 UI 全面重構、測試契約修復、自訂 Agent 依附專案 UX 改善**:

- **使用者回饋與痛點**:使用者全面檢視 Android 版 UI，指出原版基本上是從 Windows 版轉過去，在手機直立小螢幕操作體驗不佳（按鈕/物件超出頁面、側邊欄展開覆蓋主頁且按鈕被遮蔽無法收闔、底部工具列按鈕與 token/reasoning/model 擠壓過度、Settings 子設定排列不適合手機等），提出需求：
  1. UI 文字全部採用 English；
  2. 頂部列移除重複的 settings 按鈕（左側欄已有），標題精簡化，按鈕改為緊湊圖示；
  3. 側邊欄（左側任務/專案列、右側活動/檔案面板）改為滑出抽屜（off-canvas drawer），點擊主頁遮罩自動收闔，雙欄互斥（開左必關右、開右必關左），並為觸控加入長按/「⋯」選單支援；
  4. 底部 Composer 工具列全部精簡為單行，mode / model / reasoning level 按鈕改為 icon-first 緊湊設計，點擊彈出選單，token ring 與 cost 緊湊靠右對齊，永不換行或溢位；
  5. SettingsModal 全面手機適配：頂部由原本水平滾動的 8 個 tab 改為 `[ Category Name ▾ ]` 分類選擇按鈕，點擊後在按鈕下方原地展開浮動下拉選單（而非底部滑出或兩欄式側欄被切斷）；8 大子頁面全面轉換為單欄卡片佈局，McpKvEditor 的 key/value 改為垂直堆疊並附獨立刪除鈕；
  6. 修復 `bun run test:host-core` 關閉時掛住（hang）的問題；
  7. 自訂 Agent 建立流程 UX 完善：確認「未開啟專案目錄下攔截自訂 Agent 建立」為專案原始設計，完整復原 `local-agents.ts`、`AgentWizardModal.tsx` 與 `App.tsx` 檢查邏輯；同時在 `SettingsModal.tsx` 內加入明確的警示與錯誤提示，徹底解決原本因背景無聲攔截導致使用者誤以為「點擊按鈕沒反應」的問題。

- **修復內容(第七輪)**:
  - `Sidebar.tsx`: off-canvas 抽屜、AnyBuff 標題列、✕ 關閉按鈕、touch-friendly ⋯ 按鈕、點選任務/專案自動關閉側欄。
  - `RightPanel.tsx`: 新增 `onClose` callback 與頂部 ✕ 關閉按鈕。
  - `Composer.tsx`: 單行精簡化、icon-first mode/model/reasoning 按鈕、token ring 與 cost 緊湊佈局。
  - `SettingsModal.tsx`: `.settings-mobile-topbar` 頂部選單欄、`[ Category Name ▾ ]` 原地下拉選單、單欄 cards、McpKvEditor 垂直排版、未開啟專案時的即時提示與點擊警示。
  - `App.tsx`: 雙抽屜互斥與 `.drawer-backdrop` 遮罩管理、topbar 精簡圖示按鈕、`cwd` 守衛與傳遞至 SettingsModal。
  - `styles.css`: 完整行動端 CSS 覆寫（抽屜動畫、遮罩、48px topbar、按鈕點擊態、下拉選單、各子頁面響應式排版）。
  - `ws-server.ts`: `httpServer.closeAllConnections?.()` 與 800ms 安全逾時，測試套件 31/31 通過。
  - `local-agents.ts` & `AgentWizardModal.tsx`: 完整復原專案目錄有效性檢核。

- **全量驗證**:
  1. `bun test packages/host-core/src/__tests__/`: **31 pass, 0 fail (957ms)**（不再卡住）。
  2. `bun run typecheck:host-core`: **0 errors**。
  3. `bun --cwd desktop run typecheck`: **0 errors (Node & Web)**。
  4. `bun --cwd desktop run build:web`: Built cleanly (`dist-web/`)。
  5. `.\gradlew.bat :app:assembleDebug`: **BUILD SUCCESSFUL in 25s (APK 123.2MB)**。

**code-review 修復與暫緩事項(2026-09-03,第三輪審查):**

已修復(編譯綠):

- `NativeBridge` 移除 `getKey` 頁面讀回通道(§2.2「金鑰不經 WebView」嚴格化——renderer 無任何呼叫點,僅是暴露面);`openExternal` 限 `http(s)`(擋 renderer 內容經 `intent:`/`file:` 開裝置 handler);`provider-keys.json` 改 temp+rename 原子寫(防寫一半崩潰致整份 key 紀錄損毀)。
- `SafeTarExtractor` 補 PAX/GNU-longname 內容上限(1 MiB,防敵意 header 強制巨量 prealloc OOM);mtime 秒→毫秒修正(原會全落 1970)。
- Gradle `syncWebAssets`/`syncEngineAssets` 補 `delete()`(vite content-hash 檔名會使舊 chunk 累積入 APK)。
- `SandboxManager.expandEngineAssets` marker 改以 **APK versionCode** 為鍵(原固定字串致 App 升級後引擎 bundle 永不覆寫);`start()` 加 single-flight(防 Activity 重建與首次安裝並發雙啟動)。
- `MainActivity.onDestroy` 改 `isFinishing` 才停 sandbox + 通知 `EngineService` 一併 `stopSelf`(防 zombie FGS 覆蓋已殺的 sandbox);`EngineService` 增 `ACTION_SHUTDOWN`。

暫緩(實機階段再處理,不阻斷本 commit):

- **金鑰經 `ANYBUFF_HOST_SECRETS` env 傳遞的 ADR-12 疑慮**:host 啟動後即 `delete process.env`(memory-only),但 spawn 瞬間在 sandbox `/proc` 可讀窗口。實機時改走「WS READY 後一次性 `setSecrets` channel」(host-core 已預留 keyOverrides 接縫,僅需新 channel)。
- **renderer 存 key 的 in-session 同步**:bridge `saveKey` 寫 Keystore,host 的記憶體 overlay 要等下次啟動才 rehydrate;實機時讓 renderer 的 `saveSettings`(已含 apiKeys)→ host-core `saveProviderApiKey` → `keyPersistence` seam 同步 overlay + Keystore(接縫已備,僅需 Kotlin 側實作 persistence 回調)。
- SAF pending 跨 navigation 的 replyProxy 失效、host 死後重啟 booted 短路不重指 URL——皆待實機生命週期驗證一併處理。

**下一階段(實機前代辦,依序):**

1. `scripts/fetch-proot.sh` 取 proot arm64 → 確認 jniLibs 佈局與 NOTICE;
2. 裝置接上 → `adb install` debug APK → 驗證冷啟資產展開 / rootfs+Node 安裝 / host 起 WS / WebView 主流程(此即 M-A0 殘餘確認項的實機版);
3. M-B4 FGS→SandboxManager 實接(目前 EngineService 的 ensureEngineRunning/stopEngine 為 TODO 骨架);
4. 依實機結果回填本節並更新 §9 里程碑表。

### M-B1 sandbox 子系統(1.5–2 週,最大件)

| 元件 | 規格 | 估行數 |
|---|---|---|
| proot 執行器 | `ProcessBuilder` 組裝:`libproot_exec.so --root-id --sysvipc --link2symlink --kill-on-exit --kernel-release=<假 6.x> -r <rootfs> -w /workspace -b <files>:/workspace -b <skills>:/skills -b <upload>:/upload -b /dev -b /dev/urandom:/dev/random -b <proc_fakes>:/proc/stat -b <proc_fakes>:/proc/loadavg -b <empty>:/sys/fs/selinux -b /dev/shm:/tmp/shm -b /proc -b /sys /usr/bin/env -i HOME=/root PATH=… TERM=xterm-256color LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=true NO_COLOR=1 PAGER=cat NODE_OPTIONS=--require <bionic-bypass.js> /bin/bash -l -c …`;env 注入 `PROOT_LOADER` / `PROOT_TMP_DIR` / `TMPDIR`(參數依據:§3.0 補充 9 設計輸入) | ~250 |
| rootfs 安裝器 | 下載 Ubuntu base 24.04 arm64 tarball(進度 / 可取消 / 鹽續);**自寫 tar 解壓器**(PAX/GNU long-name 支援、**symlink 逃逸拒絕**、hardlink fallback copy、mode/mtime 套用);staging 目錄 → `rename` 原子切換 | ~500 |
| rootfs 修補 | `resolv.conf` ← Android 當前生效 DNS(fallback 1.1.1.1 / 8.8.8.8 / 223.5.5.5)、`/etc/hosts`、`/etc/hostname`、locale、groups、`apt-get install git`(引擎 run-state 需要 git) | ~150 |
| Node 分發 | Node 22 linux-arm64 官方 tarball 首啟下載(與 rootfs 同管道),裝入 rootfs `/usr/local`;引擎 bundle(sdk dist + host-core dist + bundled-agents + vendored ripgrep linux-arm64 + tree-sitter wasm)隨 APK assets 展開進 rootfs | ~150 |

- proot 二進位取得:從 Termux package 源取得或自行編譯 proot-me/proot(GPL-2.0+)→ 以 `libproot_exec.so` / `libproot_loader.so` 名義進 jniLibs;**NOTICE 檔補 GPL-2.0+ 聲明與原始碼連結(§7 R2)**。
- **W^X 確認(2026-09-03 依外部查證修訂,見 §3.0 補充 9)**:oonid/pr 實機測試證明 `untrusted_app` 於 **targetSdk 29+ 直接 execve filesDir 內 rootfs ELF 會被 SELinux 阻擋**(`execve: Permission denied`)——「RikkaHub 同款用法已量產證明」實際上係靠其 targetSdk 版位或 loader 機制。**主機制改為 PROOT_LOADER**:loader 以 `libproot-loader.so` 名義進 nativeLibraryDir(SELinux 允許 exec),由其載入 guest ELF——oonid/pr 已於 targetSdk 35 驗證全工具鏈可用。本專案 targetSdk 36 高於已驗證版位,M-B1 實機首運仍需確認;**fallback 方案不變**:node / ripgrep 等 ELF 一律進 jniLibs、rootfs 僅放腳本與資料。另注意:Samsung Knox 部分韌體將 filesDir 掛 `noexec`;Yama `ptrace_scope` 需 ≤1(Samsung 預設 1,可用)。oonid/pr 的 18 個 SIGSYS handler 表(chmod/chdir/clone3/openat 等)為屆時排查參考。
- 輸出上限:每流 128KB(持續 drain 防 pipe 死鎖)、timeout 預設 30s——規格對齊既有 `run-terminal-command.ts` 語意,由引擎側既有機制處理,宿主不重複造。

### M-B2 Keystore 與握手(0.5 週)

- `KeyGenParameterSpec`:AES/GCM/NoPadding 256、`AndroidKeyStore` provider、TEE/StrongBox 優先;密文 + IV 存 DataStore;
- 設定流程:SettingsModal 存 key → `addWebMessageListener` bridge → Kotlin Keystore 加密落盤;host 啟動時 Kotlin 解密 → 一次性握手注入 host-core 記憶體 `SecretStore`(§2.2)。

### M-B3 WebView 整合(0.5–1 週)

- `WebViewAssetLoader`(`https://appassets.androidplatform.net`)+ `WebViewCompat.addWebMessageListener` origin allowlist 精確填該 origin(loopback `ws://127.0.0.1` 在 Chromium/WebView 屬 potentially-trustworthy origin,非 mixed content,頁面開 WS 合法);
- host WS 位址 + session token 經 `addDocumentStartJavaScript` 注入全域常數;
- `setDomStorageEnabled(true)`(renderer 的主題偏好 localStorage 跨更新自動持久);`setAllowFileAccess(false)`、`setAllowContentAccess(false)`;service worker 不註冊(Vite build 不含 PWA);
- `onRenderProcessGone` → 重建 WebView;記錄 `getCurrentWebViewPackage()` 供診斷。

### M-B4 前景服務與生命週期(0.5 週)

- FGS 型別 **`specialUse`** + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE">` 說明文案(本機 AI agent 長時間執行,使用者發起);**不得用 `dataSync`(Android 15 起 6hr/24h 累計上限,超時不 stopSelf 直接崩)**;
- Activity 可見時 `FLAG_KEEP_SCREEN_ON`;背景時 FGS 通知(進度 + 停止鈕);App 銷毀 → proot tree kill;
- Doze 網路中斷 → 依賴引擎既有 L1 重試 + L3 快照 resume,宿主不額外造重試。

### M-B5 SAF picker 與 /upload(0.5 週)

- `selectFiles` / `selectFolder` → SAF → 複製進 `<filesDir>/upload/<workspace>` → 回傳 sandbox 內路徑;`getPathForFile`(桌面 drag&drop 專用)→ no-op。

**Phase B 驗收(實機):**

1. 冷啟:rootfs + Node + 引擎安裝全程進度正確、可中斷重試;
2. 主流程:UI 聊天送出任務 → 引擎於 sandbox 跑通 M-A0 同款冒煙任務 → 工具卡 / 核准橫幅 / file-changes 完整顯示;
3. 核准對照:terminal 指令逐一核准 vs `approvalMode: 'allow-all'` 兩路皆通;
4. 金鑰:程式碼審查確認 key 僅存在 host 記憶體(不經 WebView、不落盤、不進 env);
5. 背景:螢幕關閉 30 分鐘,run 存活(FGS)且斷網恢復後可續跑。

---

## 5. Phase C:觸控適配與出包(1–2 週)

### M-C1 觸控 pass(1 週,React/CSS 層,不得 fork 第二套 renderer)

2026-09 勘察盤點之待辦:

- 4 處 `onContextMenu`(`Sidebar.tsx` 專案 / 任務列)→ 長按(long-press)或「⋯」按鈕選單;
- Composer 右鍵選單(undo/redo/cut/copy/paste)→ 移除,交由系統文字選單;
- hover 才浮現的控制項(訊息 footer 複製 / 還原 mini-btn、工具卡展開)→ 觸控下常駐或 tap 切換;
- 既有 `@media (max-width: 500px)` 斷點擴充:composer 單列、Sidebar 抽屜化、SettingsModal 全螢幕化;
- `@media (pointer: coarse)` 分支統一承載上述差異(styles.css 內,元件僅補 platform class);
- CJK IME:驗證 WebView composition 事件(桌面既有防誤觸規則照搬);
- 軟鍵盤:`adjustResize` 行為、Enter 送出 vs 換行確認;
- 最小觸控目標 44px 檢查。

### M-C2 出包管線(0.5 週)

- GitHub Actions:renderer web build(`base:'./'`)→ `bun run build:sdk` + host-core dist → 打包進 APK assets → Gradle build(arm64)→ 簽章(keystore 私管)→ Release 附 APK + checksums;
- 版號:維持 `desktop/package.json` 為唯一事實來源(ADR-14),CI 同步推導 `android/versionCode`(如 1.0.0 → 10000 + patch)。

### M-C3 電池與穩定性(0.5 週)

- 熱節流偵測 → 降併發(base2 spawn 數經 run-option 上限);
- 崩潰:本機 ring buffer 日誌 + 匯出按鈕(S7 遙測 no-op 原則不變,**不引入雲端 crash 上報**);
- 低記憶體:6GB 下限聲明;記憶體壓力時 host 拒絕新 run。

**驗收**:GitHub Release 可側載安裝;主流程(聊天 → 編輯檔案 → 核准 → diff → 歷史)全通。

---

## 6. Phase D:硬化與發佈(持續)

- **裝置矩陣**:Snapdragon 8 級 / 中階 6GB / 模擬器 x86_64;CI 至少一台實機冒煙;
- **Play 上架評估**(側載 beta 後決定,不阻塞本計畫):RikkaHub 為已過審先例;需備妥 FGS 聲明、資料安全表單、執行期下載內容(rootfs/Node)之政策說明;
- **效能預算**:rootfs+Node 安裝 ≤ 5 分鐘(100Mbps);run 啟動 ≤ 10s;閒置 host RSS ≤ 350MB;單 run 峰值 ≤ 900MB(8GB 裝置);
- **文件**:README 新增 Android 段落並連結本計畫。

---

## 7. 風險登記冊

| # | 風險 | 等級 | 緩解 |
|---|---|---|---|
| R1 | **授權汙染**:RikkaHub 為 AGPL-3.0,抄任何程式碼會傳染整包 | 後果高 / 概率低 | 只借設計;rootfs 安裝器等一律自寫;code review 以「無參照其原始碼」為驗收項 |
| R2 | proot(GPL-2.0+)二進位隨包散布義務 | 中 | NOTICE 檔補條款 + 原始碼取得連結(Termux 源 / proot-me);AnyBuff 主體 Apache-2.0 不受影響(獨立程序散布) |
| R3 | loopback 埠全裝置可達(其他 App 可連) | 中 | Origin allowlist + per-session token + 動態埠 + 拒絕無 token 連線(§2.3) |
| R4 | Android exec 政策變動(rootfs 內 ELF) | 低 | RikkaHub 量產先例;fallback:ELF 全進 jniLibs、rootfs 僅資料 |
| R5 | WebView 供應商碎片化 | 中 | `WebViewFeature.isFeatureSupported` 檢查;`onRenderProcessGone` 復原;記錄 WebView 版本 |
| R6 | 中階機記憶體不足 | 中 | spawn 併發上限、效能預算把關、6GB 下限聲明 |
| R7 | FGS 政策(dataSync 6hr 上限 / Play 審查) | 低 | 一律 `specialUse`;Play 聲明文案先備妥 |
| R8 | 引擎升級(upstream merge / generator 重跑)後 Android bundle 漂移 | 中 | host-core 為唯一 host;CI 於 `generate-desktop-agents` 產物變更時自動重打包 Android bundle |
| R9 | 雙 host 漂移(M-A4 延後期間) | 中 | M-A4 前凍結 start-run / session-store 結構性大改;契約測試兩端共用 |
| R10 | proot syscall 攔截開銷 | 低 | 工作負載瓶頸在等待 LLM;npm install 類操作可接受;必要時 agent 改用靜態工具 |

---

## 8. ADR-21 草稿(併入指南 §4 用)

> 本節為正式 ADR 文字,實作啟動時原樣併入《AnyBuff 專案全貌與維護者指南》§4,並同步修訂指南 §1 定位聲明。

### ADR-21:Android 版版採「雙薄殼 + 三層共享」架構(擴大 ADR-2 交付範圍)

- **決策**:
  1. 交付範圍由「Windows 桌面 App」擴大為「Windows 桌面 + Android(arm64)」;ADR-2 的「不搞 CLI」維持不變。
  2. 架構:renderer / host 邏輯 / 引擎三層全共享;新增 `packages/host-core`(`@codebuff/host-core`,遵守 ADR-1)承載自 `desktop/src/main` 抽出之業務邏輯;Windows 殼(Electron)不遷移;Android 殼為 Kotlin 薄層(proot sandbox + Keystore + WebView + specialUse FGS),為唯一新增原生面。
  3. 金鑰對應(ADR-11 修訂):DPAPI(safeStorage)→ Android Keystore AES/GCM 256;注入通道不變(`apiKeyOverrides`),金鑰絕不進 process.env、不落 sandbox 磁碟、不經 WebView(ADR-12 原樣成立)。
  4. **Tauri 2 遷移永久否決**(2026-09-03 維護者裁定,性質同備註 D「不得回引清單」,未來不重新評估);Flutter / React Native / Capacitor 同為否決(理由見《AnyBuff Android 版實作計畫》§1.2)。
  5. 授權紀律:RikkaHub(AGPL-3.0)僅借設計、不借任何程式碼;proot 二進位(GPL-2.0+)以 NOTICE 聲明 + 原始碼連結隨包散布。
- **理由**:Android 的硬底層(Android 10+ W^X 規則下的 proot+Node 執行、Keystore、FGS)在所有跨平台框架下皆為自寫原生碼,框架無統一效益;UI 層已由 React + WebView 達成 write-once;Electron→Tauri 遷移會中斷 electron-updater 裝機連續性且無官方搬運路徑。
- **後果**:新增 `packages/host-core` 與 `android/` 兩個頂層區域;56 個 IPC channel 取得第二宿主實作(契約單一事實來源);desktop main 逐步轉薄(M-A4,風險隔離下可滑動)。

---

## 9. 里程碑與工時彙總

| 里程碑 | 內容 | 估時 | 狀態 |
|---|---|---|---|
| M-A0 | Termux 引擎冒煙 | 1 天 | 🟡 核心假設外部已證(§3.0 補充 9);殘餘 AnyBuff 特定項可併入 M-B1 首運 |
| M-A1 | host-core 抽取 | 1–1.5 週 | ✅ 完成(2026-09-03) |
| M-A2 | WS server + 契約 schema | 0.5–1 週 | ✅ 完成(2026-09-03) |
| M-A3 | renderer shim + web build | 0.5 週 | ✅ 完成(2026-09-03;web build 落地 + native bridge/更新檢查,見 §4.0) |
| M-A4 | desktop 接 host-core(可滑動) | 0.5–1 週 | ✅ 完成(2026-09-03,較計畫提前) |
| M-B0 | Android 骨架 + NSC + WebView | 0.5 週 | ✅ 完成(2026-09-03;assembleDebug 綠、資產同步入 APK,見 §4.0) |
| M-B1 | sandbox 子系統 | 1.5–2 週 | ✅ 引擎鏈路實機跑通(2026-09-04 五輪修復後;rootfs→Node→proot→host→WS→renderer 全通,見 §4.0);UI 打磨進入 round-6 |
| M-B2 | Keystore 握手 | 0.5 週 | 🟡 KeyVault + bridge 完成(編譯綠 + 實機可存);握手注入為暫緩事項(見 §4.0 code-review 暫緩) |
| M-B3 | WebView 整合 | 0.5–1 週 | ✅ AssetLoader + bridge + 注入實機跑通(第五輪 renderer 已走真 WS 模式) |
| M-B4 | FGS + 生命週期 | 0.5 週 | 🟡 EngineService(specialUse)實接 SandboxManager;生命週期 edge(旋轉/背景/殺進程)待實機打磨 |
| M-B5 | SAF picker + /upload | 0.5 週 | 🟡 SAF folder/files 實機可用(路徑改 guest `/workspace`/`/upload`);附件完整流(拷貝→guest 讀取→attach)待 round-6 驗證 |
| M-C1 | 觸控 pass | 1 週 | ✅ 核心適配完成(2026-09-04 晚;直立手機 UI 全面重構:雙抽屜側欄+遮罩、單行精簡工具列、Settings 頂部下拉選單、單欄卡片、English UI、按鈕與觸控優化) |
| M-C2 | CI 出包 | 0.5 週 | B*, C1(部分) |
| M-C3 | 電池穩定性 | 0.5 週 | B4 |
| M-D* | 裝置矩陣 / Play 評估 | 持續 | C |

---

## 10. 維護注意

1. **ADR-1**:host-core 命名維持 `@codebuff/*` 命名空間;不動引擎、不 bulk-rename、PowerShell `-replace` 禁令照舊適用。
2. **上游 merge**:`sync upstream` + `bun scripts/generate-desktop-agents.ts` 後,Android bundle 由 CI 自動跟隨(host-core 消費同一 bundled-agents 產物,無第二套 Agent 定義)。
3. **契約凍結規則**:新增 IPC channel 時三處必須同步——host-core dispatcher、Electron preload、WS schema——缺一即契約測試轉紅。
4. **指南同步**:✅ 已於 2026-09-03 完成——ADR-21 併入指南 §4、§1 定位聲明 / ADR-2 / §3 架構圖 / §6 建置迴圈同步修訂(並同步 AGENTS.md 與 README.md/README.zh-TW.md);首個側載 beta → 指南 §7 roadmap 增補 Android 段。
5. **不再評估事項**:Tauri(永久)、Flutter / React Native(在「React UI 保存」前提下永久);如未來要推翻,必須先立新 ADR 並經維護者審核(比照備註 D 程序)。
