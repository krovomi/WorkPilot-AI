import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	handle: vi.fn(),
	save: vi.fn(),
	clear: vi.fn(),
	status: vi.fn(() => ({ configured: true, secureStorageAvailable: true })),
}));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("../../jev/service", () => ({
	getJevService: () => ({
		save: mocks.save,
		clear: mocks.clear,
		getStatus: mocks.status,
	}),
}));
import { registerJevHandlers } from "../jev-handlers";
import { IPC_CHANNELS } from "../../../shared/constants";
beforeEach(() => {
	vi.clearAllMocks();
	registerJevHandlers();
});
it("returns only status after saving and clearing", async () => {
	const handler = mocks.handle.mock.calls.find(
		([name]) => name === IPC_CHANNELS.JEV_SAVE_KEY,
	)?.[1];
	const result = await handler({}, "test-key");
	expect(mocks.save).toHaveBeenCalledWith("test-key");
	expect(JSON.stringify(result)).not.toContain("test-key");
	expect(result.success).toBe(true);
});
it("does not echo secret exceptions", async () => {
	mocks.save.mockImplementationOnce(() => {
		throw new Error("private key contents");
	});
	const handler = mocks.handle.mock.calls.find(
		([name]) => name === IPC_CHANNELS.JEV_SAVE_KEY,
	)?.[1];
	expect((await handler({}, "test-key")).error).toBe("jev-save-failed");
});
