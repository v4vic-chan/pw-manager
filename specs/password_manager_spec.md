# 本地密碼儲存器 — 中粒度系統規格 v1.6

<!-- v1.6 變更摘要：
本次僅修訂一項：登入頁匯入流程新增確認字串步驟（§5.3），須完全相符輸入固定字串 "OVERWRITE" 才可進入檔案選擇，
補回登入前破壞性覆蓋操作的操作摩擦；並新增對應驗收標準 §6 第 16 項。其餘章節與 v1.5 相同。
-->

<!-- v1.5 變更摘要（依 v1.4 第三輪複查共識修訂）：
1. KDF 套件明定為 libsodium-wrappers-sumo（標準版不含 crypto_pwhash）。
2. 移除 verifier 機制（masterPasswordVerifierHash、HKDF verifier 分支、deriveBits），改用 canaryPayload 驗證主密碼，解密後須比對固定明文常數。
3. 重新金鑰化拆為共用程序（§4.1.1），變更主密碼（§4.1.2）與參數升級（§4.1.3）僅提供輸入；寫入清單補上 kdfParams、canaryPayload；每次強制重新產生 salt。
4. cryptoVersion 僅於 KDF 參數或加密方案改變時遞增，變更主密碼不遞增。
5. 新增 keyGeneration 寫入時金鑰世代檢查（§5.1.5），防止多分頁或匯入後以舊金鑰寫入造成無聲資料遺失。
6. 重新金鑰化期間以 Service Layer 旗標鎖定寫入 API，並暫停閒置計時。
7. 救援碼補發：舊碼於新碼寫入交易提交前仍有效，失效與寫入於同一交易內發生。
8. 排序用詞改為 UTF-16 code unit；字串欄位寫入時 NFC 正規化；重名檢查使用 toLowerCase()；時間戳統一 toISOString() UTC Z 格式。
9. 匯入流程改為解密即驗證，匯入後重置失敗計數、遞增 keyGeneration 並強制重新登入。
10. 補回 v1.4 以「與 v1.3 相同」省略的 §2.2、§4.4、§5.2 全文（內容未變更）。
11. 檔名由 password_manager_spec_v1.md 更名為 password_manager_spec.md。
-->

## 0. 文件定位
本文件為「中粒度契約規格」：定義模組邊界、資料契約、安全約束、驗收標準。
**不包含**演算法內部實作細節，這些由實作端依本文件訂下的參數與函式庫選型自行完成。

## 1. 專案範圍與非目標

### 1.1 範圍
- 純本地執行的 Web App（瀏覽器開啟，無雲端同步、無伺服器上傳）。
- 單機單用戶，資料儲存於本地瀏覽器 IndexedDB。
- 核心功能：密碼條目管理（CRUD）、分類管理、主密碼保護、可選 2FA、搜尋/排序/篩選。

### 1.2 非目標（Out of Scope）
- 不做跨裝置同步。
- 不做瀏覽器擴充套件自動填表（本版僅手動複製）。
- 不做多用戶/多帳號體系。
- 不做雲端備份（本地匯出/匯入不在此限，見 §5.3）。
- 不做刪除復原機制／回收桶，所有刪除皆為硬刪除。
- **不處理多分頁同時開啟本應用的併發情境**：假設使用者同一時間僅開啟單一分頁存取本應用；
  若使用者自行開啟多分頁併發寫入，資料一致性不予保證，此為已知使用限制，非待解決的工程問題。
  寫入時的金鑰世代檢查（§5.1.5）屬於資料完整性防護，不屬於併發處理；它僅在偵測到金鑰世代不符時中止寫入，不提供跨分頁同步、鎖定或更新衝突處理。

## 2. 系統架構總覽

### 2.1 技術棧選型
| 層級 | 選型 | 選型理由 |
|---|---|---|
| 前端框架 | React + TypeScript | 型態系統完整 |
| 建置工具 | Vite | 開發體驗快速 |
| 本地儲存 | IndexedDB（透過 `idb` 封裝） | 原生瀏覽器方案，支援單一交易內批次寫入 |
| 金鑰衍生（KDF） | `libsodium-wrappers-sumo`（`crypto_pwhash`，Argon2id） | 瀏覽器 SubtleCrypto 不原生支援 Argon2id。**必須使用 sumo 版**：標準版 `libsodium-wrappers` 執行期不含 `crypto_pwhash`（呼叫時拋出 `is not a function`），但其內附型別宣告仍宣告了該函式，型別檢查無法攔截此錯誤。sumo 版自帶型別宣告，不需額外安裝 `@types` 套件 |
| 金鑰分離 | Web Crypto API 原生 HKDF（`SubtleCrypto.deriveKey`，hash: SHA-256） | 直接產出 non-extractable 的 AES-GCM CryptoKey；不使用 libsodium 的 `crypto_kdf_derive_from_key`（其 context 參數限制為精確 8 bytes） |
| 資料加解密 | Web Crypto API（SubtleCrypto，AES-256-GCM） | 瀏覽器原生實作 |
| 2FA（TOTP） | `otplib` | RFC 6238 相容函式庫 |
| QR Code 產生 | `qrcode` | 用於 2FA 綁定流程 |

