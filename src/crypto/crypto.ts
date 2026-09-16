import sodium from "libsodium-wrappers-sumo";
import type { EncryptedPayload } from "../types/EncryptedPayload";
import type { KdfParams, RecoveryCode } from "../types/SecurityConfig";
import type { StoredEntryRecord } from "../types/StoredEntryRecord";

/**
 * Crypto Layer：純密碼學運算（規格 §2.1、§2.2、§4.1、§4.1.1、§5.1.1–§5.1.3）。
 * 不存取 IndexedDB、不處理 UI、不持有任何 session 狀態；
 * 除 rawKey 與重新金鑰化期間的明文位元組以 sodium.memzero 清除外，函式無副作用。
 */

/** §3.6：CANARY_PLAINTEXT 的來源字串 */
const CANARY_STRING = "password-keeper:canary:v1";

/** §4.1：HKDF info 字串 */
const HKDF_INFO = "entry-encryption-key";

/** §5.1.1：Argon2id 最低參數 */
const MIN_MEMORY_KIB = 19456;
const MIN_ITERATIONS = 2;
const REQUIRED_PARALLELISM = 1;

/** §4.1：Argon2id 輸出長度 */
const RAW_KEY_BYTES = 32;

/** §3.1、§5.1.2：AES-GCM IV 長度 */
const IV_BYTES = 12;

/** §5.1.3：救援碼雜湊用隨機鹽長度（規格未定長度，實作選擇 16 bytes） */
const RECOVERY_CODE_SALT_BYTES = 16;

/**
 * §3.6：固定常數 `"password-keeper:canary:v1"` 的 UTF-8 位元組。
 * 模組內部比對一律以 CANARY_STRING 重新編碼，不讀取此匯出陣列，避免外部竄改影響驗證。
 */
export const CANARY_PLAINTEXT: Uint8Array = utf8Encode(CANARY_STRING);

export type CryptoErrorCode = "DECRYPTION_FAILED";

/** Crypto Layer 可辨識的錯誤；原始錯誤保留於 cause */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly cause: unknown;

  constructor(code: CryptoErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
    this.cause = cause;
  }
}

/** §4.1.1 重新金鑰化程序的密碼學輸入 */
export interface RekeyInput {
  /** 用於衍生新金鑰的主密碼 */
  password: string;
  targetKdfParams: KdfParams;
  targetCryptoVersion: number;
  /** session 目前持有的舊 encryptionKey */
  oldKey: CryptoKey;
  /** 以舊金鑰加密的全部條目 */
  entries: readonly StoredEntryRecord[];
  twoFactorSecretEncrypted?: EncryptedPayload;
}

/** §4.1.1 步驟 2–3 的運算結果，供 Service Layer 於單一交易內寫入（keyGeneration 遞增不在此處理） */
export interface RekeyResult {
  masterPasswordSalt: string;
  kdfParams: KdfParams;
  cryptoVersion: number;
  /** 新 encryptionKey（non-extractable），交易提交成功後才可取代 session 內的舊金鑰 */
  encryptionKey: CryptoKey;
  canaryPayload: EncryptedPayload;
  entries: StoredEntryRecord[];
  twoFactorSecretEncrypted?: EncryptedPayload;
}

function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/**
 * libsodium 回傳的 Uint8Array 皆為一般 ArrayBuffer 上的獨立複本；
 * 此斷言僅為滿足 TypeScript 對 Web Crypto BufferSource 的型別要求，不複製資料。
 */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return asBufferSource(sodium.from_base64(value, sodium.base64_variants.ORIGINAL));
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** 常數時間比較（長度不同直接回傳 false；長度本身不視為秘密） */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

function assertKdfParams(params: KdfParams): void {
  const { memoryKiB, iterations, parallelism } = params;
  if (!Number.isSafeInteger(memoryKiB) || memoryKiB < MIN_MEMORY_KIB) {
    throw new RangeError(`kdfParams.memoryKiB 須為 ≥ ${MIN_MEMORY_KIB} 的整數（§5.1.1），實際為 ${memoryKiB}`);
  }
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS) {
    throw new RangeError(`kdfParams.iterations 須為 ≥ ${MIN_ITERATIONS} 的整數（§5.1.1），實際為 ${iterations}`);
  }
  if (parallelism !== REQUIRED_PARALLELISM) {
    throw new RangeError(`kdfParams.parallelism 須為 ${REQUIRED_PARALLELISM}（§5.1.1），實際為 ${parallelism}`);
  }
}

