/**
 * @vitest-environment node
 *
 * The banner's one-click fix takes no argument from the renderer: the main
 * decides what it does (rule S6) — retry Windows DPAPI under WSL, relaunch
 * elsewhere on Linux, nothing when secrets are already encrypted.
 */

import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

const state = vi.hoisted(() => ({
	fix: null as "retry" | "restart" | null,
	retry: vi.fn(async () => true),
	relaunch: vi.fn(),
	exit: vi.fn(),
}));

vi.mock("electron", async (importOriginal) => {
	const electron = await importOriginal<typeof import("electron")>();
	return {
		...electron,
		app: { ...electron.app, relaunch: state.relaunch, exit: state.exit },
	};
});

vi.mock("../../secret-storage", () => ({
	getSecureStorageStatus: () => ({ fix: state.fix }),
	onSecureStorageStatusChange: () => () => undefined,
	retrySecretEncryption: state.retry,
	secureStorageFix: () => state.fix,
}));

type MockIpcMain = typeof ipcMain & {
	invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown>;
};

async function invokeFix(...args: unknown[]): Promise<unknown> {
	const { registerSecureStorageHandlers } = await import(
		"../secure-storage-handlers"
	);
	registerSecureStorageHandlers();
	return (ipcMain as MockIpcMain).invokeHandler(
		IPC_CHANNELS.SECURE_STORAGE_FIX,
		{},
		...args,
	);
}

describe("secure-storage fix IPC", () => {
	beforeEach(() => {
		state.retry.mockClear();
		state.relaunch.mockClear();
		state.exit.mockClear();
	});

	it("retries DPAPI under WSL and answers the new status", async () => {
		state.fix = "retry";
		expect(await invokeFix()).toEqual({ success: true, data: { fix: "retry" } });
		expect(state.retry).toHaveBeenCalledTimes(1);
		expect(state.relaunch).not.toHaveBeenCalled();
	});

	it("relaunches elsewhere on Linux, whatever the renderer passes", async () => {
		state.fix = "restart";
		await invokeFix("retry", { command: "rm -rf /" });
		expect(state.relaunch).toHaveBeenCalledTimes(1);
		expect(state.exit).toHaveBeenCalledWith(0);
		expect(state.retry).not.toHaveBeenCalled();
	});

	it("does nothing when secrets are already encrypted", async () => {
		state.fix = null;
		await invokeFix("restart");
		expect(state.retry).not.toHaveBeenCalled();
		expect(state.relaunch).not.toHaveBeenCalled();
	});
});