### 2.2 分層架構
- **UI 層**：條目列表、分類管理、搜尋/篩選/排序控制、新增/編輯表單、主密碼登入頁、2FA 設定頁（React 元件）。
- **應用邏輯層（Service Layer）**：條目 CRUD 邏輯、分類邏輯、搜尋/篩選/排序邏輯、主密碼驗證流程、2FA 驗證流程、重新金鑰化流程與寫入鎖定旗標（純 TypeScript，與 React 元件解耦）。
- **加密層（Crypto Layer）**：金鑰衍生與分離（libsodium-wrappers-sumo + Web Crypto HKDF）、資料加解密（SubtleCrypto）、canary 驗證、2FA 秘鑰與救援碼保護。此層必須與 UI 層完全解耦，不得被 UI 層繞過直接存取原始資料。
- **儲存層（Storage Layer）**：加密後資料的 IndexedDB 讀寫（透過 `idb` 封裝）。

### 2.3 資料流向硬性約束
- 明文密碼欄位**永遠不得**以明文形式落地到 IndexedDB。所有寫入儲存層前必須經過加密層。
- 解密後的明文只能存活於記憶體中的臨時狀態，須設定自動清除機制（見 §5.1.4）。
- UI 層與儲存層之間**禁止**直接呼叫，一律經過應用邏輯層與加密層中轉。
- Argon2id 原始衍生輸出（rawKey）**永遠不得**直接落地儲存、不得直接作為加密金鑰，必須先經 §5.1.1 的 HKDF 衍生出 encryptionKey；主密碼驗證僅能透過 encryptionKey 解密 canaryPayload 完成（見 §4.1），rawKey 本身不得參與任何比對。

## 3. 資料契約（Data Contracts）

通用約束：
- 所有 ISO8601 timestamp 欄位一律以 `Date.prototype.toISOString()` 產生（UTC、`Z` 結尾、毫秒精度，例如 `2026-09-15T08:30:00.000Z`），不得使用其他時區偏移表示法。
- 所有由使用者輸入的字串欄位（Entry.appName、Entry.accountId、Category.name）於寫入前一律以 `String.prototype.normalize("NFC")` 正規化；長度限制以正規化後的 UTF-16 code unit 計數。

### 3.1 EncryptedPayload
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| ciphertext | string（Base64） | 是 | AES-256-GCM 加密輸出（含認證標籤） |
| iv | string（Base64） | 是 | 12 bytes 隨機亂數，每次加密重新產生 |
| cryptoVersion | number | 是 | 對應此密文使用的 KDF 與加密參數版本 |

### 3.2 ExportFile（匯出檔案格式）
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| formatVersion | number | 是 | 匯出檔案格式版本，與 cryptoVersion 分開追蹤 |
| header | object（明文，不加密） | 是 | 含 `cryptoVersion`、`masterPasswordSalt`、`kdfParams`——這些是衍生解密金鑰所需的參數，依密碼學原則本身不需保密，故不加密 |
| encryptedBody | EncryptedPayload | 是 | 加密後的完整資料本體：所有 StoredEntryRecord、Category，以及 SecurityConfig 中除 header 已列出欄位、`loginFailureState`、`totpFailureState` 以外的其餘內容（含 canaryPayload、keyGeneration） |

### 3.3 Entry（記憶體中的解密形態）
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| id | UUID string | 是 | 系統自動產生，全域唯一 |
| appName | string | 是 | NFC 正規化後長度 1–100 |
| categoryId | string（參照 Category.id） | 是 | 必須存在於系統分類清單中（含「未分類」） |
| accountId | string | 是 | NFC 正規化後長度 1–200（對應功能規格中的「ID」欄位，如帳號/信箱） |
| password | string（明文，僅存於記憶體） | 是 | 長度 ≥ 1；長度 < 8 時 UI 顯示強度警示，不阻擋儲存 |
| createdAt | ISO8601 timestamp（UTC Z） | 是 | 系統自動產生 |
| updatedAt | ISO8601 timestamp（UTC Z） | 是 | 僅使用者四欄位（appName/categoryId/accountId/password）變更時更新；系統自動觸發的分類轉移（見 §3.5 約束）**不視為使用者編輯，不更新此欄位** |

