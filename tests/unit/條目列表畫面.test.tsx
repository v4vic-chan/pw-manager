// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/ui/App";
import { createAuthController, type AuthStorage } from "../../src/ui/auth/authController";
import { createEntriesController, type ClipboardLike, type EntriesStorage } from "../../src/ui/entries/entriesController";
import { EntriesScreen } from "../../src/ui/entries/EntriesScreen";
import { StorageError } from "../../src/services/storage";
import { ALL_PASSWORDS, ENTRIES, cloneCategories, cloneEntries } from "./_shared/entriesFixtures";

/**
 * 模組：條目列表主畫面（React 元件，jsdom）
 * 以真實 entries 控制器 + 假 storage／假剪貼簿驗證：列表內容、密碼遮罩與逐筆顯示、
 * 搜尋／篩選／排序疊加、兩種空狀態、複製提示，以及 App 在 authenticated 狀態下掛載本畫面。
 */

const MASK = "••••••••";
const GITHUB = ENTRIES[0];
const GMAIL = ENTRIES[1];

function createStorage(overrides: Partial<EntriesStorage> = {}): EntriesStorage {
  return {
    loadEntries: vi.fn<EntriesStorage["loadEntries"]>(async () => cloneEntries()),
    loadCategories: vi.fn<EntriesStorage["loadCategories"]>(async () => cloneCategories()),
    ...overrides,
  };
}

function createClipboard(overrides: Partial<ClipboardLike> = {}) {
  let text = "";
  return {
    writeText: vi.fn<ClipboardLike["writeText"]>(async (value) => {
      text = value;
    }),
    readText: vi.fn<NonNullable<ClipboardLike["readText"]>>(async () => text),
    ...overrides,
  };
}

async function renderScreen(
  options: { storage?: EntriesStorage; clipboard?: ReturnType<typeof createClipboard>; load?: boolean } = {}
) {
  const storage = options.storage ?? createStorage();
  const clipboard = options.clipboard ?? createClipboard();
  const onLogout = vi.fn();
  const controller = createEntriesController({ storage, clipboard });
  if (options.load !== false) await controller.load();
  render(<EntriesScreen controller={controller} onLogout={onLogout} />);
  return { storage, clipboard, onLogout, controller, user: userEvent.setup(), container: document.body };
}

const appNames = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
const rowOf = (appName: string) => screen.getByRole("heading", { level: 2, name: appName }).closest("li") as HTMLElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("條目列表", () => {
  test("顯示 appName、accountId、所屬分類；預設 appName 升序；顯示筆數", async () => {
    await renderScreen();

    expect(appNames()).toEqual(["GitHub", "Slack", "Zoo", "gmail"]);
    const github = within(rowOf("GitHub"));
    expect(github.getByText("alice@dev.io")).toBeTruthy();
    expect(github.getByText("Work")).toBeTruthy();
    expect(within(rowOf("Zoo")).getByText("未分類")).toBeTruthy();
    expect(screen.getByText("顯示 4 / 共 4 筆")).toBeTruthy();
  });

  test("載入中顯示提示；載入失敗顯示錯誤；兩種情況都仍可登出", async () => {
    const loading = await renderScreen({ load: false });
    expect(screen.getByRole("status").textContent).toBe("載入中…");
    await loading.user.click(screen.getByRole("button", { name: "登出" }));
    expect(loading.onLogout).toHaveBeenCalledTimes(1);
    cleanup();

    const failed = await renderScreen({
      storage: createStorage({
        loadEntries: vi.fn(async () => {
          throw new StorageError("NOT_AUTHENTICATED", "x");
        }),
      }),
    });
    expect((await screen.findByRole("alert")).textContent).toBe("驗證已逾時，請重新輸入主密碼");
    await failed.user.click(screen.getByRole("button", { name: "登出" }));
    expect(failed.onLogout).toHaveBeenCalledTimes(1);
  });

  test("登出按鈕呼叫 onLogout", async () => {
    const { user, onLogout } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "登出" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("密碼遮罩與逐筆顯示（§4.4）", () => {
  test("預設全部遮罩：DOM 中不含任何明文密碼（含屬性）", async () => {
    const { container } = await renderScreen();
    expect(screen.getAllByText(MASK)).toHaveLength(4);
    for (const password of ALL_PASSWORDS) expect(container.innerHTML).not.toContain(password);
  });

  test("每筆獨立切換：顯示 A 只會出現 A 的明文，隱藏後明文自 DOM 移除", async () => {
    const { user, container } = await renderScreen();

    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));
    expect(within(rowOf("GitHub")).getByText(GITHUB.password)).toBeTruthy();
    expect(within(rowOf("GitHub")).queryByText(MASK)).toBeNull();
    expect(within(rowOf("Slack")).getByText(MASK)).toBeTruthy();
    expect(container.innerHTML).not.toContain(GMAIL.password);

    await user.click(screen.getByRole("button", { name: "顯示 gmail 的密碼" }));
    expect(container.innerHTML).toContain(GITHUB.password);
    expect(container.innerHTML).toContain(GMAIL.password);

    await user.click(screen.getByRole("button", { name: "隱藏 GitHub 的密碼" }));
    expect(container.innerHTML).not.toContain(GITHUB.password);
    expect(container.innerHTML).toContain(GMAIL.password);
    expect(screen.getByRole("button", { name: "顯示 GitHub 的密碼" })).toBeTruthy();
  });

  test("已顯示的密碼在搜尋過濾掉再顯示回來後仍維持顯示狀態", async () => {
    const { user } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));

    await user.type(screen.getByLabelText("搜尋"), "zoo");
    expect(appNames()).toEqual(["Zoo"]);
    await user.clear(screen.getByLabelText("搜尋"));
    expect(within(rowOf("GitHub")).getByText(GITHUB.password)).toBeTruthy();
  });
});

