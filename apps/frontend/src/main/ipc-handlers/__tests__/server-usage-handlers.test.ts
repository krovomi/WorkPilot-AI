/**
 * The usage channels hand the renderer's arguments, untouched, to
 * server-usage.ts, which checks every one of them; a view opened is one-way
 * and never throws back.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	listeners: new Map<string, (...args: unknown[]) => unknown>(),
	usage: {
		notePageVisit: vi.fn(async () => true),
		getUsageSettings: vi.fn(async () => "read"),
		setUsageSettings: vi.fn(async () => "saved"),
	},
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
		on: (channel: string, listener: (...args: unknown[]) => unknown) =>
			mocks.listeners.set(channel, listener),
	},
}));
vi.mock("../../server-usage", () => mocks.usage);

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerServerUsageHandlers } from "../server-usage-handlers";

describe("usage channels", () => {
	it("pass each argument to the module that checks it", async () => {
		registerServerUsageHandlers();
		mocks.listeners.get(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT)?.({}, "kanban");
		expect(mocks.usage.notePageVisit).toHaveBeenCalledWith("kanban");
		mocks.usage.notePageVisit.mockRejectedValueOnce(new Error("offline"));
		expect(() => mocks.listeners.get(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT)?.({}, "x")).not.toThrow();
		expect(await mocks.handlers.get(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS)?.({})).toBe("read");
		const body = { page_activity: true };
		expect(await mocks.handlers.get(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS)?.({}, body)).toBe("saved");
		expect(mocks.usage.setUsageSettings).toHaveBeenCalledWith(body);
	});
});
