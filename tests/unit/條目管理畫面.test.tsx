// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/ui/App";
import { createAuthController, type AuthStorage } from "../../src/ui/auth/authController";
import {
  SESSION_LOST_LOGOUT_MS,
  createEntriesController,
  type EntriesController,
  type EntriesStorage,
} from "../../src/ui/entries/entriesController";
import { EntriesScreen } from "../../src/ui/entries/EntriesScreen";
import { PASSWORD_CHARSET } from "../../src/ui/entries/passwordGenerator";
import { StorageError } from "../../src/services/storage";
import type { Entry } from "../../src/types/Entry";
import { ALL_PASSWORDS, ENTRIES, UNCATEGORIZED_ID, WORK_ID } from "./_shared/entriesFixtures";
import { createFakeVault, deferred } from "./_shared/entriesFakes";

/**
 * 模組：條目與分類管理畫面（React 元件，jsdom）
 * 對應規格 §4.4 條目 CRUD、§4.3 分類管理、§3.5／AC4「未分類」保護、§3.3 強度警示與欄位驗證。
 * 驗證：表單即時驗證與 storage 拒絕文案（兩層防呆）、密碼欄位遮罩／顯示／隨機產生、
 * 刪除的二次確認、「未分類」的操作按鈕根本不渲染、刪除分類的轉移提示、session 失效後自動登出。
 */

const GITHUB = ENTRIES[0];
const controllers: EntriesController[] = [];

async function renderScreen(vaultOptions: Parameters<typeof createFakeVault>[0] = {}) {
  const vault = createFakeVault(vaultOptions);
  const onSessionLost = vi.fn();
  const controller = createEntriesController({ storage: vault.storage, onSessionLost });
  controllers.push(controller);
  await controller.load();
  render(<EntriesScreen controller={controller} onLogout={vi.fn()} />);
  return { vault, storage: vault.storage, controller, onSessionLost, user: userEvent.setup() };
}

const entryList = () => screen.getByRole("list", { name: "條目列表" });
const listedNames = () => within(entryList()).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
const rowOf = (appName: string) =>
  within(entryList()).getByRole("heading", { level: 2, name: appName }).closest("li") as HTMLElement;
const panel = () => screen.getByRole("region", { name: "分類管理" });
const panelRows = () => within(within(panel()).getByRole("list", { name: "分類列表" })).getAllByRole("listitem");
const panelNames = () => panelRows().map((row) => row.querySelector(".category-name")?.textContent);
const panelRowOf = (name: string) => panelRows().find((row) => row.querySelector(".category-name")?.textContent === name) as HTMLElement;
const filterLabels = () =>
  within(screen.getByRole("group", { name: "依分類篩選" }))
    .getAllByRole("checkbox")
    .map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "新增條目" }));
  return screen.getByRole("dialog", { name: "新增條目" });
}

async function fillCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  values: { appName: string; accountId: string; password: string; category?: string }
) {
  await user.type(within(dialog).getByLabelText("App 名稱"), values.appName);
  await user.type(within(dialog).getByLabelText("帳號"), values.accountId);
  await user.type(within(dialog).getByLabelText("密碼"), values.password);
  if (values.category) await user.selectOptions(within(dialog).getByLabelText("分類"), values.category);
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "管理分類" }));
}

