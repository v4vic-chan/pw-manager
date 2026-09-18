// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthFlow } from "../../src/ui/auth/AuthFlow";
import { createAuthController, type AuthStorage } from "../../src/ui/auth/authController";
import { ImportError } from "../../src/services/importExport";

/**
 * 模組：登入／解鎖畫面（React 元件，jsdom）
 * 以真實控制器 + 假 storage 驗證畫面文案、按鈕停用狀態、遮罩輸入與完整操作路徑。
 */

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

function createStorage(overrides: Partial<AuthStorage> = {}): AuthStorage {
  return {
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
}

async function renderFlow(overrides: Partial<AuthStorage> = {}) {
  const storage = createStorage(overrides);
  const idleTimer = { start: vi.fn(), stop: vi.fn() };
  const controller = createAuthController({ storage, idleTimer, bindActivity: () => () => undefined });
  await controller.boot();
  render(<AuthFlow controller={controller} />);
  return { storage, idleTimer, controller, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("首次設定畫面（§4.1、AC11）", () => {
  test("兩個主密碼欄位皆為遮罩輸入；不一致時顯示錯誤；成功後切換到登入畫面並提示", async () => {
    const { user, storage } = await renderFlow({
      isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => false),
    });

    const password = screen.getByLabelText("主密碼");
    const confirmation = screen.getByLabelText("再次輸入主密碼");
    expect(password).toHaveProperty("type", "password");
    expect(confirmation).toHaveProperty("type", "password");

    await user.type(password, PASSWORD);
    await user.type(confirmation, `${PASSWORD}!`);
    await user.click(screen.getByRole("button", { name: "設定主密碼" }));
    expect((await screen.findByRole("alert")).textContent).toBe("兩次輸入的主密碼不一致");

    await user.clear(screen.getByLabelText("再次輸入主密碼"));
    await user.type(screen.getByLabelText("再次輸入主密碼"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "設定主密碼" }));

    expect(await screen.findByText("主密碼已設定完成，請登入")).toBeTruthy();
    expect(screen.getByRole("button", { name: "解鎖" })).toBeTruthy();
    expect(storage.initialize).toHaveBeenCalledWith(PASSWORD);
  });
});

describe("登入畫面（§4.1、AC6）", () => {
  test("主密碼錯誤時顯示含備份還原提示的錯誤", async () => {
    const { user } = await renderFlow({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: false, reason: "INVALID_MASTER_PASSWORD" })),
    });
    await user.type(screen.getByLabelText("主密碼"), "wrong password!!");
    await user.click(screen.getByRole("button", { name: "解鎖" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "主密碼錯誤。若確認密碼無誤，資料可能已損毀，可從備份檔匯入還原。"
    );
  });

  test("鎖定時顯示剩餘秒數並停用解鎖按鈕", async () => {
    const { user } = await renderFlow({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: false, reason: "LOCKED", waitSeconds: 30 })),
    });
    await user.type(screen.getByLabelText("主密碼"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "解鎖" }));

    expect((await screen.findByRole("alert")).textContent).toBe("嘗試次數過多，請於 30 秒後再試");
    expect(screen.getByRole("button", { name: "解鎖" })).toHaveProperty("disabled", true);
  });
});

describe("第二因素畫面（§4.2）", () => {
  test("TOTP 與救援碼可切換、失敗文案各自獨立；成功後進入已解鎖畫面，登出回到登入", async () => {
    const verifySecondFactor = vi
      .fn<AuthStorage["verifySecondFactor"]>()
      .mockResolvedValueOnce({ ok: false, reason: "INVALID_TOTP_CODE" })
      .mockResolvedValueOnce({ ok: false, reason: "INVALID_RECOVERY_CODE" })
      .mockResolvedValueOnce({ ok: true });
    const { user, idleTimer } = await renderFlow({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: true })),
      verifySecondFactor,
    });

    await user.type(screen.getByLabelText("主密碼"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "解鎖" }));
    await user.type(await screen.findByLabelText("驗證碼"), "000000");
    expect(idleTimer.start).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "驗證" }));
    expect((await screen.findByRole("alert")).textContent).toBe("驗證碼錯誤");

    await user.click(screen.getByRole("button", { name: "改用救援碼" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText("救援碼"), "ABCD-EF01-2345-6789");
    await user.click(screen.getByRole("button", { name: "驗證" }));
    expect((await screen.findByRole("alert")).textContent).toBe("救援碼無效或已使用過");

    await user.clear(screen.getByLabelText("救援碼"));
    await user.type(screen.getByLabelText("救援碼"), "1111-2222-3333-4444");
    await user.click(screen.getByRole("button", { name: "驗證" }));
    expect(await screen.findByRole("heading", { name: "已解鎖" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "登出" }));
    expect(await screen.findByText("已登出")).toBeTruthy();
    expect(idleTimer.stop).toHaveBeenCalled();
  });

  test("第二因素鎖定時顯示專屬文案並停用驗證按鈕；可返回登入", async () => {
    const { user, storage } = await renderFlow({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: true })),
      verifySecondFactor: vi.fn<AuthStorage["verifySecondFactor"]>(async () => ({
        ok: false,
        reason: "LOCKED",
        waitSeconds: 16,
      })),
    });
    await user.type(screen.getByLabelText("主密碼"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "解鎖" }));
    await user.type(await screen.findByLabelText("驗證碼"), "123456");
    await user.click(screen.getByRole("button", { name: "驗證" }));

    expect((await screen.findByRole("alert")).textContent).toBe("第二因素驗證嘗試次數過多，請於 16 秒後再試");
    expect(screen.getByRole("button", { name: "驗證" })).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "返回登入" }));
    expect(await screen.findByRole("button", { name: "解鎖" })).toBeTruthy();
    expect(storage.logout).toHaveBeenCalled();
  });
});

