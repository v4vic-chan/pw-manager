import { describe, test, expect, beforeAll, afterEach, vi } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  CANARY_PLAINTEXT,
  CryptoError,
  generateSalt,
  deriveKeys,
  encryptPayload,
  decryptPayload,
  createCanaryPayload,
  verifyCanaryPayload,
  hashRecoveryCode,
  verifyRecoveryCode,
  rekey,
} from "../../src/crypto/crypto";
import type { KdfParams } from "../../src/types/SecurityConfig";
import type { StoredEntryRecord } from "../../src/types/StoredEntryRecord";

/**
 * 模組：Crypto Layer（規格 §2.1、§4.1、§4.1.1、§5.1.1–§5.1.3）
 * 對應驗收標準：§6 AC8（IV 唯一且 12 bytes）、AC12（重新金鑰化後 canary 僅新金鑰可解）、
 * AC13（canary 須比對固定明文，不得僅依賴 GCM 認證）。
 *
 * TDD 紅燈說明：src/crypto/crypto.ts 尚未實作，
 * 本檔案的測試在實作完成前預期失敗，此為正常狀態。
 */

const MIN_KDF_PARAMS: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "wrong password entirely";
const CRYPTO_VERSION = 1;

function fromBase64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
}

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

let salt: string;
let key: CryptoKey;
let wrongKey: CryptoKey;

