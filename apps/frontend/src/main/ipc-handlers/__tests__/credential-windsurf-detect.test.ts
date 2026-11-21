/**
 * @vitest-environment node
 *
 * The Windsurf key of the local IDE stays in the main process. Detecting
 * answers whether a key is installed and for which account, never the key;
 * saving reads the key again in main and writes it to settings.json, and the
 * mask the renderer sends back afterwards keeps it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	userData: "",
	detect: vi.fn(),
	plan: vi.fn(),
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => state.userData, getAppPath: () => state.userData },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) =>
				state.handlers.set(channel, handler),
		},
	};
});

vi.mock("../../services/credential-manager", () => ({
	credentialManager: {},
	detectWindsurfLocalToken: state.detect,
	readWindsurfCachedPlanInfo: state.plan,
}));

const FAKE_KEY = "sk-ws-FAKE-TEST-0000";

function call(channel: string): Promise<unknown> {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({});
}

const detect = () => call(IPC_CHANNELS.CREDENTIAL_DETECT_WINDSURF_TOKEN);
const saveDetected = () =>
	call(IPC_CHANNELS.CREDENTIAL_SAVE_DETECTED_WINDSURF_TOKEN);

beforeEach(async () => {
	state.handlers.clear();
	state.userData = mkdtempSync(path.join(tmpdir(), "windsurf-detect-"));
	state.detect.mockReset().mockResolvedValue({
		success: true,
		apiKey: FAKE_KEY,
		userName: "ide@example.com",
	});
	state.plan.mockReset().mockResolvedValue({ success: false });
	vi.resetModules();
	const { registerCredentialHandlers } = await import("../credential-handlers");
	registerCredentialHandlers();
});

afterEach(() => {
	rmSync(state.userData, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("credential:detectWindsurfToken", () => {
	it("answers the account and plan, never the key", async () => {
		state.plan.mockResolvedValue({
			success: true,
			userName: "Plan User",
			planInfo: {
				planName: "Pro",
				usage: {
					usedMessages: 100,
					messages: 500,
					usedFlowActions: 20,
					flowActions: 1000,
				},
			},
		});

		const result = await detect();

		expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
		expect(result).toEqual({
			success: true,
			userName: "Plan User",
			planName: "Pro",
			usageInfo: {
				usedMessages: 100,
				totalMessages: 500,
				usedFlowActions: 20,
				totalFlowActions: 1000,
			},
		});
	});

	it("keeps the IDE account name when the plan has none", async () => {
		state.plan.mockResolvedValue({
			success: true,
			planInfo: {
				planName: "Free",
				usage: {
					usedMessages: 0,
					messages: 0,
					usedFlowActions: 0,
					flowActions: 0,
				},
			},
		});

		const result = await detect();

		expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
		expect(result).toMatchObject({ userName: "ide@example.com", planName: "Free" });
	});

	it("answers the account alone without a cached plan", async () => {
		await expect(detect()).resolves.toEqual({
			success: true,
			userName: "ide@example.com",
		});
	});

	it("answers the account alone when the cached plan has no counters", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		state.plan.mockResolvedValue({
			success: true,
			planInfo: { planName: "Pro" },
		});

		const result = await detect();

		expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
		expect(result).toEqual({ success: true, userName: "ide@example.com" });
		expect(warn).toHaveBeenCalled();
	});

	it("says why when no key is installed", async () => {
		state.detect.mockResolvedValue({
			success: false,
			error: "Windsurf IDE not found",
		});

		await expect(detect()).resolves.toEqual({
			success: false,
			error: "Windsurf IDE not found",
		});
		expect(state.plan).not.toHaveBeenCalled();
	});
});

describe("credential:saveDetectedWindsurfToken", () => {
	it("stores the detected key in main; the mask sent back keeps it", async () => {
		const { readSettingsFile, writeSettingsFile } = await import(
			"../../settings-utils"
		);
		const { maskSettingsSecrets, unmaskSettingsUpdate } = await import(
			"../../settings-secrets"
		);
		writeSettingsFile({ language: "fr" });

		const result = await saveDetected();

		expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
		expect(result).toMatchObject({ success: true });
		const stored = readSettingsFile();
		expect(stored).toMatchObject({
			language: "fr",
			globalWindsurfApiKey: FAKE_KEY,
			globalWindsurfApiKeyEnabled: true,
		});
		expect(maskSettingsSecrets(stored ?? {}).globalWindsurfApiKey).toBe(
			MASKED_SECRET,
		);

		// What the dialog saves next, merged as SETTINGS_SAVE does.
		const update = unmaskSettingsUpdate(
			{
				language: "fr",
				globalWindsurfApiKey: MASKED_SECRET,
				globalWindsurfApiKeyEnabled: true,
			},
			stored ?? {},
		);
		writeSettingsFile({ ...stored, ...update });
		expect(readSettingsFile()?.globalWindsurfApiKey).toBe(FAKE_KEY);
	});

	it("writes a first settings file", async () => {
		await expect(saveDetected()).resolves.toMatchObject({ success: true });
		const { readSettingsFile } = await import("../../settings-utils");
		expect(readSettingsFile()?.globalWindsurfApiKey).toBe(FAKE_KEY);
	});

	it.each<[{ success: boolean; error?: string }]>([
		[{ success: false, error: "Windsurf IDE not found" }],
		[{ success: true }],
	])("writes nothing when no key is found (%o)", async (found) => {
		state.detect.mockResolvedValue(found);

		const result = await saveDetected();

		expect(result).toEqual({ success: false, error: found.error });
		const { readSettingsFile } = await import("../../settings-utils");
		expect(readSettingsFile()).toBeUndefined();
	});
});