describe("搜尋（§4.5）", () => {
  test("即時過濾（不分大小寫，比對 appName 與 accountId）；清空後顯示全部", async () => {
    const { user } = await renderScreen();
    const input = screen.getByLabelText("搜尋");

    await user.type(input, "ALICE");
    expect(appNames()).toEqual(["GitHub", "gmail"]);
    expect(screen.getByText("顯示 2 / 共 4 筆")).toBeTruthy();

    await user.clear(input);
    expect(appNames()).toHaveLength(4);
  });

  test("不會用明文密碼比對", async () => {
    const { user } = await renderScreen();
    await user.type(screen.getByLabelText("搜尋"), "pw-github");
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });
});

describe("分類篩選（§4.5、§3.5）", () => {
  test("分類選項依 sortIndex 排列，「未分類」居首；可多選，可篩選「未分類」；清除篩選還原", async () => {
    const { user } = await renderScreen();
    const filter = within(screen.getByRole("group", { name: "依分類篩選" }));
    expect(filter.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      "未分類",
      "Email",
      "Work",
    ]);

    await user.click(filter.getByLabelText("未分類"));
    expect(appNames()).toEqual(["Zoo"]);

    await user.click(filter.getByLabelText("Work"));
    expect(appNames()).toEqual(["GitHub", "Slack", "Zoo"]);

    await user.click(filter.getByLabelText("未分類"));
    expect(appNames()).toEqual(["GitHub", "Slack"]);

    await user.click(screen.getByRole("button", { name: "清除篩選" }));
    expect(appNames()).toHaveLength(4);
    expect((filter.getByLabelText("Work") as HTMLInputElement).checked).toBe(false);
  });

  test("沒有勾選任何分類時，「清除篩選」為停用", async () => {
    await renderScreen();
    expect((screen.getByRole("button", { name: "清除篩選" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("排序（§4.5）", () => {
  test("四種排序鍵與方向切換", async () => {
    const { user } = await renderScreen();
    const sortKey = screen.getByLabelText("排序依據");
    expect((sortKey as HTMLSelectElement).value).toBe("appName");

    await user.selectOptions(sortKey, "category");
    expect(appNames()).toEqual(["gmail", "GitHub", "Slack", "Zoo"]);

    await user.click(screen.getByRole("button", { name: "排序方向：升序" }));
    expect(screen.getByRole("button", { name: "排序方向：降序" })).toBeTruthy();
    expect(appNames()).toEqual(["Zoo", "Slack", "GitHub", "gmail"]);

    await user.selectOptions(sortKey, "createdAt");
    expect(appNames()).toEqual(["Zoo", "gmail", "Slack", "GitHub"]);

    await user.selectOptions(sortKey, "updatedAt");
    expect(appNames()).toEqual(["Zoo", "GitHub", "gmail", "Slack"]);

    await user.selectOptions(sortKey, "appName");
    expect(appNames()).toEqual(["gmail", "Zoo", "Slack", "GitHub"]);
  });
});

describe("疊加（AC5）", () => {
  test("搜尋關鍵字 + 兩個分類 + updatedAt 遞減同時生效", async () => {
    const { user } = await renderScreen();
    const filter = within(screen.getByRole("group", { name: "依分類篩選" }));

    await user.type(screen.getByLabelText("搜尋"), "alice");
    await user.click(filter.getByLabelText("Work"));
    await user.click(filter.getByLabelText("Email"));
    await user.selectOptions(screen.getByLabelText("排序依據"), "updatedAt");
    await user.click(screen.getByRole("button", { name: "排序方向：升序" }));

    expect(appNames()).toEqual(["GitHub", "gmail"]);
    expect(screen.getByText("顯示 2 / 共 4 筆")).toBeTruthy();
  });
});

describe("空狀態", () => {
  test("完全沒有條目：顯示專屬文案，不出現「沒有符合」的提示", async () => {
    await renderScreen({ storage: createStorage({ loadEntries: vi.fn(async () => []) }) });
    expect(screen.getByText("目前沒有任何條目")).toBeTruthy();
    expect(screen.queryByText(/沒有符合/)).toBeNull();
    expect(screen.queryByRole("button", { name: "清除搜尋與篩選" })).toBeNull();
  });

  test("搜尋／篩選後無符合結果：顯示不同文案並說明資料仍在，可一鍵清除搜尋與篩選", async () => {
    const { user } = await renderScreen();
    await user.type(screen.getByLabelText("搜尋"), "no-such-app");
    await user.click(within(screen.getByRole("group", { name: "依分類篩選" })).getByLabelText("Work"));

    expect(screen.getByText(/沒有符合目前搜尋或篩選條件的條目/)).toBeTruthy();
    expect(screen.getByText(/共 4 筆條目未顯示/)).toBeTruthy();
    expect(screen.queryByText("目前沒有任何條目")).toBeNull();
    expect(screen.getByText("顯示 0 / 共 4 筆")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "清除搜尋與篩選" }));
    expect(appNames()).toHaveLength(4);
    expect((screen.getByLabelText("搜尋") as HTMLInputElement).value).toBe("");
  });
});

describe("複製（§4.4）", () => {
  test("複製密碼不需先顯示；提示「密碼已複製」於該列；DOM 仍不含明文", async () => {
    const { user, clipboard, container } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "複製 GitHub 的密碼" }));

    expect(clipboard.writeText).toHaveBeenCalledWith(GITHUB.password);
    expect(within(rowOf("GitHub")).getByRole("status").textContent).toBe("密碼已複製");
    expect(container.innerHTML).not.toContain(GITHUB.password);
  });

  test("複製帳號：提示「帳號已複製」", async () => {
    const { user, clipboard } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "複製 gmail 的帳號" }));

    expect(clipboard.writeText).toHaveBeenCalledWith(GMAIL.accountId);
    expect(within(rowOf("gmail")).getByRole("status").textContent).toBe("帳號已複製");
  });

  test("複製失敗時提示手動複製", async () => {
    const { user } = await renderScreen({
      clipboard: createClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }),
    });
    await user.click(screen.getByRole("button", { name: "複製 GitHub 的密碼" }));
    expect((await within(rowOf("GitHub")).findByRole("alert")).textContent).toBe("複製失敗，請手動複製");
  });
});