### 3.4 StoredEntryRecord
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| id / appName / categoryId / accountId / createdAt / updatedAt | 同 Entry | 是 | 明文儲存 |
| password | EncryptedPayload | 是 | 見 §3.1 |

### 3.5 Category（分類）
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| id | UUID string | 是 | 系統預設「未分類」固定使用 nil UUID：`00000000-0000-0000-0000-000000000000` |
| name | string | 是 | NFC 正規化後長度 1–50；重名判斷規則見下方約束 |
| sortIndex | number | 是 | 「未分類」固定 sortIndex = -1（恆居首位，不可拖曳調整）；其餘分類 sortIndex ≥ 0 |
| isSystemDefault | boolean | 是 | 僅「未分類」為 true |
| createdAt | ISO8601 timestamp（UTC Z） | 是 | 系統自動產生 |

約束：
- 系統初始化須自動建立「未分類」（id 為上述 nil UUID），不可刪除、不可重新命名、不可調整排序。
- 重名判斷（新增與重新命名皆適用，含與「未分類」比較）：兩名稱各自依序經 `normalize("NFC")` → `trim()` → `toLowerCase()` 處理後相等即視為重複；**不得**使用 `toLocaleLowerCase()`（避免結果隨系統語系變動）。
- 刪除任一使用者分類時，所有參照該分類的 Entry 於**同一 IndexedDB 交易內**自動轉移 categoryId 至「未分類」nil UUID，不更新 updatedAt（見 §3.3）。

### 3.6 SecurityConfig（安全設定，單例）
| 欄位 | 型態 | 必填 | 約束 |
|---|---|---|---|
| masterPasswordSalt | string | 是 | Argon2id 用鹽；**每次重新金鑰化（§4.1.1）一律重新產生** |
| canaryPayload | EncryptedPayload | 是 | 以 encryptionKey 加密固定明文常數 `CANARY_PLAINTEXT` 的密文，僅用於主密碼驗證，見 §4.1 |
| keyGeneration | number | 是 | 金鑰世代計數，首次初始化為 1；每次重新金鑰化與每次匯入完成後遞增，用於 §5.1.5 寫入時檢查 |
| cryptoVersion | number | 是 | KDF 參數與加密方案版本；**僅於 KDF 參數或加密方案改變時遞增**，變更主密碼不遞增 |
| kdfParams | object | 是 | `memoryKiB`、`iterations`、`parallelism` |
| twoFactorEnabled | boolean | 是 | 預設 false |
| twoFactorSecretEncrypted | EncryptedPayload | 否 | 僅 twoFactorEnabled=true 時存在 |
| recoveryCodes | array of { codeHash: string, salt: string, used: boolean } | 否 | 8–10 組；codeHash 為加鹽雜湊（見 §5.1.3），salt 為對應此筆雜湊使用的隨機鹽 |
| recoveryCodesRemainingWarningShown | boolean | 否 | 剩餘碼數 ≤ 2 時是否已提示過使用者，避免重複提示 |
| loginFailureState | object | 是 | `failedAttempts: number`、`lockedUntil: ISO8601（UTC Z） \| null`，持久化儲存 |
| totpFailureState | object | 否 | 結構同上，獨立計數，涵蓋 TOTP 與救援碼輸入失敗（見 §4.2） |

約束：
- `CANARY_PLAINTEXT` 為固定常數：字串 `"password-keeper:canary:v1"` 的 UTF-8 位元組。

## 4. 功能模組規格

### 4.1 主密碼登入模組
- 首次啟動：強制設定主密碼，長度 ≥ 12 字元（以 UTF-16 code unit 計數）。設定完成時產生 masterPasswordSalt、依下述步驟衍生 encryptionKey、以其加密 `CANARY_PLAINTEXT` 產生 canaryPayload，並寫入 keyGeneration = 1 與當前 cryptoVersion。
- 金鑰衍生流程：
  1. `rawKey = crypto_pwhash(32, password, masterPasswordSalt, kdfParams.iterations, kdfParams.memoryKiB × 1024, ALG_ARGON2ID13)`（libsodium-wrappers-sumo，輸出 32 bytes）。
  2. 以 `importKey("raw", rawKey, "HKDF", false, ["deriveKey"])` 將 rawKey 匯入為 HKDF 基礎金鑰（baseKey，不可提取）。
  3. `encryptionKey = deriveKey({ name: "HKDF", hash: "SHA-256", salt: 空位元組, info: UTF-8("entry-encryption-key") }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])`，為 non-extractable 的 AES-GCM CryptoKey，僅存在於記憶體，永不落地、不可被讀出。
