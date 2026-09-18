import { describe, test, expect, vi } from "vitest";
import { createAuthController, type AuthStorage } from "../../src/ui/auth/authController";
import { ImportError, type ImportErrorCode } from "../../src/services/importExport";
import { StorageError } from "../../src/services/storage";

/**
 * 模組：登入／解鎖流程控制器（UI 層，純 TypeScript，以假 storage／假計時器注入）
 * 對應規格 §4.1、§4.2、§5.1.4、§5.3；AC6、AC9、AC11、AC16。
 * 重點：閒置計時於「主密碼通過」當下啟動並綁定活動監聽（第二因素階段記憶體中已有金鑰），
 * 回到登入時一律 logout + stop + unbind，且不重複綁定。
 */

const NOW = 1_000_000;
const PASSWORD = "correct horse battery staple";

const VALID_FILE = JSON.stringify({
  formatVersion: 1,
  header: {
    cryptoVersion: 1,
    masterPasswordSalt: "AAAAAAAAAAAAAAAAAAAAAA==",
    kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  },
  encryptedBody: { ciphertext: "q83vASNFZ4mrze8BI0VniavN7wEjRWeJ", iv: "AAECAwQFBgcICQoL", cryptoVersion: 1 },
});

const fileOf = (content: string, name = "backup.json") => ({ name, text: async () => content });

function createFakes(overrides: Partial<AuthStorage> = {}) {
  const storage: AuthStorage = {
    isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => true),
    initialize: vi.fn<AuthStorage["initialize"]>(async () => undefined),
    login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: false })),
    verifySecondFactor: vi.fn<AuthStorage["verifySecondFactor"]>(async () => ({ ok: true })),
    logout: vi.fn<AuthStorage["logout"]>(),
    startPreLoginImport: vi.fn<AuthStorage["startPreLoginImport"]>(async ({ confirmation }) => {
      if (confirmation !== "OVERWRITE") throw new ImportError("CONFIRMATION_MISMATCH", "mismatch");
      return { kind: "pre-login-import" };
    }),
    importVault: vi.fn<AuthStorage["importVault"]>(async () => undefined),
    ...overrides,
  };
  const idleTimer = { start: vi.fn(), stop: vi.fn() };
  const unbind = vi.fn();
  const bindActivity = vi.fn(() => unbind);
  const controller = createAuthController({ storage, idleTimer, bindActivity, now: () => NOW });
  return { storage, idleTimer, bindActivity, unbind, controller };
}

async function bootToLogin(overrides: Partial<AuthStorage> = {}) {
  const fakes = createFakes(overrides);
  await fakes.controller.boot();
  return fakes;
}

async function bootToSecondFactor(overrides: Partial<AuthStorage> = {}) {
  const fakes = await bootToLogin({
    login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: true })),
    ...overrides,
  });
  await fakes.controller.submitLogin(PASSWORD);
  return fakes;
}

async function bootToImportFile(overrides: Partial<AuthStorage> = {}) {
  const fakes = await bootToLogin(overrides);
  fakes.controller.beginImport();
  await fakes.controller.submitImportConfirmation("OVERWRITE");
  await fakes.controller.selectImportFile(fileOf(VALID_FILE));
  return fakes;
}

