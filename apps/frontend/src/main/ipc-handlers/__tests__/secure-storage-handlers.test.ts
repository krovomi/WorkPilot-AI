/**
 * @vitest-environment node
 *
 * The renderer learns whether stored secrets are protected: it pulls the
 * status, and the main process pushes it when a secret lands in clear.
 */

import { BrowserWindow, ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";
import { sharedFakeSafeStorage } from "../../../__tests__/helpers/fake-safe-storage";

vi.mock("electron", async (importOriginal) => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		...(await importOriginal<typeof import("electron")>()),
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

const fake = sharedFakeSafeStorage();
type MockIpcMain = typeof ipcMain & {
	invokeHandler(channel: string, event: unknown): Promise<unknown>;
};
type MockBrowserWindow = typeof BrowserWindow & { openWindows: BrowserWindow[] };

describe("secure-storage IPC", () => {
	let window: BrowserWindow;
	let send: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fake.reset();
		fake.state.ready = false; // no keyring
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		window = new BrowserWindow();
		send = vi.fn();
		(window.webContents as unknown as { send: typeof send }).send = send;
		(BrowserWindow as MockBrowserWindow).openWindows.push(window);
	});

	afterEach(() => {
		(BrowserWindow as MockBrowserWindow).openWindows.length = 0;
		vi.restoreAllMocks();
	});

	it("answers the status and pushes it once a secret is written in clear", async () => {
		const { registerSecureStorageHandlers } = await import(
			"../secure-storage-handlers"
		);
		const { encryptSecret } = await import("../../secret-storage");
		registerSecureStorageHandlers();

		const pulled = await (ipcMain as MockIpcMain).invokeHandler(
			IPC_CHANNELS.SECURE_STORAGE_STATUS,
			{},
		);
		expect(pulled).toEqual({
			success: true,
			data: expect.objectContaining({
				keyringAvailable: false,
				secretsAtRisk: false,
			}),
		});

		encryptSecret("sk-proj-plain");

		expect(send).toHaveBeenCalledWith(
			IPC_CHANNELS.SECURE_STORAGE_STATUS_CHANGED,
			expect.objectContaining({ secretsAtRisk: true }),
		);
	});
});