- 驗證流程：輸入主密碼 → 依上述步驟衍生 encryptionKey → 以 encryptionKey 解密 SecurityConfig.canaryPayload → **解密成功且解密後明文與 `CANARY_PLAINTEXT` 逐位元組相等**，才判定主密碼正確。
  - 以下任一情況皆判定為驗證失敗，並立即捨棄本次衍生的 encryptionKey：GCM 認證失敗；GCM 認證通過但明文不等於 `CANARY_PLAINTEXT`。
  - 不得僅以 GCM 認證標籤通過作為密碼正確的依據：AES-GCM 不具金鑰承諾（key commitment）性質，可被構造出在多把金鑰下皆通過認證的密文（partitioning oracle attack）；比對固定明文可恢復此性質。
  - 驗證成功後，session 保存 encryptionKey，並記錄當下的 keyGeneration 作為快照（供 §5.1.5 使用）。
- **已知限制**：canaryPayload 損毀與密碼錯誤在 GCM 層面無法區分，兩者皆表現為驗證失敗並計入 loginFailureState。本規格不引入冗餘儲存或多份 canary；UI 於驗證失敗時需提示「若確認密碼無誤，資料可能已損毀，可從備份檔匯入還原（§5.3）」。
- 失敗處理：
  - 第 1–5 次失敗：僅計數，不設等待。
  - 第 6 次起：等待秒數 = `2^(failedAttempts-5)`，上限 60 秒。
  - `loginFailureState` 持久化，重新整理頁面不重置。
  - 驗證成功後歸零。

### 4.1.1 重新金鑰化程序（共用程序）
變更主密碼（§4.1.2）與參數/加密方案升級（§4.1.3）共用本程序，兩者僅負責提供輸入，不各自定義寫入流程。

- 輸入：
  - `password`：用於衍生新金鑰的主密碼（變更主密碼時為新密碼；升級時為本次登入輸入的現行密碼）。
  - `targetKdfParams`：新金鑰使用的 kdfParams（變更主密碼時等於現行值；升級時為新參數）。
  - `targetCryptoVersion`：新金鑰對應的 cryptoVersion（變更主密碼時等於現行值；升級時為程式碼支援的最新版本）。
  - session 目前持有的舊 encryptionKey。
- 前提：使用者已登入，且 Service Layer 寫入鎖定旗標目前未設定。
- 流程：
  1. 設定 Service Layer 寫入鎖定旗標，並暫停閒置計時（§5.1.4）。
  2. **重新產生** masterPasswordSalt（不論變更密碼或升級，一律更換），以 `password` 與 `targetKdfParams` 依 §4.1 衍生新的 encryptionKey。
  3. 於記憶體中：用**舊** encryptionKey 解密全部 StoredEntryRecord.password 與 SecurityConfig.twoFactorSecretEncrypted（若存在），再用**新** encryptionKey 以全新 IV 重新加密；並以新 encryptionKey 加密 `CANARY_PLAINTEXT` 產生新的 canaryPayload。所有 EncryptedPayload.cryptoVersion 設為 `targetCryptoVersion`。
  4. 全部加密運算完成後，開啟**單一 IndexedDB readwrite 交易**（範圍涵蓋 Entry store 與 SecurityConfig store），先執行 §5.1.5 金鑰世代檢查，通過後一次寫入：新的 masterPasswordSalt、kdfParams（= targetKdfParams）、cryptoVersion（= targetCryptoVersion）、canaryPayload、keyGeneration（+1）、全部更新後的 StoredEntryRecord、更新後的 twoFactorSecretEncrypted。此交易具原子性，中途中斷（斷電/關閉分頁）會整筆回滾，不會產生新舊金鑰混雜的資料。
  5. 交易提交成功後：session 改持新 encryptionKey、keyGeneration 快照更新為新值，捨棄舊 encryptionKey，解除寫入鎖定旗標並恢復閒置計時。
- 失敗處理：步驟 2–4 任一步驟失敗（含 §5.1.5 檢查不符），IndexedDB 維持原狀，session 保留舊 encryptionKey（§5.1.5 檢查不符時則依該節強制重新登入），解除鎖定旗標並恢復閒置計時，回報錯誤。步驟 1–3 未觸及 IndexedDB，於此期間中斷不影響任何持久化狀態。
- 寫入鎖定旗標：旗標設定期間，Service Layer 所有寫入 API（Entry 新增/編輯/刪除、分類新增/重新命名/刪除/調整排序、2FA 開啟/關閉/救援碼補發、匯入、再次觸發重新金鑰化）一律立即 reject，回傳錯誤碼 `REKEY_IN_PROGRESS`，不排隊、不落地任何資料。
- 救援碼與 recoveryCodes 不受影響（其雜湊獨立於主密碼衍生鏈，不需重新產生）。