describe("啟動", () => {
  test("尚未初始化進入首次設定；已初始化進入登入；無法開啟資料庫時進入 fatal", async () => {
    const fresh = createFakes({ isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => false) });
    await fresh.controller.boot();
    expect(fresh.controller.getState().phase).toBe("setup");

    const existing = createFakes();
    await existing.controller.boot();
    expect(existing.controller.getState().phase).toBe("login");

    const broken = createFakes({
      isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => {
        throw new Error("IndexedDB unavailable");
      }),
    });
    await broken.controller.boot();
    expect(broken.controller.getState()).toEqual({
      phase: "fatal",
      error: "無法開啟本機資料庫，請確認瀏覽器允許使用 IndexedDB",
    });
  });

  test("狀態變更會通知訂閱者；取消訂閱後不再通知", async () => {
    const { controller } = createFakes();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.boot();
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    controller.beginImport();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("首次設定（§4.1、AC11）", () => {
  async function bootToSetup(overrides: Partial<AuthStorage> = {}) {
    const fakes = createFakes({ isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => false), ...overrides });
    await fakes.controller.boot();
    return fakes;
  }

  test("兩次輸入不一致：顯示錯誤且不呼叫 initialize", async () => {
    const { controller, storage } = await bootToSetup();
    await controller.submitSetup(PASSWORD, `${PASSWORD}!`);
    expect(controller.getState()).toEqual({ phase: "setup", busy: false, error: "兩次輸入的主密碼不一致" });
    expect(storage.initialize).not.toHaveBeenCalled();
  });

  test("長度不足 12 字元：顯示錯誤且不呼叫 initialize", async () => {
    const { controller, storage } = await bootToSetup();
    await controller.submitSetup("a".repeat(11), "a".repeat(11));
    expect(controller.getState()).toEqual({ phase: "setup", busy: false, error: "主密碼至少需要 12 個字元" });
    expect(storage.initialize).not.toHaveBeenCalled();
  });

  test("成功：以主密碼呼叫 initialize 後進入登入並提示；此時尚無 session，不啟動閒置計時", async () => {
    const { controller, storage, idleTimer, bindActivity } = await bootToSetup();
    await controller.submitSetup(PASSWORD, PASSWORD);
    expect(storage.initialize).toHaveBeenCalledWith(PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "主密碼已設定完成，請登入" });
    expect(idleTimer.start).not.toHaveBeenCalled();
    expect(bindActivity).not.toHaveBeenCalled();
  });

  test("initialize 失敗：停留在首次設定並顯示通用錯誤", async () => {
    const { controller } = await bootToSetup({
      initialize: vi.fn<AuthStorage["initialize"]>(async () => {
        throw new DOMException("ConstraintError");
      }),
    });
    await controller.submitSetup(PASSWORD, PASSWORD);
    expect(controller.getState()).toEqual({
      phase: "setup",
      busy: false,
      error: "操作失敗，現有資料未被變更，請重試",
    });
  });
});

describe("登入（§4.1、AC6）", () => {
  test("主密碼錯誤：顯示含備份還原提示的錯誤，不啟動閒置計時", async () => {
    const { controller, idleTimer } = await bootToLogin({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: false, reason: "INVALID_MASTER_PASSWORD" })),
    });
    await controller.submitLogin("wrong password!!");
    expect(controller.getState()).toMatchObject({
      phase: "login",
      error: "主密碼錯誤。若確認密碼無誤，資料可能已損毀，可從備份檔匯入還原。",
      lockedUntil: null,
    });
    expect(idleTimer.start).not.toHaveBeenCalled();
  });

  test("LOCKED：記錄鎖定期限；鎖定期間再次送出不會呼叫 login", async () => {
    const login = vi.fn<AuthStorage["login"]>(async () => ({ ok: false, reason: "LOCKED", waitSeconds: 30 }));
    const { controller } = await bootToLogin({ login });
    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "login", error: null, lockedUntil: NOW + 30_000 });

    await controller.submitLogin(PASSWORD);
    expect(login).toHaveBeenCalledTimes(1);
  });

  test("不需第二因素：進入 authenticated，啟動閒置計時並綁定活動監聽各一次", async () => {
    const { controller, idleTimer, bindActivity } = await bootToLogin();
    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toEqual({ phase: "authenticated" });
    expect(idleTimer.start).toHaveBeenCalledTimes(1);
    expect(bindActivity).toHaveBeenCalledTimes(1);
  });

  test("需第二因素：主密碼通過當下即啟動閒置計時並綁定（尚未完成第二因素）", async () => {
    const { controller, idleTimer, bindActivity } = await bootToSecondFactor();
    expect(controller.getState()).toMatchObject({ phase: "secondFactor", method: "totp" });
    expect(idleTimer.start).toHaveBeenCalledTimes(1);
    expect(bindActivity).toHaveBeenCalledTimes(1);
  });

  test("login 發生未預期錯誤：顯示通用錯誤", async () => {
    const { controller } = await bootToLogin({
      login: vi.fn<AuthStorage["login"]>(async () => {
        throw new Error("boom");
      }),
    });
    await controller.submitLogin(PASSWORD);
    expect(controller.getState()).toMatchObject({ phase: "login", error: "操作失敗，現有資料未被變更，請重試" });
  });
});