describe("敏感資料：不落入 console", () => {
  test("顯示、複製、隱藏整段操作 console 不含任何明文密碼", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const { user } = await renderScreen();

    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));
    await user.click(screen.getByRole("button", { name: "複製 GitHub 的密碼" }));
    await user.click(screen.getByRole("button", { name: "隱藏 GitHub 的密碼" }));

    const output = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const password of ALL_PASSWORDS) expect(output).not.toContain(password);
  });
});

describe("App 整合：authenticated 時掛載主畫面", () => {
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
    const authController = createAuthController({
      storage: createAuthStorage(),
      idleTimer: { start: vi.fn(), stop: vi.fn() },
      bindActivity: () => () => undefined,
    });
    const storage = createStorage();
    const clipboard = createClipboard();
    const view = render(<App controller={authController} storage={storage} clipboard={clipboard} />);
    const user = userEvent.setup();

    async function login() {
      await user.type(await screen.findByLabelText("主密碼"), "correct horse battery staple");
      await user.click(screen.getByRole("button", { name: "解鎖" }));
      await screen.findByRole("heading", { level: 2, name: "GitHub" });
    }
    return { authController, storage, clipboard, user, login, container: view.container };
  }

  test("解鎖後顯示條目列表（取代「已解鎖」佔位頁）；登出回到登入畫面且 DOM 不留明文；再次解鎖會重新載入", async () => {
    const { user, login, storage, container } = await renderApp();

    await login();
    expect(screen.queryByRole("heading", { name: "已解鎖" })).toBeNull();
    expect(appNames()).toEqual(["GitHub", "Slack", "Zoo", "gmail"]);
    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));
    expect(container.innerHTML).toContain(GITHUB.password);

    await user.click(screen.getByRole("button", { name: "登出" }));
    expect(await screen.findByRole("heading", { name: "解鎖保險庫" })).toBeTruthy();
    for (const password of ALL_PASSWORDS) expect(container.innerHTML).not.toContain(password);

    await login();
    expect(storage.loadEntries).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(MASK)).toHaveLength(4);
  });

  test("閒置逾時：回到登入畫面，已顯示的明文自 DOM 移除，並嘗試清除剪貼簿中的密碼", async () => {
    const { authController, user, login, clipboard, container } = await renderApp();
    await login();
    await user.click(screen.getByRole("button", { name: "顯示 GitHub 的密碼" }));
    await user.click(screen.getByRole("button", { name: "複製 GitHub 的密碼" }));

    act(() => authController.handleIdleTimeout());
    expect(await screen.findByText("閒置逾時，已自動鎖定")).toBeTruthy();
    for (const password of ALL_PASSWORDS) expect(container.innerHTML).not.toContain(password);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(""));
  });
});
