// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/ui/App";
import { createAuthController, type AuthStorage } from "../../src/ui/auth/authController";
import {
  createSecurityController,
  type DownloadFile,
  type SecurityController,
  type SecurityStorage,
} from "../../src/ui/security/securityController";
import { SecurityScreen } from "../../src/ui/security/SecurityScreen";
import {
  ALL_SECRETS,
  CURRENT_PASSWORD,
  NEW_BATCH_CODES,
  NEW_PASSWORD,
  SETUP_CODES,
  SETUP_QR,
  SETUP_SECRET,
  VALID_RECOVERY_CODE,
  VALID_TOTP,
  createFakeSecurity,
} from "./_shared/securityFakes";
import { createFakeVault, deferred } from "./_shared/entriesFakes";

/**
 * 模組：安全設定畫面（React 元件，jsdom）
 * 以真實安全設定控制器 + 假 storage 驗證：依 2FA 狀態顯示的操作、變更主密碼的處理中與失敗文案、
 * 開啟 2FA 三步驟與「未確認保存救援碼不可前進／不可關閉」、補發的「新碼尚未生效」提示、
 * 關閉 2FA 的警示、匯出說明、導覽鎖定、beforeunload，以及秘密在畫面關閉後不殘留於 DOM／history。
 */

const controllers: SecurityController[] = [];

async function renderScreen(options: Parameters<typeof createFakeSecurity>[0] = {}) {
  const fake = createFakeSecurity(options);
  const download = vi.fn<(file: DownloadFile) => void>();
  const onLogout = vi.fn();
  const controller = createSecurityController({ storage: fake.storage, download, yieldToPaint: async () => undefined });
  controllers.push(controller);
  await controller.load();
  render(<SecurityScreen controller={controller} onLogout={onLogout} />);
  return { ...fake, controller, download, onLogout, user: userEvent.setup() };
}

const section = (name: string) => screen.getByRole("region", { name });
const dialog = (name: string) => screen.getByRole("dialog", { name });
const logoutButton = () => screen.getByRole("button", { name: "登出" }) as HTMLButtonElement;

function domHasSecrets(): boolean {
  const html = document.body.innerHTML;
  return ALL_SECRETS.some((secret) => html.includes(secret));
}

async function goToEnableCodes(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "開啟兩步驟驗證" }));
  const enable = await screen.findByRole("dialog", { name: "開啟兩步驟驗證" });
  await user.click(within(enable).getByRole("button", { name: "下一步" }));
  return enable;
}