afterEach(() => {
  cleanup();
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("新增條目表單", () => {
  test("開啟後聚焦第一欄；密碼欄預設遮罩，可切換顯示；分類預設「未分類」且選項依序為 未分類／Email／Work", async () => {
    const { user } = await renderScreen();
    const dialog = await openCreateDialog(user);

    expect(document.activeElement).toBe(within(dialog).getByLabelText("App 名稱"));
    const password = within(dialog).getByLabelText("密碼");
    expect(password).toHaveProperty("type", "password");
    await user.click(within(dialog).getByRole("button", { name: "顯示密碼" }));
    expect(password).toHaveProperty("type", "text");
    await user.click(within(dialog).getByRole("button", { name: "隱藏密碼" }));
    expect(password).toHaveProperty("type", "password");

    const category = within(dialog).getByLabelText("分類") as HTMLSelectElement;
    expect(category.value).toBe(UNCATEGORIZED_ID);
    expect(within(category).getAllByRole("option").map((option) => option.textContent)).toEqual(["未分類", "Email", "Work"]);
  });

  test("即時驗證：未碰觸時不顯示錯誤；清空、超長、失焦後才提示，且不等 storage", async () => {
    const { user, storage } = await renderScreen();
    const dialog = await openCreateDialog(user);
    expect(within(dialog).queryByText("請輸入 App 名稱")).toBeNull();

    const appName = within(dialog).getByLabelText("App 名稱");
    await user.type(appName, "a");
    await user.clear(appName);
    expect(within(dialog).getByText("請輸入 App 名稱")).toBeTruthy();
    expect(appName.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(appName, { target: { value: "a".repeat(101) } });
    expect(within(dialog).getByText("App 名稱最多 100 個字元")).toBeTruthy();
    fireEvent.change(appName, { target: { value: "a".repeat(100) } });
    expect(within(dialog).queryByText(/App 名稱最多/)).toBeNull();

    await user.click(within(dialog).getByLabelText("帳號"));
    await user.tab();
    expect(within(dialog).getByText("請輸入帳號")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("帳號"), { target: { value: "a".repeat(201) } });
    expect(within(dialog).getByText("帳號最多 200 個字元")).toBeTruthy();

    expect(storage.addEntry).not.toHaveBeenCalled();
  });

  test("空表單直接送出：顯示全部必填錯誤、不呼叫 storage、對話框保持開啟", async () => {
    const { user, storage } = await renderScreen();
    const dialog = await openCreateDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect(within(dialog).getByText("請輸入 App 名稱")).toBeTruthy();
    expect(within(dialog).getByText("請輸入帳號")).toBeTruthy();
    expect(within(dialog).getByText("請輸入密碼")).toBeTruthy();
    expect(storage.addEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "新增條目" })).toBeTruthy();
  });

  test("密碼少於 8 個字元顯示強度警示（不阻擋儲存）；達 8 個字元後消失", async () => {
    const { user, storage } = await renderScreen();
    const dialog = await openCreateDialog(user);
    const warning = "密碼少於 8 個字元，強度偏弱（仍可儲存）";

    await user.type(within(dialog).getByLabelText("密碼"), "abc");
    expect(within(dialog).getByText(warning)).toBeTruthy();
    await user.type(within(dialog).getByLabelText("密碼"), "defgh");
    expect(within(dialog).queryByText(warning)).toBeNull();

    await user.clear(within(dialog).getByLabelText("密碼"));
    await user.type(within(dialog).getByLabelText("密碼"), "abc");
    await user.type(within(dialog).getByLabelText("App 名稱"), "Weak");
    await user.type(within(dialog).getByLabelText("帳號"), "weak@example.com");
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(storage.addEntry).toHaveBeenCalledTimes(1));
  });

  test("產生隨機密碼：20 字、字元皆在字元集內、留在遮罩欄位，可自行顯示；再次產生會不同", async () => {
    const { user } = await renderScreen();
    const dialog = await openCreateDialog(user);
    const field = within(dialog).getByLabelText("密碼") as HTMLInputElement;

    await user.click(within(dialog).getByRole("button", { name: "產生隨機密碼" }));
    const first = field.value;
    expect(first).toHaveLength(20);
    for (const char of first) expect(PASSWORD_CHARSET).toContain(char);
    expect(field.type).toBe("password");
    expect(within(dialog).queryByText("請輸入密碼")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "產生隨機密碼" }));
    expect(field.value).not.toBe(first);

    await user.click(within(dialog).getByRole("button", { name: "顯示密碼" }));
    expect(field.type).toBe("text");
  });

  test("成功新增：關閉對話框、列表出現新條目且密碼遮罩、DOM 不留輸入的明文、焦點回到「新增條目」", async () => {
    const { user, storage } = await renderScreen();
    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, {
      appName: "New App",
      accountId: "new@example.com",
      password: "pw-new-Zx81Qm",
      category: "Work",
    });
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.addEntry).toHaveBeenCalledWith(
      { appName: "New App", accountId: "new@example.com", password: "pw-new-Zx81Qm", categoryId: WORK_ID },
      expect.any(Array)
    );
    expect(listedNames()).toContain("New App");
    expect(within(rowOf("New App")).getByText("••••••••")).toBeTruthy();
    expect(within(rowOf("New App")).getByText("Work")).toBeTruthy();
    expect(screen.getByText("顯示 5 / 共 5 筆")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("pw-new-Zx81Qm");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "新增條目" }));
  });

  test("取消與 Esc 皆放棄輸入且不寫入；再次開啟是空白表單", async () => {
    const { user, storage } = await renderScreen();
    let dialog = await openCreateDialog(user);
    await user.type(within(dialog).getByLabelText("App 名稱"), "temp");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    dialog = await openCreateDialog(user);
    expect((within(dialog).getByLabelText("App 名稱") as HTMLInputElement).value).toBe("");
    await user.type(within(dialog).getByLabelText("App 名稱"), "temp2");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(storage.addEntry).not.toHaveBeenCalled();
  });

  test("storage 拒絕：對話框內顯示對應文案、保留已輸入內容、可再次送出", async () => {
    const { user } = await renderScreen({
      overrides: { addEntry: vi.fn<EntriesStorage["addEntry"]>(async () => Promise.reject(new RangeError("bad"))) },
    });
    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, { appName: "Keep Me", accountId: "keep@example.com", password: "pw-keep-1" });
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("輸入內容不符合規則，請檢查欄位後再試");
    expect((within(dialog).getByLabelText("App 名稱") as HTMLInputElement).value).toBe("Keep Me");
    expect((within(dialog).getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("寫入進行中：按鈕顯示「儲存中…」並停用，取消也不可用；完成後關閉", async () => {
    const gate = deferred<Entry>();
    const { user } = await renderScreen({
      overrides: { addEntry: vi.fn<EntriesStorage["addEntry"]>(() => gate.promise) },
    });
    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, { appName: "Slow", accountId: "slow@example.com", password: "pw-slow-1" });
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect((await within(dialog).findByRole("button", { name: "儲存中…" })) as HTMLButtonElement).toHaveProperty("disabled", true);
    expect((within(dialog).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => gate.resolve({ ...GITHUB, id: "slow" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("編輯條目表單", () => {
  test("帶入現有欄位；密碼欄留空並提示「留空表示不變更」，DOM 不含現有明文", async () => {
    const { user } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "編輯 GitHub" }));
    const dialog = screen.getByRole("dialog", { name: "編輯條目" });

    expect((within(dialog).getByLabelText("App 名稱") as HTMLInputElement).value).toBe("GitHub");
    expect((within(dialog).getByLabelText("帳號") as HTMLInputElement).value).toBe("alice@dev.io");
    expect((within(dialog).getByLabelText("分類") as HTMLSelectElement).value).toBe(WORK_ID);
    const password = within(dialog).getByLabelText("密碼") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toBe("留空表示不變更");
    expect(document.body.innerHTML).not.toContain(GITHUB.password);
  });

  test("只改 appName、密碼留空：列表更新，editEntry 的 changes 不含 password", async () => {
    const { user, storage } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "編輯 GitHub" }));
    const dialog = screen.getByRole("dialog", { name: "編輯條目" });
    await user.clear(within(dialog).getByLabelText("App 名稱"));
    await user.type(within(dialog).getByLabelText("App 名稱"), "GitHub Enterprise");
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(listedNames()).toContain("GitHub Enterprise");
    expect(listedNames()).not.toContain("GitHub");
    expect(vi.mocked(storage.editEntry).mock.calls[0][1]).not.toHaveProperty("password");
  });

  test("輸入新密碼：送出後在列表按「顯示」看到新密碼", async () => {
    const { user, storage } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "編輯 GitHub" }));
    const dialog = screen.getByRole("dialog", { name: "編輯條目" });
    await user.type(within(dialog).getByLabelText("密碼"), "pw-edited-Zz9x");
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(vi.mocked(storage.editEntry).mock.calls[0][1]).toHaveProperty("password", "pw-edited-Zz9x");
    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));
    expect(within(rowOf("GitHub")).getByText("pw-edited-Zz9x")).toBeTruthy();
  });

  test("清空 appName：即時提示且不送出；密碼留空不算錯誤", async () => {
    const { user, storage } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "編輯 GitHub" }));
    const dialog = screen.getByRole("dialog", { name: "編輯條目" });
    await user.clear(within(dialog).getByLabelText("App 名稱"));
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect(within(dialog).getByText("請輸入 App 名稱")).toBeTruthy();
    expect(within(dialog).queryByText("請輸入密碼")).toBeNull();
    expect(storage.editEntry).not.toHaveBeenCalled();
  });
});

