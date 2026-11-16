/**
 * The person's menu on the server: read at connection (the server's layout
 * replaces the desktop's, a server without one takes the desktop's), sent
 * when the menu is rearranged, never when only the open space changes, and
 * only a checked layout crosses either way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	isServerMode: vi.fn(() => true),
	getAccessToken: vi.fn<() => string | null>(() => "access"),
	readSettingsFile: vi.fn<() => Record<string, unknown> | undefined>(),
	writeSettingsFile: vi.fn(),
}));
vi.mock("../server-connection", () => ({
	authedFetch: mocks.authedFetch,
	isServerMode: mocks.isServerMode,
	getAccessToken: mocks.getAccessToken,
}));
vi.mock("../settings-utils", () => ({
	readSettingsFile: mocks.readSettingsFile,
	writeSettingsFile: mocks.writeSettingsFile,
}));

import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from "../../shared/types/settings";
import {
	pullServerInterface,
	pullServerMenuLayout,
	pushMenuLayoutIfChanged,
	pushServerMenuLayout,
} from "../server-menu-layout";

const LAYOUT = {
	groupOrder: ["agents", "workspace"],
	itemOrder: { agents: ["terminals", "kanban"] },
	itemGroups: { kanban: "agents" },
	pinnedItems: ["insights"],
	pinnedGroups: [],
	hiddenItems: ["arena"],
};
const SHIPPED = {
	groupOrder: [],
	itemOrder: {},
	itemGroups: {},
	pinnedItems: [],
	pinnedGroups: [],
	hiddenItems: [],
};

const prefs = (patch: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ ...DEFAULT_SIDEBAR_PREFS, ...patch });

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.writeSettingsFile.mockReset();
	mocks.readSettingsFile.mockReset();
	mocks.isServerMode.mockReturnValue(true);
	mocks.getAccessToken.mockReturnValue("access");
});

describe("pull at connection", () => {
	it("takes the server's layout and keeps the rest of the desktop's preferences", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { layout: LAYOUT } });
		mocks.readSettingsFile.mockReturnValue({
			theme: "dark",
			sidebarPrefs: prefs({ activeSpace: "planning", menuMode: "full" }),
		});
		const pulled = await pullServerMenuLayout();
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/preferences/menu", "GET");
		expect(pulled).toEqual({ ...prefs({ activeSpace: "planning", menuMode: "full" }), ...LAYOUT });
		expect(mocks.writeSettingsFile).toHaveBeenCalledWith({ theme: "dark", sidebarPrefs: pulled });
	});

	it("does not rewrite the settings when the layouts already match", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { layout: LAYOUT } });
		mocks.readSettingsFile.mockReturnValue({ sidebarPrefs: prefs(LAYOUT) });
		expect(await pullServerMenuLayout()).toEqual(prefs(LAYOUT));
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();
	});

	it("gives the desktop's layout to a server that has none", async () => {
		mocks.authedFetch
			.mockResolvedValueOnce({ ok: true, data: { layout: null } })
			.mockResolvedValueOnce({ ok: true, data: {} });
		mocks.readSettingsFile.mockReturnValue({ sidebarPrefs: prefs(LAYOUT) });
		expect(await pullServerMenuLayout()).toBeNull();
		expect(mocks.authedFetch).toHaveBeenLastCalledWith("/users/me/preferences/menu", "PUT", LAYOUT);
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();
	});

	it("sends nothing when neither has arranged anything", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { layout: null } });
		mocks.readSettingsFile.mockReturnValue(undefined);
		expect(await pullServerMenuLayout()).toBeNull();
		expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
	});

	it("ignores what is not a layout, an unreachable server, or no session", async () => {
		mocks.readSettingsFile.mockReturnValue({ sidebarPrefs: prefs() });
		for (const layout of [{ ...LAYOUT, groupOrder: ["../x"] }, "layout", { ...LAYOUT, hiddenItems: undefined }]) {
			mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { layout } });
			expect(await pullServerMenuLayout()).toBeNull();
		}
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: null });
		expect(await pullServerMenuLayout()).toBeNull();
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "offline" });
		expect(await pullServerMenuLayout()).toBeNull();
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();

		mocks.authedFetch.mockClear();
		mocks.getAccessToken.mockReturnValue(null);
		expect(await pullServerMenuLayout()).toBeNull();
		mocks.getAccessToken.mockReturnValue("access");
		mocks.isServerMode.mockReturnValue(false);
		expect(await pullServerMenuLayout()).toBeNull();
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});

describe("push after a save", () => {
	it("sends the layout when the menu was rearranged", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: {} });
		const saved = { sidebarPrefs: prefs(LAYOUT) };
		pushMenuLayoutIfChanged(saved, { sidebarPrefs: prefs() }, saved);
		await vi.waitFor(() =>
			expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/preferences/menu", "PUT", LAYOUT),
		);
	});

	it("sends the shipped order when the user restores it", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: {} });
		const saved = { sidebarPrefs: prefs() };
		pushMenuLayoutIfChanged(saved, { sidebarPrefs: prefs(LAYOUT) }, saved);
		await vi.waitFor(() =>
			expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/preferences/menu", "PUT", SHIPPED),
		);
	});

	it("sends nothing for another setting, the open space, or outside server mode", () => {
		const before = { sidebarPrefs: prefs(LAYOUT) };
		pushMenuLayoutIfChanged({ theme: "dark" }, before, { ...before, theme: "dark" });
		const opened = { sidebarPrefs: prefs({ ...LAYOUT, activeSpace: "planning" }) };
		pushMenuLayoutIfChanged(opened, before, opened);
		mocks.isServerMode.mockReturnValue(false);
		const moved = { sidebarPrefs: prefs() };
		pushMenuLayoutIfChanged(moved, before, moved);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("never fails the save when the server refuses", async () => {
		mocks.authedFetch.mockRejectedValue(new Error("down"));
		const saved = { sidebarPrefs: prefs(LAYOUT) };
		expect(() => pushMenuLayoutIfChanged(saved, {}, saved)).not.toThrow();
		await vi.waitFor(() => expect(mocks.authedFetch).toHaveBeenCalled());
	});

	it("does not send a layout that is not one", async () => {
		expect(await pushServerMenuLayout({ ...LAYOUT, groupOrder: ["Agents"] })).toBe(false);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});

describe("what the renderer applies at connection", () => {
	const answers = (theme: unknown, layout: unknown) =>
		mocks.authedFetch.mockImplementation(async (path: string, method: string) => {
			if (method !== "GET") return { ok: true, data: {} };
			return path.endsWith("/menu")
				? { ok: true, data: { layout } }
				: { ok: true, data: theme };
		});

	it("brings the theme and the menu together", async () => {
		answers({ theme: "dark", colorTheme: "neo" }, LAYOUT);
		mocks.readSettingsFile.mockReturnValue({});
		expect(await pullServerInterface()).toEqual({
			theme: "dark",
			colorTheme: "neo",
			sidebarPrefs: prefs(LAYOUT),
		});
	});

	it("brings the menu alone, the theme alone, or nothing", async () => {
		mocks.readSettingsFile.mockReturnValue({});
		answers({ theme: null, colorTheme: null }, LAYOUT);
		expect(await pullServerInterface()).toEqual({ sidebarPrefs: prefs(LAYOUT) });
		answers({ theme: "light", colorTheme: "ocean" }, null);
		expect(await pullServerInterface()).toEqual({ theme: "light", colorTheme: "ocean" });
		answers({ theme: null, colorTheme: null }, null);
		expect(await pullServerInterface()).toBeNull();
		mocks.authedFetch.mockRejectedValue(new Error("down"));
		expect(await pullServerInterface()).toBeNull();
	});
});