### 4.1.2 變更主密碼
- 前提：使用者須先以現行主密碼完成登入驗證。
- 使用者輸入新主密碼（須符合 §4.1 長度規則）→ 以 `password = 新密碼`、`targetKdfParams = 現行 kdfParams`、`targetCryptoVersion = 現行 cryptoVersion` 執行 §4.1.1。
- 變更主密碼**不遞增** cryptoVersion。

### 4.1.3 KDF 參數／加密方案升級
- 觸發條件：使用者成功登入後，若 SecurityConfig.cryptoVersion 小於程式碼支援的最新版本，於背景自動執行。
- 以 `password = 本次登入輸入的現行主密碼`、`targetKdfParams = 最新版本參數`、`targetCryptoVersion = 最新版本` 執行 §4.1.1。
- 本次登入輸入的主密碼明文僅可保留於記憶體至本程序結束，結束後（不論成功或失敗）立即捨棄參照。
- 不需同時支援多組參數並存。

### 4.2 2FA 模組（可自定開關）
- 開啟流程：
  1. 產生隨機 TOTP 秘鑰，記憶體中暫存，尚未寫入任何儲存層。
  2. 顯示 QR code，使用者輸入一次當前驗證碼確認綁定成功。
  3. 產生 8–10 組救援碼：每組至少 64 bits 隨機熵（例如 16 個十六進位字元，或等效熵值的字元集），一次性明文顯示；比對前正規化為統一大小寫、去除連字號空白。
  4. 使用者確認已保存救援碼後，計算每組救援碼的加鹽雜湊（SHA-256 + 隨機 salt），並將 TOTP 秘鑰加密為 EncryptedPayload。
  5. 於**單一 IndexedDB 交易**內（先執行 §5.1.5 檢查）一次寫入：twoFactorEnabled=true、twoFactorSecretEncrypted、recoveryCodes（含 salt）。若使用者在步驟 4 確認前關閉分頁，本次開啟操作視為未完成，不留下任何部分寫入的狀態。
  6. 步驟 3 產生的救援碼明文，顯示完成後依 §5.1.4 規則清除於記憶體中的參照。
- 登入流程（開啟時）：主密碼驗證通過 → 要求 TOTP 驗證碼**或**未使用救援碼 → 任一通過即可登入；若用救援碼登入，**先**於單一交易內寫入該碼 used=true 並確認寫入成功，**再**放行進入應用主畫面（避免寫入前當機導致同碼可重複使用）。
- 關閉流程：主密碼驗證 + （TOTP 驗證碼或未使用救援碼）雙重驗證通過後，於單一交易內移除 twoFactorSecretEncrypted 與 recoveryCodes。
- 救援碼補發：使用者可在已登入狀態下，經主密碼 + 當前 TOTP 雙重驗證後，觸發「重新產生救援碼」：
  1. 依開啟流程步驟 3、4 產生新一批救援碼並計算雜湊（僅處理救援碼，不重新產生或重寫 TOTP 秘鑰）。
  2. 使用者確認已保存後，於**單一 IndexedDB 交易**內（先執行 §5.1.5 檢查）以新一批 recoveryCodes 整組取代舊一批。
  3. **舊有救援碼（含未使用者）在上述交易提交之前仍保持有效**；舊碼失效與新碼寫入於同一交易內同時發生。若使用者在確認前關閉分頁或交易失敗，舊碼維持原狀、繼續有效，不得出現新舊碼皆無的狀態。
  - 剩餘未使用救援碼 ≤ 2 組時，UI 需提示使用者考慮補發（僅提示，不強制）。
- 失敗計數：TOTP 與救援碼輸入錯誤**皆計入** totpFailureState，防止救援碼成為無限次嘗試的旁路；等待邏輯同 §4.1。
- 已知限制：本專案為純前端 App，速率限制僅能防止透過正常 UI 操作的暴力嘗試，無法防止具備瀏覽器開發工具存取權限的攻擊者直接呼叫底層函式；真正的安全邊界來自 §5.1.1 的 Argon2id 計算成本。

### 4.3 分類管理模組
- 支援新增、重新命名、刪除（「未分類」除外）；名稱正規化與重名判斷依 §3.5。
- 依 sortIndex 排序顯示（「未分類」固定居首），支援拖曳調整使用者分類的 sortIndex 並持久化。
- 新增 Entry 時 categoryId 必選；系統保證至少存在「未分類」。