describe("第二因素（§4.2、AC2）", () => {
  test("TOTP：去除空白後以 { totpCode } 送出；成功進入 authenticated，且不重複啟動計時或綁定", async () => {
    const { controller, storage, idleTimer, bindActivity } = await bootToSecondFactor();
    await controller.submitSecondFactor(" 123 456 ");
    expect(storage.verifySecondFactor).toHaveBeenCalledWith({ totpCode: "123456" });
    expect(controller.getState()).toEqual({ phase: "authenticated" });
    expect(idleTimer.start).toHaveBeenCalledTimes(1);
    expect(bindActivity).toHaveBeenCalledTimes(1);
  });

  test("TOTP 與救援碼失敗文案不同；切換方式後以 { recoveryCode } 送出", async () => {
    const verifySecondFactor = vi.fn<AuthStorage["verifySecondFactor"]>(async (input) =>
      "totpCode" in input
        ? { ok: false, reason: "INVALID_TOTP_CODE" }
        : { ok: false, reason: "INVALID_RECOVERY_CODE" }
    );
    const { controller } = await bootToSecondFactor({ verifySecondFactor });

    await controller.submitSecondFactor("000000");
    expect(controller.getState()).toMatchObject({ error: "驗證碼錯誤" });

    controller.switchSecondFactorMethod("recovery");
    expect(controller.getState()).toMatchObject({ method: "recovery", error: null });
    await controller.submitSecondFactor("ABCD-EF01-2345-6789");
    expect(verifySecondFactor).toHaveBeenLastCalledWith({ recoveryCode: "ABCD-EF01-2345-6789" });
    expect(controller.getState()).toMatchObject({ error: "救援碼無效或已使用過" });
  });

  test("LOCKED：記錄鎖定期限，鎖定期間不再送出", async () => {
    const verifySecondFactor = vi.fn<AuthStorage["verifySecondFactor"]>(async () => ({
      ok: false,
      reason: "LOCKED",
      waitSeconds: 8,
    }));
    const { controller } = await bootToSecondFactor({ verifySecondFactor });
    await controller.submitSecondFactor("123456");
    expect(controller.getState()).toMatchObject({ phase: "secondFactor", lockedUntil: NOW + 8_000, error: null });

    await controller.submitSecondFactor("123456");
    expect(verifySecondFactor).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["NOT_AUTHENTICATED", "驗證已逾時，請重新輸入主密碼"],
    ["KEY_GENERATION_MISMATCH", "保險庫資料已在其他地方變更，請重新登入"],
  ] as const)("%s：回到登入並提示，清除 session、停止計時並解除綁定", async (code, notice) => {
    const { controller, storage, idleTimer, unbind } = await bootToSecondFactor({
      verifySecondFactor: vi.fn<AuthStorage["verifySecondFactor"]>(async () => {
        throw new StorageError(code, "x");
      }),
    });
    await controller.submitSecondFactor("123456");
    expect(controller.getState()).toMatchObject({ phase: "login", notice });
    expect(storage.logout).toHaveBeenCalled();
    expect(idleTimer.stop).toHaveBeenCalled();
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  test("返回登入：清除暫存金鑰（logout）、停止計時、解除綁定", async () => {
    const { controller, storage, idleTimer, unbind } = await bootToSecondFactor();
    controller.cancelSecondFactor();
    expect(controller.getState()).toMatchObject({ phase: "login", notice: null });
    expect(storage.logout).toHaveBeenCalledTimes(1);
    expect(idleTimer.stop).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);
  });
});

describe("登出與閒置逾時（§5.1.4、AC9）", () => {
  test("手動登出：logout、stop、unbind 後回到登入並提示已登出", async () => {
    const { controller, storage, idleTimer, unbind } = await bootToLogin();
    await controller.submitLogin(PASSWORD);
    controller.logout();
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "已登出" });
    expect(storage.logout).toHaveBeenCalledTimes(1);
    expect(idleTimer.stop).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  test("已解鎖時閒置逾時：清除 session 並回到登入；再次登入時重新綁定，不會重複綁定", async () => {
    const { controller, storage, idleTimer, bindActivity, unbind } = await bootToLogin();
    await controller.submitLogin(PASSWORD);
    controller.handleIdleTimeout();
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "閒置逾時，已自動鎖定" });
    expect(storage.logout).toHaveBeenCalledTimes(1);
    expect(idleTimer.stop).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);

    await controller.submitLogin(PASSWORD);
    expect(bindActivity).toHaveBeenCalledTimes(2);
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  test("第二因素階段閒置逾時同樣清除暫存金鑰並回到登入", async () => {
    const { controller, storage } = await bootToSecondFactor();
    controller.handleIdleTimeout();
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "閒置逾時，已自動鎖定" });
    expect(storage.logout).toHaveBeenCalledTimes(1);
  });

  test("尚未解鎖時的逾時通知不影響畫面", async () => {
    const { controller, storage } = await bootToLogin();
    const before = controller.getState();
    controller.handleIdleTimeout();
    expect(controller.getState()).toBe(before);
    expect(storage.logout).not.toHaveBeenCalled();
  });
});

