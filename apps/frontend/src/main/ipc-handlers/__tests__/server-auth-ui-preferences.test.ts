/**
 * The channel the renderer calls at connection takes no argument and answers
 * what main read from the server: the theme and the menu layout together.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	pullServerInterface: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
	shell: { openExternal: vi.fn() },
	app: { getPath: () => "/tmp/workpilot-test", getVersion: () => "0.0.0", isPackaged: false, on: vi.fn() },
	safeStorage: { isEncryptionAvailable: () => false },
	BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../server-menu-layout", () => ({ pullServerInterface: mocks.pullServerInterface }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerServerAuthHandlers } from "../server-auth-handlers";

describe("SERVER_AUTH_PULL_UI_PREFERENCES", () => {
	it("answers the theme and the menu main pulled, whatever the renderer sends", async () => {
		const pulled = { theme: "dark", sidebarPrefs: { groupOrder: ["agents"] } };
		mocks.pullServerInterface.mockResolvedValue(pulled);
		registerServerAuthHandlers(() => null);
		const handler = mocks.handlers.get(IPC_CHANNELS.SERVER_AUTH_PULL_UI_PREFERENCES);
		expect(await handler?.({}, "/etc/passwd")).toBe(pulled);
		expect(mocks.pullServerInterface).toHaveBeenCalledWith();
	});
});