### 4.4 條目 CRUD 模組
- 新增：appName、categoryId、accountId、password 四個使用者欄位皆為必填，驗證與正規化規則見 §3.3。
- 編輯：僅允許修改上述四個使用者欄位，id 與 createdAt 不可變更；任一使用者欄位變更後更新 updatedAt。
- 刪除：需二次確認，刪除為硬刪除，不提供復原機制（見 §1.2）。
- 密碼顯示：預設遮蔽，提供「顯示/隱藏」切換與「複製到剪貼簿」功能；複製到剪貼簿的內容建議在一定秒數後自動清空（安全性加分項，非強制驗收）。

### 4.5 搜尋、排序、篩選模組
- **搜尋**：以 appName、accountId 模糊比對，即時搜尋。
- **篩選**：依 categoryId 多選篩選，與搜尋疊加（AND）。
- **排序**：支援 appName、Category.name、createdAt、updatedAt 四種排序鍵，正序/倒序切換。
  - 字串比較（appName、Category.name）**一律使用 UTF-16 code unit 逐單元比較**（即 JavaScript 預設的 `<`/`>` 字串比較行為，不使用 `localeCompare` 或 `Intl.Collator`），比較對象為 §3 規定寫入時已 NFC 正規化的值，確保跨瀏覽器、跨作業系統結果完全一致，不受使用者系統語言設定影響。
  - createdAt、updatedAt 因統一為 `toISOString()` UTC Z 格式，其字串 code unit 比較結果等同時間先後比較。
  - 排序鍵數值相同時，一律以 id 字串（同樣以 code unit 比較）作為次要排序依據。
  - **已知取捨**：code unit 排序下，大寫字母一律排在小寫字母之前（例如 `"Zoo"` 排在 `"apple"` 之前），此為換取可重現性的已知結果，非缺陷。

## 5. 非功能需求與品質約束

### 5.1 安全與加密規範

#### 5.1.1 金鑰衍生與分離（KDF）
- Argon2id：`libsodium-wrappers-sumo` 的 `crypto_pwhash`，輸出 32 bytes rawKey。
- 最低參數：memoryKiB ≥ 19456、iterations ≥ 2、parallelism = 1。
- rawKey 匯入 Web Crypto 作為 HKDF 基礎金鑰（KeyUsages 僅 `["deriveKey"]`）後，依 §4.1 衍生出 encryptionKey（non-extractable）；rawKey 不得直接作為加密金鑰或參與驗證比對。
- 版本升級（變更 kdfParams 或加密方案）：依 §4.1.3 走 §4.1.1 共用重新金鑰化程序，不需同時支援多組參數並存。

#### 5.1.2 資料加密
- AES-256-GCM，透過 SubtleCrypto 實作，不採用 CBC。
- 加密金鑰：§5.1.1 的 encryptionKey。
- 每筆加密使用獨立 12 bytes 隨機 IV，不重複使用。

#### 5.1.3 2FA 秘鑰與救援碼保護
- TOTP 秘鑰以 EncryptedPayload 加密。
- 救援碼：每組獨立隨機 salt + SHA-256 加鹽雜湊儲存，不可逆；因碼本身已具備 ≥64 bits 熵值，離線暴力窮舉不可行，故使用快速雜湊（SHA-256）即可，不需 Argon2id 等慢雜湊。

#### 5.1.4 記憶體與生命週期管理
- 使用者登出或閒置逾時（預設 10 分鐘，可於 SecurityConfig 外部的本機設定調整，範圍 5–15 分鐘）後，記憶體中的 encryptionKey 參照與已解密資料（含救援碼明文，若尚未清除）必須被捨棄。
- 「清除」定義為可觀測行為：Service Layer 捨棄對 encryptionKey 與明文資料的所有參照，之後任何解密呼叫一律被拒絕並要求重新驗證主密碼；**不承諾底層記憶體位元被覆寫歸零**（JavaScript 執行環境無法保證此點）。
- 重新金鑰化程序（§4.1.1）執行期間暫停閒置計時，程序結束（成功或失敗）後恢復並重新起算。
- 提供手動登出功能，觸發同樣的清除行為。

