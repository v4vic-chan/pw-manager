import { vi } from "vitest";
import type { SecurityStorage } from "../../../src/ui/security/securityController";
import type { RecoveryCodesBatch, TwoFactorSetup } from "../../../src/services/twoFactor";
import type { ExportFile } from "../../../src/types/ExportFile";

/**
 * 有狀態的假安全設定 storage（僅供測試）：以固定的主密碼、驗證碼與救援碼模擬
 * storage.ts 的 2FA／主密碼／匯出行為；每個方法皆為 vi.fn，可用 overrides 換成拒絕或延遲版本。
 */

export const CURRENT_PASSWORD = "current master pass 2026";
export const NEW_PASSWORD = "brand new master pass 2026";
export const VALID_TOTP = "123456";
export const VALID_RECOVERY_CODE = "AAAA-BBBB-CCCC-0001";

export const SETUP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DP";
export const SETUP_QR = "data:image/png;base64,UVJDT0RF";
export const SETUP_CODES = Array.from({ length: 10 }, (_, index) => `SETP-CODE-AAAA-${String(index).padStart(4, "0")}`);
export const NEW_BATCH_CODES = Array.from({ length: 10 }, (_, index) => `NEWC-CODE-BBBB-${String(index).padStart(4, "0")}`);

export const EXPORT_FILE: ExportFile = {
  formatVersion: 1,
  header: {
    cryptoVersion: 1,
    masterPasswordSalt: "AAAAAAAAAAAAAAAAAAAAAA==",
    kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  },
  encryptedBody: { ciphertext: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJ", iv: "AAECAwQFBgcICQoL", cryptoVersion: 1 },
};

/** 所有應該只短暫出現在畫面上的秘密 */
export const ALL_SECRETS = [SETUP_SECRET, ...SETUP_CODES, ...NEW_BATCH_CODES, CURRENT_PASSWORD, NEW_PASSWORD];

export interface FakeSecurity {
  storage: SecurityStorage;
  getPassword(): string;
  isTwoFactorEnabled(): boolean;
}

export function createFakeSecurity(
  options: { twoFactorEnabled?: boolean; unusedRecoveryCodes?: number; overrides?: Partial<SecurityStorage> } = {}
): FakeSecurity {
  let password = CURRENT_PASSWORD;
  let twoFactorEnabled = options.twoFactorEnabled ?? false;
  let unusedRecoveryCodes = twoFactorEnabled ? (options.unusedRecoveryCodes ?? 10) : 0;

  const storage: SecurityStorage = {
    getSecurityStatus: vi.fn<SecurityStorage["getSecurityStatus"]>(async () => ({ twoFactorEnabled, unusedRecoveryCodes })),

    reverifyMasterPassword: vi.fn<SecurityStorage["reverifyMasterPassword"]>(async (input) =>
      input === password ? { ok: true } : { ok: false, reason: "INVALID_MASTER_PASSWORD" }
    ),

    changeMasterPassword: vi.fn<SecurityStorage["changeMasterPassword"]>(async (next) => {
      if (next.length < 12) throw new RangeError("too short");
      password = next;
    }),

    beginTwoFactorSetup: vi.fn<SecurityStorage["beginTwoFactorSetup"]>(async () => {
      const setup: TwoFactorSetup = {
        secret: SETUP_SECRET,
        qrCodeDataUrl: SETUP_QR,
        recoveryCodesPlaintext: [...SETUP_CODES],
        twoFactorSecretEncrypted: { ciphertext: "x", iv: "y", cryptoVersion: 1 },
        recoveryCodes: [],
      };
      return setup;
    }),

    confirmTwoFactorSetup: vi.fn<SecurityStorage["confirmTwoFactorSetup"]>(async (code, setup) => {
      if (code !== VALID_TOTP) return { ok: false, reason: "INVALID_TOTP_CODE" };
      twoFactorEnabled = true;
      unusedRecoveryCodes = setup.recoveryCodesPlaintext.length;
      return {
        ok: true,
        changes: {
          twoFactorEnabled: true,
          twoFactorSecretEncrypted: setup.twoFactorSecretEncrypted,
          recoveryCodes: setup.recoveryCodes,
          recoveryCodesRemainingWarningShown: false,
        },
      };
    }),

    disableTwoFactor: vi.fn<SecurityStorage["disableTwoFactor"]>(async (input, secondFactor) => {
      if (input !== password) return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
      if ("totpCode" in secondFactor && secondFactor.totpCode !== VALID_TOTP) {
        return { ok: false, reason: "INVALID_TOTP_CODE" };
      }
      if ("recoveryCode" in secondFactor && secondFactor.recoveryCode !== VALID_RECOVERY_CODE) {
        return { ok: false, reason: "INVALID_RECOVERY_CODE" };
      }
      twoFactorEnabled = false;
      unusedRecoveryCodes = 0;
      return { ok: true };
    }),

    beginRecoveryCodesRegeneration: vi.fn<SecurityStorage["beginRecoveryCodesRegeneration"]>(async (input, totpCode) => {
      if (input !== password) return { ok: false, reason: "INVALID_MASTER_PASSWORD" };
      if (totpCode !== VALID_TOTP) return { ok: false, reason: "INVALID_TOTP_CODE" };
      const batch: RecoveryCodesBatch = {
        recoveryCodesPlaintext: [...NEW_BATCH_CODES],
        recoveryCodes: [],
        recoveryCodesRemainingWarningShown: false,
      };
      return { ok: true, batch };
    }),

    commitRecoveryCodes: vi.fn<SecurityStorage["commitRecoveryCodes"]>(async (batch) => {
      unusedRecoveryCodes = batch.recoveryCodesPlaintext.length;
    }),

    exportVault: vi.fn<SecurityStorage["exportVault"]>(async () => structuredClone(EXPORT_FILE)),

    ...options.overrides,
  };

  return { storage, getPassword: () => password, isTwoFactorEnabled: () => twoFactorEnabled };
}
