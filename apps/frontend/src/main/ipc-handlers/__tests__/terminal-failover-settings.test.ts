/**
 * The failover switches and chain order come from the renderer, which is not
 * trusted: the main keeps known switches, bounded thresholds and valid entries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	manager: {
		updateAutoSwitchSettings: vi.fn(),
		setAccountPriorityOrder: vi.fn(),
	},
	monitor: { stop: vi.fn(), start: vi.fn() },
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
		on: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
	},
}));
vi.mock("../../claude-profile/usage-monitor", () => ({ getUsageMonitor: () => mocks.monitor }));
vi.mock("../../claude-profile-manager", () => ({ getClaudeProfileManager: () => mocks.manager }));
vi.mock("../../project-store", () => ({ projectStore: {} }));
vi.mock("../../terminal-name-generator", () => ({ terminalNameGenerator: { generateName: vi.fn() } }));
vi.mock("../../settings-utils", () => ({ readSettingsFileAsync: vi.fn(async () => ({})) }));
vi.mock("../../utils/config-path-validator", () => ({ isValidConfigDir: () => true }));

import { registerTerminalHandlers } from "../terminal-handlers";

const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);

beforeEach(() => {
	mocks.handlers.clear();
	vi.clearAllMocks();
	registerTerminalHandlers({} as never, () => null);
});

describe("CLAUDE_PROFILE_UPDATE_AUTO_SWITCH", () => {
	it("saves only the known switches and bounded thresholds", async () => {
		expect(
			await call(IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, {
				enabled: true,
				sessionThreshold: 5,
				usageCheckInterval: 1,
			}),
		).toEqual({ success: true });
		expect(mocks.manager.updateAutoSwitchSettings).toHaveBeenCalledWith({ enabled: true });
		expect(mocks.monitor.start).toHaveBeenCalled();
	});

	it("refuses an update with nothing valid in it", async () => {
		expect(await call(IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH, { usageCheckInterval: 1 })).toEqual({
			success: false,
			error: "Invalid auto-switch settings",
		});
		expect(mocks.manager.updateAutoSwitchSettings).not.toHaveBeenCalled();
	});
});

describe("ACCOUNT_PRIORITY_SET", () => {
	it("saves the valid entries of the order", async () => {
		expect(await call(IPC_CHANNELS.ACCOUNT_PRIORITY_SET, ["oauth-a", "../x", "copilot"])).toEqual({ success: true });
		expect(mocks.manager.setAccountPriorityOrder).toHaveBeenCalledWith(["oauth-a", "provider-copilot"]);
	});

	it("refuses an order that is not a list of text", async () => {
		expect(await call(IPC_CHANNELS.ACCOUNT_PRIORITY_SET, { 0: "oauth-a" })).toEqual({
			success: false,
			error: "Invalid account priority order",
		});
		expect(mocks.manager.setAccountPriorityOrder).not.toHaveBeenCalled();
	});
});