describe("刪除條目（二次確認）", () => {
  test("點「刪除」只會開啟確認對話框，預設聚焦「取消」；取消與 Esc 都不會刪除", async () => {
    const { user, storage } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "刪除 GitHub" }));

    const dialog = screen.getByRole("alertdialog", { name: "刪除條目？" });
    expect(within(dialog).getByText("確定要刪除「GitHub」（alice@dev.io）嗎？此操作無法復原。")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" }));
    expect(storage.removeEntry).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "刪除 GitHub" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(storage.removeEntry).not.toHaveBeenCalled();
    expect(listedNames()).toContain("GitHub");
  });

  test("確認後刪除：條目消失、筆數更新，以 confirmed=true 呼叫 storage", async () => {
    const { user, storage } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "刪除 GitHub" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "刪除" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(listedNames()).not.toContain("GitHub");
    expect(screen.getByText("顯示 3 / 共 3 筆")).toBeTruthy();
    expect(vi.mocked(storage.removeEntry).mock.calls[0].slice(1)).toEqual(["entry-1", true]);
  });

  test("刪除失敗：對話框內顯示錯誤，條目保留", async () => {
    const { user } = await renderScreen({
      overrides: { removeEntry: vi.fn<EntriesStorage["removeEntry"]>(async () => Promise.reject(new Error("x"))) },
    });
    await user.click(screen.getByRole("button", { name: "刪除 GitHub" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "刪除" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("操作失敗，現有資料未被變更，請重試");
    expect(listedNames()).toContain("GitHub");
  });
});

describe("分類管理面板", () => {
  test("可開合；依序列出 未分類／Email／Work", async () => {
    const { user } = await renderScreen();
    const toggle = screen.getByRole("button", { name: "管理分類" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "分類管理" })).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panelNames()).toEqual(["未分類", "Email", "Work"]);
    await user.click(toggle);
    expect(screen.queryByRole("region", { name: "分類管理" })).toBeNull();
  });

  test("「未分類」防呆：沒有重新命名／上移／下移／刪除按鈕（根本不渲染），只標示「系統預設」", async () => {
    const { user } = await renderScreen();
    await openPanel(user);

    const row = panelRowOf("未分類");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(within(row).getByText("系統預設")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /未分類/ })).toBeNull();

    // 使用者分類則四個按鈕齊全；第一個不可上移、最後一個不可下移
    const email = panelRowOf("Email");
    for (const name of ["重新命名分類 Email", "上移分類 Email", "下移分類 Email", "刪除分類 Email"]) {
      expect(within(email).getByRole("button", { name })).toBeTruthy();
    }
    expect((within(email).getByRole("button", { name: "上移分類 Email" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(email).getByRole("button", { name: "下移分類 Email" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(panelRowOf("Work")).getByRole("button", { name: "下移分類 Work" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("新增分類：即時驗證重名（不分大小寫、含「未分類」）並停用按鈕；成功後出現在面板、篩選與表單選項", async () => {
    const { user, storage } = await renderScreen();
    await openPanel(user);
    const input = within(panel()).getByLabelText("新分類名稱");
    const add = within(panel()).getByRole("button", { name: "新增分類" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    await user.type(input, "email");
    expect(within(panel()).getByText("已有相同名稱的分類（不分大小寫）")).toBeTruthy();
    expect(add.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "未分類");
    expect(within(panel()).getByText("已有相同名稱的分類（不分大小寫）")).toBeTruthy();
    await user.clear(input);
    await user.type(input, "   ");
    expect(within(panel()).getByText("分類名稱不可只有空白")).toBeTruthy();
    expect(storage.addCategory).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Personal");
    expect(add.disabled).toBe(false);
    await user.click(add);

    await waitFor(() => expect(panelNames()).toEqual(["未分類", "Email", "Work", "Personal"]));
    expect((within(panel()).getByLabelText("新分類名稱") as HTMLInputElement).value).toBe("");
    expect(filterLabels()).toEqual(["未分類", "Email", "Work", "Personal"]);

    await user.click(screen.getByRole("button", { name: "新增條目" }));
    const category = within(screen.getByRole("dialog", { name: "新增條目" })).getByLabelText("分類");
    expect(within(category).getAllByRole("option").map((option) => option.textContent)).toContain("Personal");
  });

  test("重新命名：帶入現名、即時驗證重名、可取消；成功後面板與條目標籤同步更新", async () => {
    const { user } = await renderScreen();
    await openPanel(user);
    await user.click(within(panelRowOf("Work")).getByRole("button", { name: "重新命名分類 Work" }));

    const input = within(panel()).getByLabelText("分類「Work」的新名稱") as HTMLInputElement;
    expect(input.value).toBe("Work");
    const save = within(panel()).getByRole("button", { name: "儲存名稱" }) as HTMLButtonElement;

    await user.clear(input);
    await user.type(input, "email");
    expect(within(panel()).getByText("已有相同名稱的分類（不分大小寫）")).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.click(within(panel()).getByRole("button", { name: "取消重新命名" }));
    expect(panelNames()).toEqual(["未分類", "Email", "Work"]);

    await user.click(within(panelRowOf("Work")).getByRole("button", { name: "重新命名分類 Work" }));
    const again = within(panel()).getByLabelText("分類「Work」的新名稱");
    await user.clear(again);
    await user.type(again, "Job");
    await user.click(within(panel()).getByRole("button", { name: "儲存名稱" }));

    await waitFor(() => expect(panelNames()).toEqual(["未分類", "Email", "Job"]));
    expect(within(rowOf("GitHub")).getByText("Job")).toBeTruthy();
  });

  test("上移／下移：面板與篩選選項順序同步改變", async () => {
    const { user } = await renderScreen();
    await openPanel(user);
    await user.click(within(panelRowOf("Email")).getByRole("button", { name: "下移分類 Email" }));

    await waitFor(() => expect(panelNames()).toEqual(["未分類", "Work", "Email"]));
    expect(filterLabels()).toEqual(["未分類", "Work", "Email"]);

    await user.click(within(panelRowOf("Email")).getByRole("button", { name: "上移分類 Email" }));
    await waitFor(() => expect(panelNames()).toEqual(["未分類", "Email", "Work"]));
  });

  test("面板操作失敗：面板內顯示錯誤", async () => {
    const { user } = await renderScreen({
      overrides: {
        reorderCategories: vi.fn<EntriesStorage["reorderCategories"]>(async () => Promise.reject(new Error("x"))),
      },
    });
    await openPanel(user);
    await user.click(within(panelRowOf("Email")).getByRole("button", { name: "下移分類 Email" }));
    expect((await within(panel()).findByRole("alert")).textContent).toBe("操作失敗，現有資料未被變更，請重試");
  });
});

describe("刪除分類（受影響條目轉為「未分類」）", () => {
  test("確認對話框明確提示受影響條目數與轉移；取消不刪除", async () => {
    const { user, storage } = await renderScreen();
    await openPanel(user);
    await user.click(within(panelRowOf("Work")).getByRole("button", { name: "刪除分類 Work" }));

    const dialog = screen.getByRole("alertdialog", { name: "刪除分類「Work」？" });
    expect(within(dialog).getByText("此分類下的 2 個條目將轉為「未分類」，分類本身將被刪除，無法復原。")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" }));

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(storage.removeCategory).not.toHaveBeenCalled();
    expect(panelNames()).toContain("Work");
  });

  test("確認後：分類消失（面板與篩選），原屬該分類的條目改顯示「未分類」，updatedAt 不變（AC4）", async () => {
    const { user, vault } = await renderScreen();
    await openPanel(user);
    await user.click(within(panelRowOf("Work")).getByRole("button", { name: "刪除分類 Work" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "刪除分類" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(panelNames()).toEqual(["未分類", "Email"]);
    expect(filterLabels()).toEqual(["未分類", "Email"]);
    expect(within(rowOf("GitHub")).getByText("未分類")).toBeTruthy();
    expect(within(rowOf("Slack")).getByText("未分類")).toBeTruthy();
    expect(vault.getEntries().find((entry) => entry.id === "entry-1")).toMatchObject({
      categoryId: UNCATEGORIZED_ID,
      updatedAt: GITHUB.updatedAt,
    });
  });

  test("沒有條目的分類：提示文案不同", async () => {
    const { user } = await renderScreen();
    await openPanel(user);
    await user.type(within(panel()).getByLabelText("新分類名稱"), "Empty");
    await user.click(within(panel()).getByRole("button", { name: "新增分類" }));
    await waitFor(() => expect(panelNames()).toContain("Empty"));

    await user.click(within(panelRowOf("Empty")).getByRole("button", { name: "刪除分類 Empty" }));
    expect(
      within(screen.getByRole("alertdialog", { name: "刪除分類「Empty」？" })).getByText(
        "此分類下沒有條目，分類本身將被刪除，無法復原。"
      )
    ).toBeTruthy();
  });
});

describe("session 失效", () => {
  test("寫入時 KEY_GENERATION_MISMATCH：對話框顯示對應提示與「即將自動登出」", async () => {
    const { user } = await renderScreen({
      overrides: {
        addEntry: vi.fn<EntriesStorage["addEntry"]>(async () =>
          Promise.reject(new StorageError("KEY_GENERATION_MISMATCH", "x"))
        ),
      },
    });
    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, { appName: "X", accountId: "x@example.com", password: "pw-x-12345" });
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "保險庫資料已在其他地方變更，請重新登入（即將自動登出）"
    );
  });
});

describe("敏感資料", () => {
  test("新增與編輯整段流程 console 不含任何明文密碼；關閉表單後 DOM 不留輸入的密碼", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const { user } = await renderScreen();

    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, { appName: "Secret App", accountId: "s@example.com", password: "pw-typed-Aq7" });
    await user.click(within(dialog).getByRole("button", { name: "顯示密碼" }));
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "編輯 Secret App" }));
    await user.type(screen.getByLabelText("密碼"), "pw-edited-Bx3");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const password of [...ALL_PASSWORDS, "pw-typed-Aq7", "pw-edited-Bx3"]) {
      expect(output).not.toContain(password);
      expect(document.body.innerHTML).not.toContain(password);
    }
  });
});

describe("App 整合：session 失效後提示再自動登出", () => {
  test("寫入被 NOT_AUTHENTICATED 拒絕：先顯示提示，SESSION_LOST_LOGOUT_MS 後回到登入畫面（通用「已登出」）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const authStorage: AuthStorage = {
      isInitialized: vi.fn<AuthStorage["isInitialized"]>(async () => true),
      initialize: vi.fn<AuthStorage["initialize"]>(async () => undefined),
      login: vi.fn<AuthStorage["login"]>(async () => ({ ok: true, requiresSecondFactor: false })),
      verifySecondFactor: vi.fn<AuthStorage["verifySecondFactor"]>(async () => ({ ok: true })),
      logout: vi.fn<AuthStorage["logout"]>(),
      startPreLoginImport: vi.fn<AuthStorage["startPreLoginImport"]>(async () => ({ kind: "pre-login-import" })),
      importVault: vi.fn<AuthStorage["importVault"]>(async () => undefined),
    };
    const authController = createAuthController({
      storage: authStorage,
      idleTimer: { start: vi.fn(), stop: vi.fn() },
      bindActivity: () => () => undefined,
    });
    const vault = createFakeVault({
      overrides: {
        addEntry: vi.fn<EntriesStorage["addEntry"]>(async () =>
          Promise.reject(new StorageError("NOT_AUTHENTICATED", "x"))
        ),
      },
    });
    render(<App controller={authController} storage={vault.storage} />);

    await user.type(await screen.findByLabelText("主密碼"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "解鎖" }));
    const dialog = await openCreateDialog(user);
    await fillCreateForm(user, dialog, { appName: "X", accountId: "x@example.com", password: "pw-x-12345" });
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("驗證已逾時，請重新輸入主密碼（即將自動登出）");
    expect(authStorage.logout).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LOST_LOGOUT_MS);
    });
    expect(await screen.findByRole("heading", { name: "解鎖保險庫" })).toBeTruthy();
    expect(screen.getByText("已登出")).toBeTruthy();
    expect(authStorage.logout).toHaveBeenCalledTimes(1);
  });
});