#### 5.1.5 寫入時金鑰世代檢查（keyGeneration）
- 目的：防止持有舊 encryptionKey 的 session（例如另一分頁在重新金鑰化或匯入之後仍在運作）以舊金鑰寫入資料，造成該資料永久無法解密且無任何錯誤提示的無聲資料遺失。
- 規則：
  - session 於登入成功時記錄當下 SecurityConfig.keyGeneration 作為快照。
  - Service Layer 除 loginFailureState／totpFailureState 計數更新以外的所有寫入交易，交易範圍一律包含 SecurityConfig store，並於交易開頭讀取當前 keyGeneration 與 session 快照比對：
    - 相同：繼續執行寫入。
    - 不同：中止交易（abort），不落地任何資料，回傳錯誤碼 `KEY_GENERATION_MISMATCH`，並依 §5.1.4 清除 session，強制要求重新登入。
  - 所有加密運算須在開啟 IndexedDB 交易**之前**於記憶體完成；交易內不得 await 任何非 IndexedDB 的非同步操作（IndexedDB 交易在無待處理請求時會自動提交）。
  - 交易範圍包含 SecurityConfig store，確保 IndexedDB 將涉及該 store 的 readwrite 交易依序執行，使檢查與寫入之間不會插入其他分頁的重新金鑰化交易。

### 5.2 效能與相容性要求
- 搜尋/篩選/排序需為即時反應（輸入或切換後感知延遲需極低，不應有明顯卡頓）。
- 需相容支援 Web Crypto API 與 WebAssembly 的現代瀏覽器（Chrome、Firefox、Edge、Safari 近三個大版本）。

### 5.3 資料匯出/匯入
- 匯出：須於已登入狀態下執行，產生 §3.2 定義的 ExportFile 格式（明文標頭 + 加密本體），不得將整份檔案含 salt/kdfParams 一併加密。
- 匯入可於已登入狀態或登入頁執行（登入頁入口供 §4.1 已知限制所述 canary 損毀情境還原使用）；匯入前 UI 須明確警示：匯入為整份覆蓋，完成後主密碼將變為備份檔當時的主密碼。
- 登入頁匯入確認字串（僅適用於登入頁入口）：登入前的匯入不需要知道現行主密碼即可覆蓋整個保險庫，為補回操作摩擦、避免誤觸或被輕易利用，使用者點擊「匯入」後，須先手動輸入固定英文字串 `OVERWRITE`，才可進入檔案選擇與後續流程：
  - 比對方式為與 `"OVERWRITE"` 的嚴格相等比較（`===`）：大小寫須完全相符，**不做** NFC 正規化、`trim()` 或忽略大小寫等任何處理，刻意要求準確輸入。
  - 輸入不符時，「繼續」按鈕維持 disabled 狀態，不得進入檔案選擇流程；Service Layer 的登入前匯入入口亦須驗證此確認字串，不符即拒絕，不得僅依賴 UI 按鈕狀態。
  - 通過確認後，才進入下列流程步驟 1。
- 匯入流程：
  1. 讀取明文 header，取得 cryptoVersion、masterPasswordSalt、kdfParams。若 header 內 cryptoVersion 高於當前系統支援版本，拒絕匯入並提示版本落差。
  2. 要求使用者輸入**備份檔當時的**主密碼，依 header 中的參數與 §4.1 步驟衍生 encryptionKey。
  3. 以該 encryptionKey 解密 encryptedBody，解密即為密碼驗證，不另設獨立驗證步驟。GCM 認證失敗即拒絕匯入（密碼錯誤與檔案損毀無法區分，提示訊息需同時涵蓋兩者）。
  4. 解密成功後，驗證本體結構符合 §3 資料契約，並以同一把 encryptionKey 解密本體內的 canaryPayload、比對明文等於 `CANARY_PLAINTEXT`（恢復金鑰承諾性質，同 §4.1）；任一失敗即拒絕匯入。
  5. 驗證匯入資料中存在恰好一筆 id 等於 nil UUID、isSystemDefault=true 的「未分類」，且不存在其他重複；驗證每筆 Entry 的 categoryId 均可對應到匯入資料內的 Category 清單；任一驗證失敗即拒絕匯入並提示原因，不自動修復。
  6. 採**整份覆蓋**語意，於單一 IndexedDB 交易內寫入全部匯入資料，並設定：
     - `keyGeneration = max(當前系統 keyGeneration, 匯入資料 keyGeneration) + 1`（當前值不可讀取時視為 0）。
     - `loginFailureState` 與 `totpFailureState` 重置為 `{ failedAttempts: 0, lockedUntil: null }`。
  7. 交易提交後，依 §5.1.4 清除目前 session（若有），強制要求以備份檔當時的主密碼重新登入。
- 匯入資料的 cryptoVersion 低於當前系統支援版本時允許匯入，並於下次登入成功後依 §4.1.3 自動升級。

## 6. 驗收標準（Acceptance Criteria）

