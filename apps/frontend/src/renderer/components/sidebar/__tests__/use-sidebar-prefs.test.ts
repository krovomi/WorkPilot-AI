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
});
