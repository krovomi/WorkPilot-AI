/**
 * Every usage snapshot reaches the renderer with its account's plan: the
 * IPC answers and the forwarded monitor events alike, in the order the
 * monitor emitted them.
 */
import { EventEmitter } from "node:events";
import type { AllProfilesUsage, UsageSnapshot } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	monitor: null as unknown as EventEmitter & Record<string, unknown>,
	withUsagePlan: vi.fn(),
	withProfilesPlans: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
		on: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));
vi.mock("../../claude-profile/usage-monitor", () => ({
	getUsageMonitor: () => mocks.monitor,
}));
vi.mock("../../claude-profile/usage-plan", () => ({
	withUsagePlan: mocks.withUsagePlan,
	withProfilesPlans: mocks.withProfilesPlans,
}));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({}),
}));
vi.mock("../../project-store", () => ({ projectStore: {} }));
vi.mock("../../terminal-name-generator", () => ({
	terminalNameGenerator: { generateName: vi.fn() },
}));
vi.mock("../../settings-utils", () => ({
	readSettingsFileAsync: vi.fn(async () => ({})),
}));
vi.mock("../../utils/config-path-validator", () => ({
	isValidConfigDir: () => true,
}));

import {
	initializeUsageMonitorForwarding,
	registerTerminalHandlers,
} from "../terminal-handlers";

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sessionPercent: 1,
		weeklyPercent: 2,
		profileId: "p",
		profileName: "P",
		fetchedAt: new Date(),
		providerName: "anthropic",
		...overrides,
	};
}

const PRO = { billing: "subscription", name: "Claude Pro" } as const;

beforeEach(() => {
	mocks.handlers.clear();
	const monitor = new EventEmitter() as EventEmitter & Record<string, unknown>;
	monitor.onProviderRequestIfChanged = vi.fn();
	monitor.getUsageForProvider = vi.fn(async () => snapshot());
	monitor.getCurrentUsage = vi.fn(() => snapshot({ profileId: "current" }));
	monitor.getAllProfilesUsage = vi.fn(async () => ({
		activeProfile: snapshot(),
		allProfiles: [],
		fetchedAt: new Date(),
	}));
	mocks.monitor = monitor;
	mocks.withUsagePlan.mockReset();
	mocks.withUsagePlan.mockImplementation(async (u: UsageSnapshot | null) =>
		u ? { ...u, plan: PRO } : u,
	);
	mocks.withProfilesPlans.mockReset();
	mocks.withProfilesPlans.mockImplementation(async (u: AllProfilesUsage) => ({
		...u,
		activeProfile: { ...u.activeProfile, plan: PRO },
	}));
	registerTerminalHandlers({} as never, () => null);
});

describe("usage IPC answers carry the plan", () => {
	it("adds the plan to a provider's snapshot and to the emitted event", async () => {
		const emitted: UsageSnapshot[] = [];
		mocks.monitor.on("usage-updated", (u: UsageSnapshot) => emitted.push(u));
		const handler = mocks.handlers.get(IPC_CHANNELS.USAGE_REQUEST);
		const result = (await handler?.({}, "anthropic")) as {
			success: boolean;
			data: UsageSnapshot;
		};
		expect(result.data.plan).toEqual(PRO);
		expect(emitted[0].plan).toEqual(PRO);
	});

	it("adds the plan to the current snapshot, and passes no snapshot through", async () => {
		const handler = mocks.handlers.get(IPC_CHANNELS.USAGE_REQUEST);
		const current = (await handler?.({})) as { data: UsageSnapshot };
		expect(current.data.profileId).toBe("current");
		expect(current.data.plan).toEqual(PRO);

		(mocks.monitor.getCurrentUsage as ReturnType<typeof vi.fn>).mockReturnValue(
			null,
		);
		const none = (await handler?.({})) as { success: boolean; data: unknown };
		expect(none).toEqual({ success: true, data: null });
	});

	it("adds the plans to every account's usage", async () => {
		const handler = mocks.handlers.get(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST);
		const result = (await handler?.({}, true)) as {
			data: AllProfilesUsage;
		};
		expect(result.data.activeProfile.plan).toEqual(PRO);
		expect(mocks.monitor.getAllProfilesUsage).toHaveBeenCalledWith(true);
	});
});

describe("forwarded monitor events carry the plan", () => {
	function window() {
		const sent: Array<[string, unknown]> = [];
		const send = vi.fn((channel: string, payload: unknown) => {
			sent.push([channel, payload]);
		});
		return { sent, send, win: { webContents: { send } } as never };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("sends each update with its plan, in the order emitted", async () => {
		const { sent, win } = window();
		initializeUsageMonitorForwarding(win);
		let release: () => void = () => undefined;
		mocks.withUsagePlan.mockImplementationOnce(
			(u: UsageSnapshot) =>
				new Promise((resolve) => {
					release = () => resolve({ ...u, plan: PRO });
				}),
		);
		mocks.monitor.emit("usage-updated", snapshot({ profileId: "first" }));
		mocks.monitor.emit("usage-updated", snapshot({ profileId: "second" }));
		await settle();
		expect(sent).toHaveLength(0);
		release();
		await settle();
		expect(sent.map(([, u]) => (u as UsageSnapshot).profileId)).toEqual([
			"first",
			"second",
		]);
		expect(sent[0][0]).toBe(IPC_CHANNELS.USAGE_UPDATED);
		expect((sent[0][1] as UsageSnapshot).plan).toEqual(PRO);
	});

	it("sends the bare snapshot when the plan lookup fails", async () => {
		const { sent, win } = window();
		initializeUsageMonitorForwarding(win);
		mocks.withUsagePlan.mockRejectedValueOnce(new Error("boom"));
		mocks.withProfilesPlans.mockRejectedValueOnce(new Error("boom"));
		const usage = snapshot();
		const all: AllProfilesUsage = {
			activeProfile: usage,
			allProfiles: [],
			fetchedAt: new Date(),
		};
		mocks.monitor.emit("usage-updated", usage);
		mocks.monitor.emit("all-profiles-usage-updated", all);
		await settle();
		expect(sent).toEqual([
			[IPC_CHANNELS.USAGE_UPDATED, usage],
			[IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, all],
		]);
	});

	it("keeps forwarding after a send to a closed window throws", async () => {
		const { sent, send, win } = window();
		initializeUsageMonitorForwarding(win);
		send.mockImplementationOnce(() => {
			throw new Error("Object has been destroyed");
		});
		mocks.monitor.emit("usage-updated", snapshot({ profileId: "lost" }));
		mocks.monitor.emit(
			"all-profiles-usage-updated",
			{
				activeProfile: snapshot(),
				allProfiles: [],
				fetchedAt: new Date(),
			} satisfies AllProfilesUsage,
		);
		await settle();
		expect(sent).toHaveLength(1);
		expect(sent[0][0]).toBe(IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED);
		expect((sent[0][1] as AllProfilesUsage).activeProfile.plan).toEqual(PRO);
	});
});