function decodeMasterPasswordSalt(salt: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(salt);
  } catch {
    throw new RangeError("masterPasswordSalt 不是有效的 Base64 字串");
  }
  if (bytes.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new RangeError(
      `masterPasswordSalt 須為 ${sodium.crypto_pwhash_SALTBYTES} bytes，實際為 ${bytes.length}`
    );
  }
  return bytes;
}

/** §3.6、§4.1.1：產生新的 masterPasswordSalt（Base64，crypto_pwhash_SALTBYTES bytes） */
export async function generateSalt(): Promise<string> {
  await sodium.ready;
  return toBase64(randomBytes(sodium.crypto_pwhash_SALTBYTES));
}

/**
 * §4.1 金鑰衍生流程、§5.1.1：
 * Argon2id（crypto_pwhash）→ rawKey 匯入為 HKDF baseKey → HKDF-SHA-256 衍生 AES-GCM 256 encryptionKey。
 * rawKey 匯入後立即以 sodium.memzero 清除（Web Crypto importKey 於呼叫時即複製金鑰位元組）。
 */
export async function deriveKeys(
  password: string,
  salt: string,
  kdfParams: KdfParams
): Promise<CryptoKey> {
  await sodium.ready;
  assertKdfParams(kdfParams);
  const saltBytes = decodeMasterPasswordSalt(salt);

  let baseKey: CryptoKey;
  let rawKey: Uint8Array | undefined;
  try {
    rawKey = sodium.crypto_pwhash(
      RAW_KEY_BYTES,
      password,
      saltBytes,
      kdfParams.iterations,
      kdfParams.memoryKiB * 1024,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
    baseKey = await crypto.subtle.importKey("raw", asBufferSource(rawKey), "HKDF", false, [
      "deriveKey",
    ]);
  } finally {
    if (rawKey !== undefined) sodium.memzero(rawKey);
  }

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8Encode(HKDF_INFO) },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptBytes(
  plaintext: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  cryptoVersion: number
): Promise<EncryptedPayload> {
  await sodium.ready;
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv), cryptoVersion };
}

async function decryptBytes(payload: EncryptedPayload, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  await sodium.ready;
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(payload.iv);
    ciphertext = fromBase64(payload.ciphertext);
  } catch (error) {
    throw new CryptoError("DECRYPTION_FAILED", "EncryptedPayload 的 iv 或 ciphertext 不是有效的 Base64 字串", error);
  }
  if (iv.length !== IV_BYTES) {
    throw new CryptoError("DECRYPTION_FAILED", `EncryptedPayload.iv 須為 ${IV_BYTES} bytes，實際為 ${iv.length}`);
  }
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
  } catch (error) {
    throw new CryptoError(
      "DECRYPTION_FAILED",
      "AES-GCM 解密失敗：認證未通過（金鑰錯誤或密文遭竄改）",
      error
    );
  }
}

/** §3.1、§5.1.2：AES-256-GCM 加密，每次呼叫產生獨立隨機 12 bytes IV */
export async function encryptPayload(
  plaintext: string,
  key: CryptoKey,
  cryptoVersion: number
): Promise<EncryptedPayload> {
  return encryptBytes(utf8Encode(plaintext), key, cryptoVersion);
}

/** §5.1.2：AES-256-GCM 解密；任何失敗皆拋出 CryptoError（code = DECRYPTION_FAILED），原始錯誤保留於 cause */
export async function decryptPayload(payload: EncryptedPayload, key: CryptoKey): Promise<string> {
  const bytes = await decryptBytes(payload, key);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new CryptoError("DECRYPTION_FAILED", "解密後的明文不是有效的 UTF-8", error);
  } finally {
    sodium.memzero(bytes);
  }
}

