import { describe, test, expect } from "vitest";
import type { StoredEntryRecord } from "../../src/types/StoredEntryRecord";
import type { KdfParams, SecurityConfig } from "../../src/types/SecurityConfig";
import {
  generateSalt,
  deriveKeys,
  encryptPayload,
  decryptPayload,
} from "../../src/crypto/crypto";
import {
  isStoredEntryRecordShape,
  isSecurityConfigShape,
} from "./_shared/shapeGuards";

/**
 * 邊界：加密層（Crypto Layer） <-> 儲存層（Storage Layer）
 * 對應規格 §2.2 分層架構、§2.3 資料流向硬性約束、§3.1 EncryptedPayload、
 * §3.4 StoredEntryRecord、§3.6 SecurityConfig、§5.1.2 資料加密。
 *
 * 此邊界涉及加密層，依規則需包含加解密往返相關驗證；「落地資料不得為明文」
 * 這項約束（§2.3）以 Crypto 層（src/crypto/crypto.ts）的真實加密輸出比對。
 */

const storedRecord: StoredEntryRecord = {
  id: "e1a2b3c4-0000-4000-8000-000000000002",
  appName: "Example Bank",
  categoryId: "c1a2b3c4-0000-4000-8000-000000000001",
  accountId: "user@example.com",
  // 落地儲存時 password 為加密層輸出的 EncryptedPayload（§3.1、§3.4）
  password: {
    ciphertext: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJ",
    iv: "AAECAwQFBgcICQoL",
    cryptoVersion: 1,
  },
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const securityConfig: SecurityConfig = {
  masterPasswordSalt: "base64-salt",
  canaryPayload: {
    ciphertext: "ASNFZ4mrze8BI0VniavN7wEjRWeJq83v",
    iv: "CwoJCAcGBQQDAgEA",
    cryptoVersion: 1,
  },
  keyGeneration: 1,
  cryptoVersion: 1,
  kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  twoFactorEnabled: false,
  loginFailureState: { failedAttempts: 0, lockedUntil: null },
};

describe("Crypto-Storage boundary: 型態一致性", () => {
  test("加密層交給儲存層落地的 StoredEntryRecord，形狀與型態契約一致", () => {
    expect(isStoredEntryRecordShape(storedRecord)).toBe(true);
  });

  test("加密層交給儲存層落地的 SecurityConfig，形狀與型態契約一致", () => {
    expect(isSecurityConfigShape(securityConfig)).toBe(true);
  });

  test("異常情境：缺少必填欄位（updatedAt）時，不符合落地前的 StoredEntryRecord 邊界契約", () => {
    const { updatedAt, ...missingUpdatedAt } = storedRecord;
    expect(isStoredEntryRecordShape(missingUpdatedAt)).toBe(false);
  });

  test("異常情境：password 為明文字串（未經加密層）時，不符合 StoredEntryRecord 邊界契約", () => {
    const plaintextPassword = { ...storedRecord, password: "correct horse battery staple" };
    expect(isStoredEntryRecordShape(plaintextPassword)).toBe(false);
  });

  test("異常情境：EncryptedPayload.iv 非 12 bytes 時，不符合 StoredEntryRecord 邊界契約", () => {
    // "AAECAwQFBgc=" 為 8 bytes 的 Base64 編碼
    const shortIv = { ...storedRecord, password: { ...storedRecord.password, iv: "AAECAwQFBgc=" } };
    expect(isStoredEntryRecordShape(shortIv)).toBe(false);
  });
});

describe("Crypto-Storage boundary: 明文不得落地（§2.3）", () => {
  test("落地儲存的 password 密文不得與原始明文相同，且以真實加密輸出組成的 StoredEntryRecord 符合契約", async () => {
    const kdfParams: KdfParams = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
    const key = await deriveKeys("correct horse battery", await generateSalt(), kdfParams);
    const plaintext = "correct horse battery staple";
    const encrypted = await encryptPayload(plaintext, key, 1);

    const record: StoredEntryRecord = { ...storedRecord, password: encrypted };
    expect(isStoredEntryRecordShape(record)).toBe(true);

    const serialized = JSON.stringify(record);
    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(btoa(plaintext));

    await expect(decryptPayload(record.password, key)).resolves.toBe(plaintext);
  });
});
