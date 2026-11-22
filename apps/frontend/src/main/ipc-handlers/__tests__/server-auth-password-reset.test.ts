/**
 * The forgotten-password channels hand the renderer's arguments, untouched,
 * to server-password-reset.ts, which checks every one of them.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	reset: {
		requestPasswordReset: vi.fn(async () => "requested"),
		lookupPasswordReset: vi.fn(async () => "looked up"),
		confirmPasswordReset: vi.fn(async () => "confirmed"),
		issuePasswordReset: vi.fn(async () => "issued"),
	},
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
vi.mock("../../server-password-reset", () => mocks.reset);

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerServerAuthHandlers } from "../server-auth-handlers";

describe("forgotten password channels", () => {
	it("pass each argument to the module that checks it", async () => {
		registerServerAuthHandlers(() => null);
		const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);
		const url = "https://wp.example.test";
		expect(await call(IPC_CHANNELS.SERVER_AUTH_REQUEST_PASSWORD_RESET, url, "a@x.test")).toBe("requested");
		expect(mocks.reset.requestPasswordReset).toHaveBeenCalledWith(url, "a@x.test");
		expect(await call(IPC_CHANNELS.SERVER_AUTH_LOOKUP_PASSWORD_RESET, url, "link")).toBe("looked up");
		expect(mocks.reset.lookupPasswordReset).toHaveBeenCalledWith(url, "link");
		expect(await call(IPC_CHANNELS.SERVER_AUTH_CONFIRM_PASSWORD_RESET, url, "link", "pw")).toBe("confirmed");
		expect(mocks.reset.confirmPasswordReset).toHaveBeenCalledWith(url, "link", "pw");
		expect(await call(IPC_CHANNELS.SERVER_AUTH_ISSUE_PASSWORD_RESET, "u1")).toBe("issued");
		expect(mocks.reset.issuePasswordReset).toHaveBeenCalledWith("u1");
	});
});