/** §4.1：以 encryptionKey 加密 CANARY_PLAINTEXT 產生 canaryPayload */
export async function createCanaryPayload(key: CryptoKey, cryptoVersion: number): Promise<EncryptedPayload> {
  return encryptBytes(utf8Encode(CANARY_STRING), key, cryptoVersion);
}

/**
 * §4.1 驗證流程：解密成功且明文與 CANARY_PLAINTEXT 逐位元組相等才回傳 true。
 * GCM 認證失敗或明文不符皆回傳 false（不得僅依賴 GCM 認證標籤，§4.1 partitioning oracle attack）。
 */
export async function verifyCanaryPayload(payload: EncryptedPayload, key: CryptoKey): Promise<boolean> {
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = await decryptBytes(payload, key);
  } catch (error) {
    if (error instanceof CryptoError) return false;
    throw error;
  }
  return constantTimeEqual(plaintext, utf8Encode(CANARY_STRING));
}

async function saltedSha256(salt: Uint8Array, code: string): Promise<Uint8Array<ArrayBuffer>> {
  const codeBytes = utf8Encode(code);
  const input = new Uint8Array(salt.length + codeBytes.length);
  input.set(salt, 0);
  input.set(codeBytes, salt.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/**
 * §5.1.3：救援碼加鹽雜湊，codeHash = SHA-256(salt ‖ UTF-8(code))，皆以 Base64 輸出。
 * 不做正規化，呼叫端（§4.2 2FA 模組）須先完成大小寫統一與去除連字號空白。
 */
export async function hashRecoveryCode(code: string): Promise<Pick<RecoveryCode, "codeHash" | "salt">> {
  await sodium.ready;
  const salt = randomBytes(RECOVERY_CODE_SALT_BYTES);
  return { codeHash: toBase64(await saltedSha256(salt, code)), salt: toBase64(salt) };
}

/** §5.1.3：以儲存的 salt 重新計算雜湊並以常數時間比較 */
export async function verifyRecoveryCode(code: string, codeHash: string, salt: string): Promise<boolean> {
  await sodium.ready;
  const actual = await saltedSha256(fromBase64(salt), code);
  return constantTimeEqual(actual, fromBase64(codeHash));
}

/**
 * §4.1.1 重新金鑰化程序步驟 2–3（僅記憶體內運算，不觸及 IndexedDB）：
 * 重新產生 salt → 衍生新 encryptionKey → 以舊金鑰解密、新金鑰與全新 IV 重新加密全部條目與 2FA 秘鑰
 * → 產生新 canaryPayload；所有 EncryptedPayload.cryptoVersion 設為 targetCryptoVersion。
 * 任一步驟失敗即整體 reject，不回傳部分結果；傳入的資料不被修改。
 */
export async function rekey(input: RekeyInput): Promise<RekeyResult> {
  const { password, targetKdfParams, targetCryptoVersion, oldKey } = input;

  const masterPasswordSalt = await generateSalt();
  const encryptionKey = await deriveKeys(password, masterPasswordSalt, targetKdfParams);

  const reencrypt = async (payload: EncryptedPayload): Promise<EncryptedPayload> => {
    const plaintext = await decryptBytes(payload, oldKey);
    try {
      return await encryptBytes(plaintext, encryptionKey, targetCryptoVersion);
    } finally {
      sodium.memzero(plaintext);
    }
  };

  const entries = await Promise.all(
    input.entries.map(async (entry) => ({ ...entry, password: await reencrypt(entry.password) }))
  );
  const canaryPayload = await createCanaryPayload(encryptionKey, targetCryptoVersion);

  const result: RekeyResult = {
    masterPasswordSalt,
    kdfParams: {
      memoryKiB: targetKdfParams.memoryKiB,
      iterations: targetKdfParams.iterations,
      parallelism: targetKdfParams.parallelism,
    },
    cryptoVersion: targetCryptoVersion,
    encryptionKey,
    canaryPayload,
    entries,
  };
  if (input.twoFactorSecretEncrypted !== undefined) {
    result.twoFactorSecretEncrypted = await reencrypt(input.twoFactorSecretEncrypted);
  }
  return result;
}
