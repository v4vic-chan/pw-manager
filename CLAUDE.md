# CLAUDE.md — 本地密碼儲存器專案治理規則

## 專案定位
本地執行的密碼管理 Web App。規格文件為 `specs/password_manager_spec.md`，
所有實作決策以該規格為準，衝突時規格優先，不得自行變更規格範圍。

## 技術棧（規格 §2.1，已定案，不可更動）
React + TypeScript + Vite + Vitest + IndexedDB（`idb`）+ libsodium.js（Argon2id）
+ Web Crypto API（AES-256-GCM）+ `otplib`（TOTP）+ `qrcode`。

## 必要指令（package.json 尚未建立，以下為命名規範，scaffold 時必須依此建立對應 scripts）
- `npm run dev` — 啟動本地開發伺服器
- `npm run build` — 建置正式版本
- `npm test` — 執行全部測試（單元測試 + 跨層邊界測試）
- `npm run test:unit` — 僅執行 `tests/unit/`
- `npm run test:boundary` — 僅執行 `tests/boundary/`
- `npx tsc --noEmit` — 型態檢查（已由 PostToolUse hook 自動觸發，不需手動執行）

## 目錄結構規範
- `specs/` — 規格文件，含 `_template.md` 骨架模板
- `src/types/` — 型態定義檔（`entry.ts`、`category.ts`、`securityconfig.ts`）
- `src/services/` — Service Layer（業務邏輯，與 UI 解耦）
- `src/crypto/` — Crypto Layer（金鑰衍生、加解密，禁止被 UI 層直接呼叫）
- `src/storage/` — Storage Layer（IndexedDB 讀寫）
- `tests/unit/` — 單元測試
- `tests/boundary/` — 跨層邊界測試
- `.claude/commands/` — 可複用 slash command
- `.claude/settings.json` — hooks 設定

## 硬性規則（不可違反）
- 明文密碼與 TOTP 秘鑰**禁止**以任何形式落地到 Storage Layer，一律先經 Crypto Layer 加密（規格 §2.3）。
- UI 層與 Storage Layer**禁止**直接呼叫，必須經過 Service Layer 與 Crypto Layer 中轉。
- 加密一律使用 AES-256-GCM，**禁止**使用 CBC 模式（規格 §5.1.2）。
- 金鑰衍生一律使用 libsodium.js 的 Argon2id，**禁止**改用 PBKDF2 或降低 §5.1.1 參數門檻。
- 新增或修改功能前，先確認 `specs/` 下對應章節是否已涵蓋；規格未涵蓋的行為不得擅自新增。

## 測試與驗收原則
- 單元測試（`tests/unit/`）：Test-Driven，先紅後綠，**不得**使用 `test.skip` 迴避因缺少實作而導致的失敗。
- 跨層邊界測試（`tests/boundary/`）：僅在依賴層未實作時使用 `test.skip` 並註明解除條件，其餘一律要求可執行且通過。
- 每次修改後必須確保：新增功能的測試通過、且既有測試（regression）未被破壞。
- 型態檢查失敗、或不應 skip 的測試失敗，皆視為未完成，不得視為「大致完成」交付。

## 禁止事項
- 禁止在測試檔內一併撰寫功能模組的實際實作（測試與實作分離）。
- 禁止引入規格 §1.2「非目標」明確排除的功能（跨裝置同步、瀏覽器自動填表、多用戶、雲端備份）。
- 禁止繞過 PostToolUse hook 手動停用型態檢查。

## Git 與 Context 治理
- 每完成一個模組並通過對應 Gate（型態檢查 + 測試）後，執行一次原子化 commit。
- 完成一個獨立任務後執行 `/clear`，避免 context 累積影響後續任務精準度。