describe("登入頁匯入覆蓋（§5.3、AC16）", () => {
  test("確認字串不符：由 Service 層拒絕並顯示對應文案，停留在確認步驟", async () => {
    const { controller, storage } = await bootToLogin();
    controller.beginImport();
    await controller.submitImportConfirmation("overwrite");
    expect(storage.startPreLoginImport).toHaveBeenCalledWith({ confirmation: "overwrite" });
    expect(controller.getState()).toEqual({
      phase: "importConfirm",
      busy: false,
      error: "請輸入大寫的 OVERWRITE（不含空白）",
    });
  });

  test("選檔時即檢查格式與版本（§5.3 步驟 1）：不合法的檔案顯示文案且不可送出", async () => {
    const { controller, storage } = await bootToLogin();
    controller.beginImport();
    await controller.submitImportConfirmation("OVERWRITE");

    await controller.selectImportFile(fileOf("not json"));
    expect(controller.getState()).toMatchObject({ fileName: null, error: "檔案格式不正確，不是有效的備份檔" });

    const tooNew = JSON.parse(VALID_FILE);
    tooNew.header.cryptoVersion = 99;
    await controller.selectImportFile(fileOf(JSON.stringify(tooNew)));
    expect(controller.getState()).toMatchObject({
      fileName: null,
      error: "此備份檔的版本較新，請先更新本應用程式後再匯入",
    });

    await controller.submitImport(PASSWORD);
    expect(storage.importVault).not.toHaveBeenCalled();
  });

  test("成功：以許可、檔案內容與備份密碼呼叫 importVault；回到登入並提示，停止閒置計時", async () => {
    const { controller, storage, idleTimer } = await bootToImportFile();
    expect(controller.getState()).toMatchObject({ phase: "importFile", fileName: "backup.json" });

    await controller.submitImport(PASSWORD);
    expect(storage.importVault).toHaveBeenCalledWith({
      fileContent: VALID_FILE,
      password: PASSWORD,
      ticket: { kind: "pre-login-import" },
    });
    expect(controller.getState()).toMatchObject({ phase: "login", notice: "匯入完成，請以備份檔當時的主密碼登入" });
    expect(idleTimer.stop).toHaveBeenCalled();
  });

  test.each([
    ["INVALID_FORMAT", "檔案格式不正確，不是有效的備份檔"],
    ["UNSUPPORTED_VERSION", "此備份檔的版本較新，請先更新本應用程式後再匯入"],
    ["DECRYPTION_FAILED", "備份檔當時的主密碼錯誤，或檔案已損毀（兩者無法區分）"],
    ["INVALID_CONTENT", "備份檔內容不完整或已損毀，無法匯入"],
    ["CONFIRMATION_MISMATCH", "請輸入大寫的 OVERWRITE（不含空白）"],
  ] satisfies [ImportErrorCode, string][])("importVault 拋出 %s：停留在選檔步驟並顯示對應文案", async (code, message) => {
    const { controller } = await bootToImportFile({
      importVault: vi.fn<AuthStorage["importVault"]>(async () => {
        throw new ImportError(code, "x");
      }),
    });
    await controller.submitImport(PASSWORD);
    expect(controller.getState()).toEqual({
      phase: "importFile",
      busy: false,
      error: message,
      fileName: "backup.json",
    });
  });

  test("CONFIRMATION_REQUIRED：許可已失效，回到確認步驟並提示", async () => {
    const { controller } = await bootToImportFile({
      importVault: vi.fn<AuthStorage["importVault"]>(async () => {
        throw new ImportError("CONFIRMATION_REQUIRED", "x");
      }),
    });
    await controller.submitImport(PASSWORD);
    expect(controller.getState()).toEqual({
      phase: "importConfirm",
      busy: false,
      error: "匯入許可已失效，請重新輸入確認字串",
    });
  });

  test("REKEY_IN_PROGRESS 與未預期錯誤：顯示對應文案", async () => {
    const rekeying = await bootToImportFile({
      importVault: vi.fn<AuthStorage["importVault"]>(async () => {
        throw new StorageError("REKEY_IN_PROGRESS", "x");
      }),
    });
    await rekeying.controller.submitImport(PASSWORD);
    expect(rekeying.controller.getState()).toMatchObject({ error: "系統正在更新加密金鑰，請稍後再試" });

    const broken = await bootToImportFile({
      importVault: vi.fn<AuthStorage["importVault"]>(async () => {
        throw new DOMException("UnknownError");
      }),
    });
    await broken.controller.submitImport(PASSWORD);
    expect(broken.controller.getState()).toMatchObject({ error: "操作失敗，現有資料未被變更，請重試" });
  });

  test("取消：回到登入；再次匯入須重新確認，舊許可不會被沿用", async () => {
    const { controller, storage } = await bootToImportFile();
    controller.cancelImport();
    expect(controller.getState()).toMatchObject({ phase: "login", notice: null });

    controller.beginImport();
    expect(controller.getState().phase).toBe("importConfirm");
    await controller.submitImport(PASSWORD);
    expect(storage.importVault).not.toHaveBeenCalled();
  });
});
