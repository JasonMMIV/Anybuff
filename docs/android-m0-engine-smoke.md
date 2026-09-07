# M-A0 — Termux 引擎冒煙查檢清單（實機執行）

> 來源：`AnyBuff Android 版實作計畫.md` §1.3 / M-A0（1 天里程碑）。
> 本清單需在 **Android 實機 + Termux** 上由操作者執行——引擎於 proot sandbox 的
> Node ≥22 跑通 AnyBuff SDK，驗證「雙薄殼 + 三層共享」架構的引擎層在 Android
> 可執行。RikkaHub sandbox 從未跑過 Node 引擎，此項是 Android 端風險的第一道證明。
>
> **狀態更新（2026-09-03，見計畫 §3.0 補充 9）**：本清單的**核心假設**
> 「Node ≥22 arm64 可於 Android proot sandbox 內啟動」已獲第三方量產先例背書
> （OpenClawd-Termux 於 App 內嵌 proot Ubuntu 跑 Node 22；oonid/pr 於 targetSdk 35
> 實機驗證全工具鏈；code-server 官方支持 UserLAnd/proot 路線）——故本清單已自
> 「Phase B 前置阻斷」**降級**為「AnyBuff 特定回歸確認」，可併入 M-B1 首次實機
> 運行一併驗證（同一套步驟與通過標準），或隨時以 Termux 快速執行。
> 殘餘無外部證據退休的項目：本 repo dist 於 Node 22 arm64 proot 內 import、
> vendored ripgrep 於 proot ptrace 下 spawn、一輪 base2 真實任務的 arm64 RSS、
> workaround 集（bionic-bypass / env 衛生 / `--sysvipc`）實測。

## 前置（Phase A 已完成的部分）

- [ ] `packages/host-core` 已建立且 `bun run build:host-core` 產出 dist
      （Electron-free，Android proot Node 可直接 import）。
- [ ] host-core 契約測試通過：`bun run test:host-core`（29 tests）。
- [ ] host-core headless 冒煙通過：`bun run smoke:host-core`（WS + dispatcher）。
- [ ] generator 輸出已指向 `packages/host-core/src/agents/bundled-agents.ts`。

## 執行步驟（Termux）

```bash
# 1. 安裝 Termux（F-Droid 版）→ 允許儲存權限
# 2. 安裝 proot-distro 並佈署 Ubuntu rootfs
pkg install proot-distro
proot-distro install ubuntu

# 3. 進入 Ubuntu rootfs
proot-distro login ubuntu

# 4. 安裝 Node 22（arm64 官方 tarball；rootfs 內 apt node 過舊）
apt update && apt install -y curl xz-utils git
curl -fsSL https://nodejs.org/dist/v22.x/node-v22.x-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1
node --version   # 需 ≥ 22

# 5. 取得本 repo（在 Android 共用儲存 clone，或從 PC 推送）
#    注意：proot 內執行 git clone 需先 chmod 儲存目錄
cd /sdcard 或 $HOME
git clone https://github.com/<owner>/AnyBuff.git
cd AnyBuff

# 6. 安裝依賴 + 建置 SDK 與 host-core
npm i -g bun   # 或下載 bun linux-arm64 binary
bun install
bun run build:sdk
bun run build:host-core

# 7. 設定 provider key（相容 provider：OpenAI-compatible endpoint）
export ANYBUFF_PROVIDER_CONFIG=/tmp/anybuff.json
# 手動寫入 anybuff.json（provider baseURL 需 Android 可達，勿用 localhost 指 PC）

# 8. 跑 SDK 冒煙（一輪真實 base2 任務）
bun scripts/smoke-sdk.ts

# 9. 跑 host-core headless 冒煙（WS server + dispatcher round-trip）
bun packages/host-core/scripts/smoke-host-core.ts
```

## 驗證點

| # | 檢查 | 通過標準 |
|---|------|---------|
| 1 | Node 版本 | `node --version` ≥ 22（arm64） |
| 2 | bun 於 proot 內執行 | `bun --version` 正常輸出 |
| 3 | vendored ripgrep（linux-arm64）| smoke-sdk 的 code_search 工具不報 spawn 錯誤 |
| 4 | tree-sitter WASM 載入 | code-map 初始化不報 WASM 路徑錯誤 |
| 5 | 一輪 base2 真實任務 | `smoke-sdk.ts` 跑完並輸出預期檔案變更 |
| 6 | 記憶體足跡 | 任務過程 RSS 無失控增長（`top` 觀察） |
| 7 | host-core WS host | `smoke-host-core.ts` 輸出 `HOST-CORE SMOKE OK` |
| 8 | 金鑰不落地 | smoke 過程無明文 key 寫入磁碟（ADR-12 遵守） |

## 常見失敗與排除

- **`EACCES` on /sdcard**：Termux → `termux-setup-storage`；proot 內對
  `/sdcard` 需先 `chmod 755 /sdcard` 或 clone 到 `$HOME`。
- **bun 無法執行**：確認下載的是 `bun-linux-arm64` 且 `chmod +x`。
- **Node 過舊**：apt 的 node 是 18，務必用官方 arm64 tarball。
- **ripgrep 架構不符**：SDK vendor 需含 linux-arm64 二進位（Phase B 打包時
  extra 進 sandbox）；M-A0 階段若缺，先以系統 `apt install ripgrep` 驗證其餘。

## 通過後 → 進入 Phase B

M-A0 證明引擎層可在 Android Node 執行後，Phase B 才開始建 Kotlin 殼
（proot sandbox + Keystore + WebView + FGS）。此查檢清單結果應記錄於
`AnyBuff 專案全貌與維護者指南.md` §5 維護帳本。
