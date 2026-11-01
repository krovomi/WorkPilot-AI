/**
 * At connection to a server, the renderer applies the theme the server keeps
 * for the person (the same as on their phone); without one it keeps its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../permissions-store", () => ({
	usePermissionsStore: { getState: () => ({ load: vi.fn(), reset: vi.fn() }) },
}));
vi.mock("../project-store", () => ({ refreshProjects: vi.fn() }));

import { useServerSessionStore } from "../server-session-store";
import { useSettingsStore } from "../settings-store";

const SIGNED_IN = {
	mode: "server" as const,
	serverUrl: "https://wp.example.com",
	user: { id: "u1", email: "a@x.io", display_name: "A", role: "member" },
	isAuthenticated: true,
	configured: true,
};

function setBridge(pullUiPreferences: () => Promise<unknown>): void {
	vi.stubGlobal("window", {
		electronAPI: {
			serverAuth: {
				restore: async () => SIGNED_IN,
				onStateChanged: vi.fn(),
				pullUiPreferences,
			},
		},
	});
}

describe("theme from the server", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		useServerSessionStore.setState({ initialized: false });
	});

	it("applies the server's theme once the session starts", async () => {
		useSettingsStore.getState().updateSettings({ theme: "light", colorTheme: "default" });
		const pull = vi.fn(async () => ({ theme: "dark", colorTheme: "ocean" }));
		setBridge(pull);
		await useServerSessionStore.getState().initialize();
		await vi.waitFor(() => expect(useSettingsStore.getState().settings.colorTheme).toBe("ocean"));
		expect(useSettingsStore.getState().settings.theme).toBe("dark");
		expect(pull).toHaveBeenCalledTimes(1);
	});
});