beforeAll(async () => {
  await sodium.ready;
  salt = await generateSalt();
  key = await deriveKeys(PASSWORD, salt, MIN_KDF_PARAMS);
  wrongKey = await deriveKeys(WRONG_PASSWORD, salt, MIN_KDF_PARAMS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CANARY_PLAINTEXT：固定常數（§3.6、§7）", () => {
  test("等於字串 \"password-keeper:canary:v1\" 的 UTF-8 位元組", () => {
    expect(Array.from(CANARY_PLAINTEXT)).toEqual(
      Array.from(new TextEncoder().encode("password-keeper:canary:v1"))
    );
  });
});

describe("generateSalt：Argon2id 用鹽（§3.6、§5.1.1）", () => {
  test("happy path：回傳標準 Base64，解碼後為 crypto_pwhash_SALTBYTES（16）bytes", async () => {
    const s = await generateSalt();
    expect(fromBase64(s).length).toBe(sodium.crypto_pwhash_SALTBYTES);
    expect(fromBase64(s).length).toBe(16);
  });

  test("每次呼叫產生不同的鹽", async () => {
    const salts = new Set<string>();
    for (let i = 0; i < 20; i++) salts.add(await generateSalt());
    expect(salts.size).toBe(20);
  });
});

describe("deriveKeys：Argon2id + HKDF 衍生 encryptionKey（§4.1、§5.1.1）", () => {
  test("happy path：回傳 non-extractable 的 AES-GCM 256 CryptoKey，usages 僅 encrypt/decrypt", () => {
    expect(key.type).toBe("secret");
    expect(key.extractable).toBe(false);
    expect((key.algorithm as AesKeyAlgorithm).name).toBe("AES-GCM");
    expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
  });

  test("確定性：相同密碼 + 相同鹽 + 相同參數衍生的金鑰可互相解密", async () => {
    const again = await deriveKeys(PASSWORD, salt, MIN_KDF_PARAMS);
    const payload = await encryptPayload("secret value", key, CRYPTO_VERSION);
    await expect(decryptPayload(payload, again)).resolves.toBe("secret value");
  });

  test("不同鹽衍生出不同金鑰（無法互相解密）", async () => {
    const otherSaltKey = await deriveKeys(PASSWORD, await generateSalt(), MIN_KDF_PARAMS);
    const payload = await encryptPayload("secret value", key, CRYPTO_VERSION);
    await expect(decryptPayload(payload, otherSaltKey)).rejects.toBeInstanceOf(CryptoError);
  });

  test("嚴格要求：rawKey（32 bytes）使用後以 sodium.memzero 清除", async () => {
    const spy = vi.spyOn(sodium, "memzero");
    await deriveKeys(PASSWORD, salt, MIN_KDF_PARAMS);
    const zeroed = spy.mock.calls.map((call) => call[0]).filter((b) => b.length === 32);
    expect(zeroed.length).toBeGreaterThanOrEqual(1);
    for (const bytes of zeroed) {
      expect(bytes.every((b) => b === 0)).toBe(true);
    }
  });

  test("邊界：參數恰為 §5.1.1 最低門檻可成功衍生", async () => {
    await expect(deriveKeys(PASSWORD, salt, MIN_KDF_PARAMS)).resolves.toBeDefined();
  });

  test("異常路徑：memoryKiB 低於 19456 應被拒絕", async () => {
    await expect(
      deriveKeys(PASSWORD, salt, { ...MIN_KDF_PARAMS, memoryKiB: 19455 })
    ).rejects.toThrow();
  });

  test("異常路徑：iterations 低於 2 應被拒絕", async () => {
    await expect(
      deriveKeys(PASSWORD, salt, { ...MIN_KDF_PARAMS, iterations: 1 })
    ).rejects.toThrow();
  });

  test("異常路徑：parallelism 不等於 1 應被拒絕", async () => {
    await expect(
      deriveKeys(PASSWORD, salt, { ...MIN_KDF_PARAMS, parallelism: 2 })
    ).rejects.toThrow();
  });

  test("異常路徑：鹽長度不是 16 bytes 應被拒絕", async () => {
    await expect(
      deriveKeys(PASSWORD, toBase64(new Uint8Array(8)), MIN_KDF_PARAMS)
    ).rejects.toThrow();
  });
});

describe("encryptPayload：AES-256-GCM 加密（§3.1、§5.1.2、AC8）", () => {
  test("happy path：回傳 EncryptedPayload 形狀，cryptoVersion 為呼叫端傳入值", async () => {
    const payload = await encryptPayload("hunter2", key, 7);
    expect(typeof payload.ciphertext).toBe("string");
    expect(typeof payload.iv).toBe("string");
    expect(payload.cryptoVersion).toBe(7);
  });

  test("密文不得等於明文，且含 16 bytes 認證標籤", async () => {
    const plaintext = "correct horse battery staple";
    const payload = await encryptPayload(plaintext, key, CRYPTO_VERSION);
    expect(payload.ciphertext).not.toBe(plaintext);
    expect(fromBase64(payload.ciphertext).length).toBe(
      new TextEncoder().encode(plaintext).length + 16
    );
  });

  test("AC8：連續呼叫 100 次，IV 全部不同且每個長度為 12 bytes", async () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const payload = await encryptPayload("same plaintext", key, CRYPTO_VERSION);
      expect(fromBase64(payload.iv).length).toBe(12);
      ivs.add(payload.iv);
    }
    expect(ivs.size).toBe(100);
  });

  test("AC8：同一明文加密兩次產生不同密文", async () => {
    const a = await encryptPayload("same plaintext", key, CRYPTO_VERSION);
    const b = await encryptPayload("same plaintext", key, CRYPTO_VERSION);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("decryptPayload：AES-256-GCM 解密（§5.1.2）", () => {
  test("happy path：往返一致（含多位元組 Unicode）", async () => {
    const plaintext = "密碼 🔐 pässwörd";
    const payload = await encryptPayload(plaintext, key, CRYPTO_VERSION);
    await expect(decryptPayload(payload, key)).resolves.toBe(plaintext);
  });

  test("邊界：空字串可往返", async () => {
    const payload = await encryptPayload("", key, CRYPTO_VERSION);
    await expect(decryptPayload(payload, key)).resolves.toBe("");
  });

  test("異常路徑：以錯誤金鑰解密拋出 CryptoError（code = DECRYPTION_FAILED），保留原始錯誤於 cause", async () => {
    const payload = await encryptPayload("hunter2", key, CRYPTO_VERSION);
    const error = await decryptPayload(payload, wrongKey).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("DECRYPTION_FAILED");
    expect((error as CryptoError).cause).toBeDefined();
  });

  test("異常路徑：密文被竄改（翻轉 1 bit）拋出 CryptoError", async () => {
    const payload = await encryptPayload("hunter2", key, CRYPTO_VERSION);
    const bytes = fromBase64(payload.ciphertext);
    bytes[0] ^= 0x01;
    const tampered = { ...payload, ciphertext: toBase64(bytes) };
    await expect(decryptPayload(tampered, key)).rejects.toBeInstanceOf(CryptoError);
  });

  test("異常路徑：IV 被替換拋出 CryptoError", async () => {
    const payload = await encryptPayload("hunter2", key, CRYPTO_VERSION);
    const other = await encryptPayload("hunter2", key, CRYPTO_VERSION);
    await expect(decryptPayload({ ...payload, iv: other.iv }, key)).rejects.toBeInstanceOf(
      CryptoError
    );
  });

  test("異常路徑：IV 長度不是 12 bytes 拋出 CryptoError", async () => {
    const payload = await encryptPayload("hunter2", key, CRYPTO_VERSION);
    const shortIv = { ...payload, iv: toBase64(new Uint8Array(8)) };
    await expect(decryptPayload(shortIv, key)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe("createCanaryPayload / verifyCanaryPayload：主密碼驗證（§4.1、AC13）", () => {
  test("happy path：以同一把金鑰建立與驗證 canary 應成功", async () => {
    const canary = await createCanaryPayload(key, CRYPTO_VERSION);
    expect(canary.cryptoVersion).toBe(CRYPTO_VERSION);
    await expect(verifyCanaryPayload(canary, key)).resolves.toBe(true);
  });

  test("canary 解密後明文為 CANARY_PLAINTEXT", async () => {
    const canary = await createCanaryPayload(key, CRYPTO_VERSION);
    await expect(decryptPayload(canary, key)).resolves.toBe("password-keeper:canary:v1");
  });

  test("AC13：以錯誤密碼衍生的金鑰驗證 canary 應判定失敗（GCM 認證失敗，不拋錯）", async () => {
    const canary = await createCanaryPayload(key, CRYPTO_VERSION);
    await expect(verifyCanaryPayload(canary, wrongKey)).resolves.toBe(false);
  });

  test("AC13：以正確金鑰加密非 CANARY_PLAINTEXT 內容（GCM 可通過），驗證仍須判定失敗", async () => {
    const forged = await encryptPayload("not-the-canary", key, CRYPTO_VERSION);
    await expect(decryptPayload(forged, key)).resolves.toBe("not-the-canary");
    await expect(verifyCanaryPayload(forged, key)).resolves.toBe(false);
  });

  test("邊界：明文為 CANARY_PLAINTEXT 的前綴或多一字元，驗證須判定失敗", async () => {
    const prefix = await encryptPayload("password-keeper:canary:v", key, CRYPTO_VERSION);
    const longer = await encryptPayload("password-keeper:canary:v1 ", key, CRYPTO_VERSION);
    await expect(verifyCanaryPayload(prefix, key)).resolves.toBe(false);
    await expect(verifyCanaryPayload(longer, key)).resolves.toBe(false);
  });

  test("異常路徑：canary 密文被竄改，驗證判定失敗", async () => {
    const canary = await createCanaryPayload(key, CRYPTO_VERSION);
    const bytes = fromBase64(canary.ciphertext);
    bytes[bytes.length - 1] ^= 0x80;
    await expect(
      verifyCanaryPayload({ ...canary, ciphertext: toBase64(bytes) }, key)
    ).resolves.toBe(false);
  });

  test("匯出的 CANARY_PLAINTEXT 被外部竄改時，不影響驗證結果", async () => {
    const canary = await createCanaryPayload(key, CRYPTO_VERSION);
    const original = CANARY_PLAINTEXT[0];
    CANARY_PLAINTEXT[0] = 0x00;
    try {
      await expect(verifyCanaryPayload(canary, key)).resolves.toBe(true);
    } finally {
      CANARY_PLAINTEXT[0] = original;
    }
  });
});

describe("hashRecoveryCode / verifyRecoveryCode：救援碼加鹽雜湊（§5.1.3）", () => {
  const CODE = "0123456789ABCDEF";

  test("happy path：回傳 { codeHash, salt }，salt 為 16 bytes、codeHash 為 32 bytes（SHA-256）", async () => {
    const result = await hashRecoveryCode(CODE);
    expect(fromBase64(result.salt).length).toBe(16);
    expect(fromBase64(result.codeHash).length).toBe(32);
    expect(result.codeHash).not.toContain(CODE);
  });

  test("構造：codeHash = SHA-256(salt ‖ UTF-8(code))", async () => {
    const { codeHash, salt: codeSalt } = await hashRecoveryCode(CODE);
    const saltBytes = fromBase64(codeSalt);
    const codeBytes = new TextEncoder().encode(CODE);
    const input = new Uint8Array(saltBytes.length + codeBytes.length);
    input.set(saltBytes, 0);
    input.set(codeBytes, saltBytes.length);
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    expect(codeHash).toBe(toBase64(expected));
  });

  test("每組獨立隨機鹽：同一救援碼雜湊兩次，salt 與 codeHash 皆不同", async () => {
    const a = await hashRecoveryCode(CODE);
    const b = await hashRecoveryCode(CODE);
    expect(a.salt).not.toBe(b.salt);
    expect(a.codeHash).not.toBe(b.codeHash);
  });

  test("happy path：正確救援碼驗證成功", async () => {
    const { codeHash, salt: codeSalt } = await hashRecoveryCode(CODE);
    await expect(verifyRecoveryCode(CODE, codeHash, codeSalt)).resolves.toBe(true);
  });

  test("異常路徑：錯誤救援碼驗證失敗", async () => {
    const { codeHash, salt: codeSalt } = await hashRecoveryCode(CODE);
    await expect(verifyRecoveryCode("0123456789ABCDEE", codeHash, codeSalt)).resolves.toBe(false);
  });

  test("職責邊界：本模組不做正規化，大小寫不同視為不同輸入（正規化屬 2FA 模組 §4.2）", async () => {
    const { codeHash, salt: codeSalt } = await hashRecoveryCode(CODE);
    await expect(verifyRecoveryCode(CODE.toLowerCase(), codeHash, codeSalt)).resolves.toBe(false);
  });

  test("異常路徑：使用其他筆的 salt 驗證失敗", async () => {
    const a = await hashRecoveryCode(CODE);
    const b = await hashRecoveryCode(CODE);
    await expect(verifyRecoveryCode(CODE, a.codeHash, b.salt)).resolves.toBe(false);
  });
});

describe("rekey：重新金鑰化共用程序的密碼學部分（§4.1.1、AC12）", () => {
  const NEW_PASSWORD = "brand new master password";
  const TARGET_KDF: KdfParams = { memoryKiB: 19456 * 2, iterations: 3, parallelism: 1 };

  async function makeEntries(): Promise<{ records: StoredEntryRecord[]; plaintexts: string[] }> {
    const plaintexts = ["pw-one", "pw-二", ""];
    const records: StoredEntryRecord[] = [];
    for (let i = 0; i < plaintexts.length; i++) {
      records.push({
        id: `e1a2b3c4-0000-4000-8000-00000000000${i}`,
        appName: `App ${i}`,
        categoryId: "00000000-0000-0000-0000-000000000000",
        accountId: `user${i}@example.com`,
        password: await encryptPayload(plaintexts[i], key, CRYPTO_VERSION),
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      });
    }
    return { records, plaintexts };
  }

  test("happy path：新 salt、新金鑰、target 參數；全部條目以新金鑰可解出原明文", async () => {
    const { records, plaintexts } = await makeEntries();
    const result = await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: TARGET_KDF,
      targetCryptoVersion: 2,
      oldKey: key,
      entries: records,
    });

    expect(result.masterPasswordSalt).not.toBe(salt);
    expect(fromBase64(result.masterPasswordSalt).length).toBe(16);
    expect(result.kdfParams).toEqual(TARGET_KDF);
    expect(result.cryptoVersion).toBe(2);
    expect(result.entries).toHaveLength(records.length);

    for (let i = 0; i < records.length; i++) {
      const { password: newPassword, ...rest } = result.entries[i];
      const { password: oldPassword, ...oldRest } = records[i];
      expect(rest).toEqual(oldRest);
      expect(newPassword.cryptoVersion).toBe(2);
      expect(newPassword.iv).not.toBe(oldPassword.iv);
      await expect(decryptPayload(newPassword, result.encryptionKey)).resolves.toBe(plaintexts[i]);
      await expect(decryptPayload(newPassword, key)).rejects.toBeInstanceOf(CryptoError);
    }
  });

  test("AC12：新 canaryPayload 可被新金鑰驗證，且無法以舊金鑰驗證", async () => {
    const { records } = await makeEntries();
    const result = await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: CRYPTO_VERSION,
      oldKey: key,
      entries: records,
    });
    expect(result.canaryPayload.cryptoVersion).toBe(CRYPTO_VERSION);
    await expect(verifyCanaryPayload(result.canaryPayload, result.encryptionKey)).resolves.toBe(true);
    await expect(verifyCanaryPayload(result.canaryPayload, key)).resolves.toBe(false);
  });

  test("回傳的 encryptionKey 等同以 (password, 新 salt, targetKdfParams) 依 §4.1 衍生的金鑰", async () => {
    const result = await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: CRYPTO_VERSION,
      oldKey: key,
      entries: [],
    });
    const rederived = await deriveKeys(NEW_PASSWORD, result.masterPasswordSalt, MIN_KDF_PARAMS);
    await expect(verifyCanaryPayload(result.canaryPayload, rederived)).resolves.toBe(true);
    expect(result.encryptionKey.extractable).toBe(false);
  });

  test("變更主密碼情境：沿用現行參數與版本時，salt 仍強制重新產生", async () => {
    const result = await rekey({
      password: PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: CRYPTO_VERSION,
      oldKey: key,
      entries: [],
    });
    expect(result.masterPasswordSalt).not.toBe(salt);
    expect(result.cryptoVersion).toBe(CRYPTO_VERSION);
  });

  test("twoFactorSecretEncrypted 存在時一併以新金鑰重新加密", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encryptedSecret = await encryptPayload(secret, key, CRYPTO_VERSION);
    const result = await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: 2,
      oldKey: key,
      entries: [],
      twoFactorSecretEncrypted: encryptedSecret,
    });
    expect(result.twoFactorSecretEncrypted).toBeDefined();
    expect(result.twoFactorSecretEncrypted!.cryptoVersion).toBe(2);
    expect(result.twoFactorSecretEncrypted!.iv).not.toBe(encryptedSecret.iv);
    await expect(
      decryptPayload(result.twoFactorSecretEncrypted!, result.encryptionKey)
    ).resolves.toBe(secret);
  });

  test("twoFactorSecretEncrypted 不存在時，結果也不含此欄位", async () => {
    const result = await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: CRYPTO_VERSION,
      oldKey: key,
      entries: [],
    });
    expect("twoFactorSecretEncrypted" in result).toBe(false);
  });

  test("無副作用：不修改傳入的 entries 與 twoFactorSecretEncrypted", async () => {
    const { records } = await makeEntries();
    const encryptedSecret = await encryptPayload("JBSWY3DPEHPK3PXP", key, CRYPTO_VERSION);
    const snapshot = structuredClone({ records, encryptedSecret });
    await rekey({
      password: NEW_PASSWORD,
      targetKdfParams: MIN_KDF_PARAMS,
      targetCryptoVersion: 2,
      oldKey: key,
      entries: records,
      twoFactorSecretEncrypted: encryptedSecret,
    });
    expect({ records, encryptedSecret }).toEqual(snapshot);
  });

  test("異常路徑：舊金鑰無法解密任一條目時，整體拒絕並拋出 CryptoError", async () => {
    const { records } = await makeEntries();
    await expect(
      rekey({
        password: NEW_PASSWORD,
        targetKdfParams: MIN_KDF_PARAMS,
        targetCryptoVersion: CRYPTO_VERSION,
        oldKey: wrongKey,
        entries: records,
      })
    ).rejects.toBeInstanceOf(CryptoError);
  });

  test("異常路徑：targetKdfParams 低於 §5.1.1 門檻時拒絕", async () => {
    await expect(
      rekey({
        password: NEW_PASSWORD,
        targetKdfParams: { ...MIN_KDF_PARAMS, iterations: 1 },
        targetCryptoVersion: CRYPTO_VERSION,
        oldKey: key,
        entries: [],
      })
    ).rejects.toThrow();
  });
});