1. 未通過主密碼驗證時，任何 Entry 明文資料不可經由 UI 或系統其他模組存取。
2. 開啟 2FA 後：主密碼正確 + TOTP 正確 → 登入成功；主密碼正確 + TOTP 錯誤 + 無有效救援碼 → 拒絕；主密碼正確 + 有效未使用救援碼 → 登入成功且該碼標記 used=true；**主密碼錯誤，即使 TOTP 正確，一律拒絕登入**。
3. 查看 IndexedDB 原始內容時，不得出現任何明文密碼、明文 TOTP 秘鑰、明文救援碼；rawKey 與 encryptionKey 不得出現於任何持久化儲存中。
4. 刪除分類時，所有原參照該分類的 Entry 須於同一交易內轉移至「未分類」（nil UUID），不得存在指向已刪除分類 id 的 Entry，且此轉移不更新 Entry.updatedAt。
5. 搜尋+篩選+排序同時套用時，結果須同時滿足三者條件；字串排序使用 UTF-16 code unit 比較（對 NFC 正規化後的值），排序鍵相同時以 id 排序，結果在任何瀏覽器/作業系統下必須完全一致。
6. 主密碼連續失敗達第 6 次起，等待秒數須為 `2^(failedAttempts-5)`（封頂60秒）；`loginFailureState` 須在頁面重新整理後仍保持累計；驗證成功後歸零。
7. 關閉 2FA 須同時通過主密碼 +（TOTP 或未使用救援碼）雙重驗證；關閉後 twoFactorSecretEncrypted 與 recoveryCodes 須從 SecurityConfig 移除。
8. 加密函式連續呼叫 N 次（N≥100），產生的 IV 須全部不同、每個長度須為 12 bytes；同一明文加密兩次須產生不同密文。
9. 使用者閒置逾時或手動登出後，任何後續解密呼叫須被拒絕、須要求重新驗證主密碼；此為可觀測行為驗證，不驗證底層記憶體內容。
10. 匯出檔案須符合 §3.2 ExportFile 格式：header 為明文且可在不知道主密碼的情況下被解析出 cryptoVersion/salt/kdfParams；encryptedBody 須無法在缺少正確主密碼衍生金鑰的情況下解密還原任何明文欄位。
11. 首次設定或變更主密碼時，長度（以 UTF-16 code unit 計）小於 12 須被拒絕；變更主密碼流程（§4.1.2）完成後，須能以新密碼成功登入、原有全部 Entry 須可被正確解密還原，且 cryptoVersion 維持不變。
12. 重新金鑰化程序（§4.1.1）執行中若被強制中斷（模擬斷電/關閉分頁，或於步驟 3 注入例外、於步驟 4 交易中 abort），系統重啟後須能以**原密碼**成功登入，全部 Entry 可正確解密，且 SecurityConfig 的 masterPasswordSalt、kdfParams、cryptoVersion、canaryPayload、keyGeneration 須與執行前完全相同，不得出現新舊金鑰混雜或部分寫入的狀態；程序成功完成時，新的 canaryPayload 須能以新 encryptionKey 解密出 `CANARY_PLAINTEXT`，且無法以舊 encryptionKey 解密。
13. 主密碼驗證：以錯誤密碼衍生的金鑰解密 canaryPayload 須被判定失敗；以正確金鑰加密「非 `CANARY_PLAINTEXT` 內容」而成的 canaryPayload（GCM 認證可通過），驗證亦須被判定失敗。
14. 重新金鑰化程序執行期間（寫入鎖定旗標設定中），呼叫任一 §4.1.1 所列寫入 API 須立即被拒絕並回傳錯誤碼 `REKEY_IN_PROGRESS`，且 IndexedDB 無任何資料變動；此期間閒置逾時不得觸發。
15. SecurityConfig.keyGeneration 與 session 快照不一致時，任何受 §5.1.5 規範的寫入須被拒絕並回傳錯誤碼 `KEY_GENERATION_MISMATCH`，且沒有任何資料落地，session 須被清除並要求重新登入。
16. 登入前匯入流程，須先驗證使用者輸入的確認字串完全相符於固定值 `'OVERWRITE'`，才可進入檔案選擇與後續匯入流程；字串不符時不得進入下一步。

## 7. 待實作端決定事項
- 型態定義的檔案組織方式，由 CLI 依專案慣例決定。
- 元件層級的狀態管理方案（React Context 或其他輕量方案）。
- 以下常數已於本規格明確訂定，不再交由實作端自訂，以確保跨版本一致性與可測試性：HKDF `info` 字串 `"entry-encryption-key"`（§4.1）、`CANARY_PLAINTEXT`（§3.6）、錯誤碼 `REKEY_IN_PROGRESS`（§4.1.1）與 `KEY_GENERATION_MISMATCH`（§5.1.5）。