afterEach(() => {
  cleanup();
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("狀態與可用操作", () => {
  test("2FA 未開啟：只提供開啟；已開啟：提供補發與關閉，剩餘 ≤ 2 組時提示補發", async () => {
    await renderScreen();
    const off = within(section("兩步驟驗證"));
    expect(off.getByText("未開啟")).toBeTruthy();
    expect(off.getByRole("button", { name: "開啟兩步驟驗證" })).toBeTruthy();
    expect(off.queryByRole("button", { name: "關閉兩步驟驗證" })).toBeNull();
    expect(off.queryByRole("button", { name: "補發救援碼" })).toBeNull();
    cleanup();

    await renderScreen({ twoFactorEnabled: true, unusedRecoveryCodes: 2 });
    const on = within(section("兩步驟驗證"));
    expect(on.getByText("已開啟（剩餘 2 組未使用的救援碼）")).toBeTruthy();
    expect(on.getByText("剩餘未使用的救援碼僅 2 組，建議補發")).toBeTruthy();
    expect(on.queryByRole("button", { name: "開啟兩步驟驗證" })).toBeNull();
    expect(on.getByRole("button", { name: "補發救援碼" })).toBeTruthy();
    expect(on.getByRole("button", { name: "關閉兩步驟驗證" })).toBeTruthy();
  });

  test("剩餘 3 組以上不提示；操作進行中其他操作按鈕停用", async () => {
    const { user } = await renderScreen({ twoFactorEnabled: true, unusedRecoveryCodes: 3 });
    expect(screen.queryByText(/建議補發/)).toBeNull();
    await user.click(within(section("主密碼")).getByRole("button", { name: "變更主密碼" }));
    expect((within(section("備份")).getByRole("button", { name: "匯出加密備份" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("變更主密碼", () => {
  test("三個欄位預設遮罩可切換顯示；即時提示長度與不一致；成功後關閉並提示", async () => {
    const { user, storage } = await renderScreen();
    await user.click(within(section("主密碼")).getByRole("button", { name: "變更主密碼" }));
    const form = dialog("變更主密碼");
    const fields = ["目前主密碼", "新主密碼", "再次輸入新主密碼"].map((label) => within(form).getByLabelText(label) as HTMLInputElement);
    expect(document.activeElement).toBe(fields[0]);
    for (const field of fields) expect(field.type).toBe("password");
    await user.click(within(form).getByRole("button", { name: "顯示密碼" }));
    for (const field of fields) expect(field.type).toBe("text");
    await user.click(within(form).getByRole("button", { name: "隱藏密碼" }));

    await user.type(fields[0], CURRENT_PASSWORD);
    await user.type(fields[1], "short");
    expect(within(form).getByText("新主密碼至少需要 12 個字元")).toBeTruthy();
    await user.clear(fields[1]);
    await user.type(fields[1], NEW_PASSWORD);
    await user.type(fields[2], "different pass 2026");
    expect(within(form).getByText("兩次輸入的新主密碼不一致")).toBeTruthy();
    await user.clear(fields[2]);
    await user.type(fields[2], NEW_PASSWORD);

    await user.click(within(form).getByRole("button", { name: "變更主密碼" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.changeMasterPassword).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(screen.getByText("主密碼已變更。先前匯出的備份檔仍需以舊主密碼還原，建議重新匯出備份。")).toBeTruthy();
    expect(domHasSecrets()).toBe(false);
  });

  test("rekey 進行中：顯示處理中文案，所有欄位與按鈕停用，Esc 不關閉，登出停用", async () => {
    const gate = deferred<void>();
    const { user } = await renderScreen({ overrides: { changeMasterPassword: vi.fn(() => gate.promise) } });
    await user.click(within(section("主密碼")).getByRole("button", { name: "變更主密碼" }));
    const form = dialog("變更主密碼");
    await user.type(within(form).getByLabelText("目前主密碼"), CURRENT_PASSWORD);
    await user.type(within(form).getByLabelText("新主密碼"), NEW_PASSWORD);
    await user.type(within(form).getByLabelText("再次輸入新主密碼"), NEW_PASSWORD);
    await user.click(within(form).getByRole("button", { name: "變更主密碼" }));

    expect(
      await within(form).findByText("正在以新主密碼重新加密所有資料，請勿關閉或重新整理分頁…")
    ).toBeTruthy();
    for (const button of within(form).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByLabelText("新主密碼") as HTMLInputElement).disabled).toBe(true);
    expect(logoutButton().disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(dialog("變更主密碼")).toBeTruthy();

    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(logoutButton().disabled).toBe(false);
  });

  test("目前主密碼錯誤：對話框內明確顯示未變更，可重試", async () => {
    const { user } = await renderScreen();
    await user.click(within(section("主密碼")).getByRole("button", { name: "變更主密碼" }));
    const form = dialog("變更主密碼");
    await user.type(within(form).getByLabelText("目前主密碼"), "wrong current password");
    await user.type(within(form).getByLabelText("新主密碼"), NEW_PASSWORD);
    await user.type(within(form).getByLabelText("再次輸入新主密碼"), NEW_PASSWORD);
    await user.click(within(form).getByRole("button", { name: "變更主密碼" }));

    expect((await within(form).findByRole("alert")).textContent).toBe("主密碼未變更：目前主密碼錯誤");
    expect((within(form).getByRole("button", { name: "變更主密碼" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("開啟 2FA：QR → 保存救援碼 → 輸入驗證碼", () => {
  test("完整流程：顯示 QR 與可讀的秘鑰；未勾選時「下一步」停用；輸入驗證碼後開啟；秘密自 DOM 移除", async () => {
    const { user, storage, download } = await renderScreen();
    await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "開啟兩步驟驗證" }));
    const enable = await screen.findByRole("dialog", { name: "開啟兩步驟驗證" });

    expect(within(enable).getByText("步驟 1／3：綁定驗證器")).toBeTruthy();
    expect(within(enable).getByRole("img", { name: "兩步驟驗證 QR code" }).getAttribute("src")).toBe(SETUP_QR);
    expect(within(enable).getByTestId("totp-secret").textContent?.replace(/\s/g, "")).toBe(SETUP_SECRET);

    await user.click(within(enable).getByRole("button", { name: "下一步" }));
    expect(within(enable).getByText("步驟 2／3：保存救援碼")).toBeTruthy();
    const listed = within(within(enable).getByRole("list", { name: "救援碼" })).getAllByRole("listitem");
    expect(listed.map((item) => item.textContent)).toEqual(SETUP_CODES);
    expect(within(enable).queryByRole("button", { name: /複製/ })).toBeNull();

    await user.click(within(enable).getByRole("button", { name: "下載為文字檔" }));
    expect(download).toHaveBeenCalledTimes(1);

    const next = within(enable).getByRole("button", { name: "下一步" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.click(within(enable).getByLabelText("我已將這 10 組救援碼抄錄或下載，並存放在安全的地方"));
    expect(next.disabled).toBe(false);
    await user.click(next);

    expect(within(enable).getByText("步驟 3／3：輸入驗證碼")).toBeTruthy();
    await user.type(within(enable).getByLabelText("驗證碼"), VALID_TOTP);
    await user.click(within(enable).getByRole("button", { name: "確認並開啟" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.confirmTwoFactorSetup).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已開啟兩步驟驗證。下次登入時需要輸入驗證碼。")).toBeTruthy();
    expect(within(section("兩步驟驗證")).getByText("已開啟（剩餘 10 組未使用的救援碼）")).toBeTruthy();
    expect(domHasSecrets()).toBe(false);
    expect(document.querySelector(`img[src="${SETUP_QR}"]`)).toBeNull();
  });

  test("未確認保存就想關閉：Esc 無效、沒有「取消」或關閉按鈕；「放棄」需再次確認，選「繼續設定」回到原畫面", async () => {
    const { user, storage } = await renderScreen();
    const enable = await goToEnableCodes(user);

    await user.keyboard("{Escape}");
    expect(dialog("開啟兩步驟驗證")).toBeTruthy();
    expect(within(enable).queryByRole("button", { name: /取消|關閉/ })).toBeNull();
    expect(logoutButton().disabled).toBe(true);

    await user.click(within(enable).getByRole("button", { name: "放棄" }));
    expect(within(enable).getByText("放棄後兩步驟驗證不會開啟，這批救援碼作廢。")).toBeTruthy();
    expect(document.activeElement).toBe(within(enable).getByRole("button", { name: "繼續設定" }));
    await user.click(within(enable).getByRole("button", { name: "繼續設定" }));
    expect(within(enable).getByText("步驟 2／3：保存救援碼")).toBeTruthy();
    expect(within(enable).getByText(SETUP_CODES[0])).toBeTruthy();

    await user.click(within(enable).getByRole("button", { name: "放棄" }));
    await user.click(within(enable).getByRole("button", { name: "確定放棄" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已放棄開啟兩步驟驗證，未做任何變更。")).toBeTruthy();
    expect(storage.confirmTwoFactorSetup).not.toHaveBeenCalled();
    expect(domHasSecrets()).toBe(false);
    expect(logoutButton().disabled).toBe(false);
  });

  test("驗證碼錯誤：留在步驟 3 顯示錯誤；可回上一步再看 QR code", async () => {
    const { user } = await renderScreen();
    const enable = await goToEnableCodes(user);
    await user.click(within(enable).getByLabelText(/我已將這 10 組救援碼/));
    await user.click(within(enable).getByRole("button", { name: "下一步" }));
    await user.type(within(enable).getByLabelText("驗證碼"), "000000");
    await user.click(within(enable).getByRole("button", { name: "確認並開啟" }));

    expect((await within(enable).findByRole("alert")).textContent).toContain("兩步驟驗證尚未開啟");
    await user.click(within(enable).getByRole("button", { name: "上一步" }));
    await user.click(within(enable).getByRole("button", { name: "上一步" }));
    expect(within(enable).getByRole("img", { name: "兩步驟驗證 QR code" })).toBeTruthy();
  });
});

describe("補發救援碼", () => {
  test("驗證後頂端固定顯示「新碼尚未生效」；未勾選不可確認取代；確認後提示舊碼失效", async () => {
    const { user, storage } = await renderScreen({ twoFactorEnabled: true });
    await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "補發救援碼" }));
    const regen = dialog("補發救援碼");
    expect(within(regen).getByText(/若已遺失驗證器，請改用救援碼關閉兩步驟驗證/)).toBeTruthy();

    await user.type(within(regen).getByLabelText("主密碼"), CURRENT_PASSWORD);
    await user.type(within(regen).getByLabelText("驗證碼"), VALID_TOTP);
    await user.click(within(regen).getByRole("button", { name: "驗證並產生新救援碼" }));

    expect(await within(regen).findByText("新救援碼尚未生效。按下「確認取代」前，舊救援碼仍然有效。")).toBeTruthy();
    expect(within(regen).getByText(NEW_BATCH_CODES[0])).toBeTruthy();
    const confirm = within(regen).getByRole("button", { name: "確認取代" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(dialog("補發救援碼")).toBeTruthy();

    await user.click(within(regen).getByLabelText(/我已將這 10 組救援碼/));
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.commitRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已補發新救援碼，舊救援碼已全部失效。")).toBeTruthy();
    expect(domHasSecrets()).toBe(false);
  });

  test("放棄補發：再次確認的文案說明舊碼仍有效；不提交", async () => {
    const { user, storage } = await renderScreen({ twoFactorEnabled: true });
    await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "補發救援碼" }));
    const regen = dialog("補發救援碼");
    await user.type(within(regen).getByLabelText("主密碼"), CURRENT_PASSWORD);
    await user.type(within(regen).getByLabelText("驗證碼"), VALID_TOTP);
    await user.click(within(regen).getByRole("button", { name: "驗證並產生新救援碼" }));
    await within(regen).findByText(NEW_BATCH_CODES[0]);

    await user.click(within(regen).getByRole("button", { name: "放棄" }));
    expect(within(regen).getByText("放棄後新救援碼作廢，舊救援碼仍然有效。")).toBeTruthy();
    await user.click(within(regen).getByRole("button", { name: "確定放棄" }));
    expect(screen.getByText("已放棄補發，舊救援碼仍然有效。")).toBeTruthy();
    expect(storage.commitRecoveryCodes).not.toHaveBeenCalled();
  });
});

describe("關閉 2FA", () => {
  test("顯示警示；可切換救援碼輸入；成功後狀態改為未開啟", async () => {
    const { user, storage } = await renderScreen({ twoFactorEnabled: true });
    await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "關閉兩步驟驗證" }));
    const form = dialog("關閉兩步驟驗證");
    expect(
      within(form).getByText("關閉後，登入僅靠主密碼保護；現有救援碼全部作廢；日後重新開啟需重新綁定驗證器。")
    ).toBeTruthy();
    expect((within(form).getByLabelText("主密碼") as HTMLInputElement).type).toBe("password");

    await user.click(within(form).getByRole("button", { name: "改用救援碼" }));
    await user.type(within(form).getByLabelText("主密碼"), CURRENT_PASSWORD);
    await user.type(within(form).getByLabelText("救援碼"), VALID_RECOVERY_CODE);
    await user.click(within(form).getByRole("button", { name: "關閉兩步驟驗證" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.disableTwoFactor).toHaveBeenCalledWith(CURRENT_PASSWORD, { recoveryCode: VALID_RECOVERY_CODE });
    expect(within(section("兩步驟驗證")).getByText("未開啟")).toBeTruthy();
  });

  test("鎖定時顯示剩餘秒數並停用送出；可取消", async () => {
    const { user } = await renderScreen({
      twoFactorEnabled: true,
      overrides: {
        disableTwoFactor: vi.fn<SecurityStorage["disableTwoFactor"]>(async () => ({ ok: false, reason: "LOCKED", waitSeconds: 8 })),
      },
    });
    await user.click(within(section("兩步驟驗證")).getByRole("button", { name: "關閉兩步驟驗證" }));
    const form = dialog("關閉兩步驟驗證");
    await user.type(within(form).getByLabelText("主密碼"), CURRENT_PASSWORD);
    await user.type(within(form).getByLabelText("驗證碼"), VALID_TOTP);
    await user.click(within(form).getByRole("button", { name: "關閉兩步驟驗證" }));

    expect((await within(form).findByRole("alert")).textContent).toMatch(/驗證嘗試次數過多，請於 \d+ 秒後再試/);
    expect((within(form).getByRole("button", { name: "關閉兩步驟驗證" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(form).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("匯出", () => {
  test("說明為加密備份與需要匯出當下的主密碼；下載後提示檔名", async () => {
    const { user, download } = await renderScreen();
    expect(within(section("備份")).getByText(/匯出的是加密備份檔，不是明文/)).toBeTruthy();
    await user.click(within(section("備份")).getByRole("button", { name: "匯出加密備份" }));
    const form = dialog("匯出加密備份");
    expect(within(form).getByText(/需要輸入「匯出當下的主密碼」/)).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "下載加密備份" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(download).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^已下載加密備份檔：password-keeper-backup-/)).toBeTruthy();
  });
});

describe("離頁保護與敏感資料", () => {
  test("beforeunload 只在寫入進行中攔截；秘密顯示但未寫入時不攔截", async () => {
    const gate = deferred<void>();
    const { user } = await renderScreen({ overrides: { changeMasterPassword: vi.fn(() => gate.promise) } });
    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);

    await user.click(within(section("主密碼")).getByRole("button", { name: "變更主密碼" }));
    const form = dialog("變更主密碼");
    await user.type(within(form).getByLabelText("目前主密碼"), CURRENT_PASSWORD);
    await user.type(within(form).getByLabelText("新主密碼"), NEW_PASSWORD);
    await user.type(within(form).getByLabelText("再次輸入新主密碼"), NEW_PASSWORD);
    await user.click(within(form).getByRole("button", { name: "變更主密碼" }));
    await within(form).findByText("正在以新主密碼重新加密所有資料，請勿關閉或重新整理分頁…");
    expect(fire()).toBe(true);

    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fire()).toBe(false);

    await goToEnableCodes(user);
    expect(fire()).toBe(false);
  });

  test("流程不寫入瀏覽器 history；console 不含任何秘密", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const historyLength = window.history.length;
    const { user } = await renderScreen();
    const enable = await goToEnableCodes(user);
    await user.click(within(enable).getByLabelText(/我已將這 10 組救援碼/));
    await user.click(within(enable).getByRole("button", { name: "下一步" }));
    await user.type(within(enable).getByLabelText("驗證碼"), VALID_TOTP);
    await user.click(within(enable).getByRole("button", { name: "確認並開啟" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(window.history.length).toBe(historyLength);
    expect(window.history.state).toBeNull();
    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const secret of ALL_SECRETS) expect(output).not.toContain(secret);
  });
});

describe("App 整合：分頁導覽", () => {
  function createAuthStorage(): AuthStorage {
    return {
      isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => true),
      initialize: vi.fn<AuthStorage["initialize"]>(async () => undefined),
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: false })),
      verifySecondFactor: vi.fn<AuthStorage["verifySecondFactor"]>(async () => ({ ok: true })),
      logout: vi.fn<AuthStorage["logout"]>(),
      startPreLoginImport: vi.fn<AuthStorage["startPreLoginImport"]>(async () => ({ kind: "pre-login-import" })),
      importVault: vi.fn<AuthStorage["importVault"]>(async () => undefined),
    };
  }

  async function renderApp() {
    const authStorage = createAuthStorage();
    const authController = createAuthController({
      storage: authStorage,
      idleTimer: { start: vi.fn(), stop: vi.fn() },
      bindActivity: () => () => undefined,
    });
    const vault = createFakeVault();
    const security = createFakeSecurity();
    render(<App controller={authController} storage={{ ...vault.storage, ...security.storage }} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("主密碼"), CURRENT_PASSWORD);
    await user.click(screen.getByRole("button", { name: "解鎖" }));
    await screen.findByRole("heading", { level: 2, name: "GitHub" });
    return { user, authStorage, vault, security };
  }

  const nav = () => within(screen.getByRole("navigation", { name: "主要導覽" }));

  test("解鎖後預設為密碼庫；切到安全設定再切回，列表的搜尋狀態保留且不重新讀取", async () => {
    const { user, vault } = await renderApp();
    expect(nav().getByRole("button", { name: "密碼庫" }).getAttribute("aria-current")).toBe("page");

    await user.type(screen.getByLabelText("搜尋"), "alice");
    await user.click(nav().getByRole("button", { name: "安全設定" }));
    expect(await screen.findByRole("heading", { level: 1, name: "安全設定" })).toBeTruthy();
    expect(nav().getByRole("button", { name: "安全設定" }).getAttribute("aria-current")).toBe("page");

    await user.click(nav().getByRole("button", { name: "密碼庫" }));
    expect((screen.getByLabelText("搜尋") as HTMLInputElement).value).toBe("alice");
    expect(vault.storage.loadEntries).toHaveBeenCalledTimes(1);
  });

  test("救援碼顯示中鎖定分頁切換與登出；放棄後解除；安全設定頁的登出回到登入畫面", async () => {
    const { user, authStorage } = await renderApp();
    await user.click(nav().getByRole("button", { name: "安全設定" }));
    await screen.findByRole("heading", { level: 1, name: "安全設定" });
    const enable = await goToEnableCodes(user);

    expect((nav().getByRole("button", { name: "密碼庫" }) as HTMLButtonElement).disabled).toBe(true);
    expect(logoutButton().disabled).toBe(true);

    await user.click(within(enable).getByRole("button", { name: "放棄" }));
    await user.click(within(enable).getByRole("button", { name: "確定放棄" }));
    expect((nav().getByRole("button", { name: "密碼庫" }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(logoutButton());
    expect(await screen.findByRole("heading", { name: "解鎖保險庫" })).toBeTruthy();
    expect(authStorage.logout).toHaveBeenCalledTimes(1);
    expect(domHasSecrets()).toBe(false);
  });
});
