/**
 * @vitest-environment jsdom
 *
 * Hiding the experimental views is a sidebar preference: it is saved with the
 * others and kept through every other change to them.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSettings = vi.fn();
let stored: Record<string, unknown> = {};

vi.mock("@/stores/settings-store", () => ({
	saveSettings: (patch: Record<string, unknown>) => {
		saveSettings(patch);
		stored = { ...stored, ...patch };
	},
	useSettingsStore: Object.assign(
		(selector: (state: unknown) => unknown) =>
			selector({ settings: stored }),
		{ getState: () => ({ settings: stored }) },
	),
}));

import { DEFAULT_SIDEBAR_PREFS } from "@shared/types/settings";
import { useSidebarPrefs } from "../use-sidebar-prefs";

describe("useSidebarPrefs", () => {
	beforeEach(() => {
		stored = {};
		saveSettings.mockClear();
	});

	it("shows the experimental views by default", () => {
		expect(DEFAULT_SIDEBAR_PREFS.hideExperimental).toBe(false);
	});

	it("saves the choice to hide them", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.setHideExperimental(true));
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, hideExperimental: true },
		});
	});

	it("keeps the choice when another preference changes", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.setHideExperimental(true));
		act(() => result.current.toggleItemPin("kanban"));
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: expect.objectContaining({
				hideExperimental: true,
				pinnedItems: ["kanban"],
			}),
		});
	});

	it("unpins several entries in one save", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.toggleItemPin("session-history"));
		act(() => result.current.toggleItemPin("kanban"));
		act(() => result.current.toggleItemPin("agent-replay"));
		saveSettings.mockClear();
		act(() => result.current.unpinItems(["session-history", "agent-replay"]));
		expect(saveSettings).toHaveBeenCalledTimes(1);
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: expect.objectContaining({ pinnedItems: ["kanban"] }),
		});
	});

	it("remembers the space the panel shows", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.setActiveSpace("development"));
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: expect.objectContaining({ activeSpace: "development" }),
		});
	});

	it("pins the essential pages after the user's own and hides the beta views", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.toggleItemPin("insights"));
		act(() => result.current.chooseMenuMode("essential", ["kanban", "insights"]));
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: expect.objectContaining({
				menuMode: "essential",
				pinnedItems: ["insights", "kanban"],
				hideExperimental: true,
			}),
		});
	});

	it("records the full menu without pinning anything", () => {
		const { result } = renderHook(() => useSidebarPrefs());
		act(() => result.current.chooseMenuMode("full", ["kanban"]));
		expect(saveSettings).toHaveBeenLastCalledWith({
			sidebarPrefs: expect.objectContaining({ menuMode: "full", pinnedItems: [] }),
		});
	});
});
