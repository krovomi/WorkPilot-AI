/**
 * The person's theme on the server: read at connection (the server's choice
 * replaces the desktop's, a server without one takes the desktop's), sent
 * when the theme changes in the settings, and only the closed lists cross.
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

import {
	parseUiPreferences,
	pullServerUiPreferences,
	pushServerUiPreferences,
	pushThemeIfChanged,
} from "../server-ui-preferences";

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.writeSettingsFile.mockReset();
	mocks.readSettingsFile.mockReset();
	mocks.isServerMode.mockReturnValue(true);
	mocks.getAccessToken.mockReturnValue("access");
});

describe("server ui preferences", () => {
	it("accepts only the closed lists", () => {
		expect(parseUiPreferences({ theme: "dark", colorTheme: "ocean" })).toEqual({
			theme: "dark",
			colorTheme: "ocean",
		});
		for (const bad of [
			{ theme: "sepia", colorTheme: "ocean" },
			{ theme: "dark", colorTheme: "solarized" },
			{ theme: null, colorTheme: null },
			"dark",
			null,
		]) {
			expect(parseUiPreferences(bad)).toBeNull();
		}
	});

	it("takes the server's choice at connection and keeps it in the settings", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { theme: "dark", colorTheme: "neo" } });
		mocks.readSettingsFile.mockReturnValue({ theme: "light", colorTheme: "default", uiScale: 100 });
		expect(await pullServerUiPreferences()).toEqual({ theme: "dark", colorTheme: "neo" });
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/preferences", "GET");
		expect(mocks.writeSettingsFile).toHaveBeenCalledWith({
			theme: "dark",
			colorTheme: "neo",
			uiScale: 100,
		});
	});

	it("does not rewrite the settings when they already match", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { theme: "dark", colorTheme: "neo" } });
		mocks.readSettingsFile.mockReturnValue({ theme: "dark", colorTheme: "neo" });
		await pullServerUiPreferences();
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();
	});

	it("gives the desktop's choice to a server that has none", async () => {
		mocks.authedFetch
			.mockResolvedValueOnce({ ok: true, data: { theme: null, colorTheme: null } })
			.mockResolvedValueOnce({ ok: true, data: {} });
		mocks.readSettingsFile.mockReturnValue({ theme: "light", colorTheme: "forest" });
		expect(await pullServerUiPreferences()).toBeNull();
		expect(mocks.authedFetch).toHaveBeenLastCalledWith("/users/me/preferences", "PUT", {
			theme: "light",
			colorTheme: "forest",
		});
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();
	});

	it("leaves the desktop's theme when the server cannot answer or the person is not connected", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: false, error: "Server unavailable" });
		expect(await pullServerUiPreferences()).toBeNull();
		mocks.isServerMode.mockReturnValue(false);
		mocks.authedFetch.mockClear();
		expect(await pullServerUiPreferences()).toBeNull();
		expect(await pushServerUiPreferences({ theme: "dark", colorTheme: "lime" })).toBe(false);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		expect(mocks.writeSettingsFile).not.toHaveBeenCalled();
	});

	it("sends the saved theme only when a save touched it", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: {} });
		pushThemeIfChanged({ uiScale: 110 }, { theme: "dark", colorTheme: "lime" });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		pushThemeIfChanged({ colorTheme: "lime" }, { theme: "dark", colorTheme: "lime" });
		await vi.waitFor(() =>
			expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/preferences", "PUT", {
				theme: "dark",
				colorTheme: "lime",
			}),
		);
	});

	it("never sends a value outside the lists", async () => {
		expect(
			await pushServerUiPreferences({ theme: "dark", colorTheme: "evil" as never }),
		).toBe(false);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});