describe("登入頁匯入覆蓋（§5.3、AC16）", () => {
  async function openImport(overrides: Partial<AuthStorage> = {}) {
    const rendered = await renderFlow(overrides);
    await rendered.user.click(screen.getByRole("button", { name: "從備份檔匯入並覆蓋" }));
    return rendered;
  }

  test("顯示破壞性警示；「繼續」僅在確認字串與 OVERWRITE 完全相符時可按", async () => {
    const { user } = await openImport();
    expect(
      screen.getByText("匯入會清除並覆蓋此裝置上的所有資料，完成後主密碼將變為備份檔當時的主密碼")
    ).toBeTruthy();

    const input = screen.getByLabelText("確認字串");
    const proceed = screen.getByRole("button", { name: "繼續" });
    for (const value of ["overwrite", " OVERWRITE", "OVERWRITE "]) {
      await user.clear(input);
      await user.type(input, value);
      expect(proceed).toHaveProperty("disabled", true);
    }
    await user.clear(input);
    await user.type(input, "OVERWRITE");
    expect(proceed).toHaveProperty("disabled", false);
  });

  test("完整路徑：確認 → 選檔（不合法檔案即時提示）→ 輸入備份密碼 → 匯入完成後回到登入", async () => {
    const { user, storage } = await openImport();
    await user.type(screen.getByLabelText("確認字串"), "OVERWRITE");
    await user.click(screen.getByRole("button", { name: "繼續" }));

    const fileInput = await screen.findByLabelText("備份檔");
    await user.upload(fileInput, new File(["not json"], "broken.json", { type: "application/json" }));
    expect((await screen.findByRole("alert")).textContent).toBe("檔案格式不正確，不是有效的備份檔");
    expect(screen.getByRole("button", { name: "匯入並覆蓋" })).toHaveProperty("disabled", true);

    await user.upload(fileInput, new File([VALID_FILE], "backup.json", { type: "application/json" }));
    const backupPassword = await screen.findByLabelText("備份檔當時的主密碼");
    expect(backupPassword).toHaveProperty("type", "password");
    await user.type(backupPassword, PASSWORD);
    await user.click(screen.getByRole("button", { name: "匯入並覆蓋" }));

    expect(await screen.findByText("匯入完成，請以備份檔當時的主密碼登入")).toBeTruthy();
    expect(storage.importVault).toHaveBeenCalledWith({
      fileContent: VALID_FILE,
      password: PASSWORD,
      ticket: { kind: "pre-login-import" },
    });
  });

  test("備份密碼錯誤時顯示同時涵蓋密碼錯誤與檔案損毀的文案，可重試", async () => {
    const { user } = await openImport({
      importVault: vi.fn<AuthStorage["importVault"]>(async () => {
        throw new ImportError("DECRYPTION_FAILED", "x");
      }),
    });
    await user.type(screen.getByLabelText("確認字串"), "OVERWRITE");
    await user.click(screen.getByRole("button", { name: "繼續" }));
    await user.upload(await screen.findByLabelText("備份檔"), new File([VALID_FILE], "backup.json"));
    await user.type(await screen.findByLabelText("備份檔當時的主密碼"), "wrong password!!");
    await user.click(screen.getByRole("button", { name: "匯入並覆蓋" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "備份檔當時的主密碼錯誤，或檔案已損毀（兩者無法區分）"
    );
    expect(screen.getByRole("button", { name: "匯入並覆蓋" })).toHaveProperty("disabled", false);
  });
});

describe("敏感資料", () => {
  test("整段流程中 console 不含任何輸入過的密碼或救援碼", async () => {
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const { user } = await renderFlow({
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: true })),
    });
    await user.type(screen.getByLabelText("主密碼"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "解鎖" }));
    await user.click(await screen.findByRole("button", { name: "改用救援碼" }));
    await user.type(screen.getByLabelText("救援碼"), "ABCD-EF01-2345-6789");
    await user.click(screen.getByRole("button", { name: "驗證" }));
    await screen.findByRole("heading", { name: "已解鎖" });

    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain("ABCD-EF01-2345-6789");
  });
});
