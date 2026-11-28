import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
	getAutoSwitchSettings: vi.fn(),
	getAccountPriorityOrder: vi.fn(),
	getSettings: vi.fn(),
	getActiveProfile: vi.fn(),
	setActiveProfile: vi.fn(),
	hasValidAuth: vi.fn(),
	isProfileRateLimited: vi.fn(),
};
const profilesFile = { profiles: [] as Array<{ id: string; baseUrl: string; apiKey?: string }>, activeProfileId: null as string | null };
const stopped = {
	value: null as null | {
		provider: string;
		projectId: string;
		specDirs: string[];
		pinKey?: string;
		pinnedAccount?: string;
	},
};
const excluded = { value: [] as string[] };
type Account = { id: string; provider: string; name: string; hasKey: boolean; createdAt: string };
const aiAccounts = {
	accounts: [] as Account[],
	defaults: {} as Record<string, string>,
	broken: false,
};
const account = (id: string, provider: string, hasKey = true): Account => ({
	id,
	provider,
	name: id.toUpperCase(),
	hasKey,
	createdAt: "2026-11-28T00:00:00.000Z",
});

vi.mock("../../claude-profile-manager", () => ({ getClaudeProfileManager: () => manager }));
vi.mock("../../services/profile/profile-manager", () => ({
	loadProfilesFile: vi.fn(async () => profilesFile),
	setActiveAPIProfile: vi.fn(async () => undefined),
}));
vi.mock("../../ipc-handlers/task/resume-with-provider", () => ({ resumeTaskWithProvider: vi.fn() }));
vi.mock("../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../task-phase-provider", () => ({
	FAILOVER_REQUEST_EVENT: "provider-failover-request",
	accountPinKey: (provider: string) =>
		provider === "anthropic" ? "claude" : ["openai", "mistral", "google"].includes(provider) ? provider : undefined,
	excludedEntries: () => excluded.value,
	stoppedTask: () => stopped.value,
}));
vi.mock("../../ai-accounts/ai-accounts", () => ({
	aiAccountStore: () => {
		if (aiAccounts.broken) throw new Error("unreadable");
		return { list: () => aiAccounts.accounts, defaults: () => aiAccounts.defaults };
	},
}));

import { resumeTaskWithProvider } from "../../ipc-handlers/task/resume-with-provider";
import { setActiveAPIProfile } from "../../services/profile/profile-manager";
import {
	buildFailoverChain,
	FAILOVER_REQUEST_EVENT,
	failoverEnabledFor,
	failTaskOver,
	isCoolingDown,
	offClaudeEntry,
	registerProviderFailover,
	resetProviderFailoverState,
} from "../provider-failover";

const resume = vi.mocked(resumeTaskWithProvider);
const setApi = vi.mocked(setActiveAPIProfile);
const NOW = 1_000_000_000;
const claude = (id: string) => ({ id, name: id }) as never;

function agent() {
	const emitter = new EventEmitter();
	const logs: string[] = [];
	emitter.on("log", (_task: string, line: string) => logs.push(line));
	return { emitter: emitter as never, logs, raw: emitter };
}

let specDir: string;

beforeEach(() => {
	resetProviderFailoverState();
	vi.clearAllMocks();
	specDir = mkdtempSync(path.join(tmpdir(), "failover-"));
	manager.getAutoSwitchSettings.mockReturnValue({
		enabled: true,
		autoSwitchOnRateLimit: true,
		autoSwitchOnAuthFailure: true,
	});
	manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "oauth-work", "provider-copilot", "api-mistral"]);
	manager.getSettings.mockReturnValue({ profiles: [claude("perso"), claude("work")] });
	manager.getActiveProfile.mockReturnValue({ id: "perso" });
	manager.hasValidAuth.mockReturnValue(true);
	manager.isProfileRateLimited.mockReturnValue({ limited: false });
	profilesFile.profiles = [{ id: "mistral", baseUrl: "https://api.mistral.ai/v1", apiKey: "k" }];
	profilesFile.activeProfileId = null;
	stopped.value = { provider: "anthropic", projectId: "p1", specDirs: [specDir] };
	excluded.value = [];
	aiAccounts.accounts = [];
	aiAccounts.defaults = {};
	aiAccounts.broken = false;
	resume.mockResolvedValue({ success: true });
});

afterEach(() => {
	rmSync(specDir, { recursive: true, force: true });
});

describe("failoverEnabledFor", () => {
	it("follows the master switch and the switch of the reason", () => {
		expect(failoverEnabledFor("rate_limit")).toBe(true);
		manager.getAutoSwitchSettings.mockReturnValue({ enabled: true, autoSwitchOnRateLimit: true, autoSwitchOnAuthFailure: false });
		expect(failoverEnabledFor("auth_failure")).toBe(false);
		manager.getAutoSwitchSettings.mockReturnValue({ enabled: false, autoSwitchOnRateLimit: true, autoSwitchOnAuthFailure: true });
		expect(failoverEnabledFor("rate_limit")).toBe(false);
	});
});

describe("buildFailoverChain", () => {
	it("keeps the entries whose account still exists, with their provider", () => {
		const chain = buildFailoverChain(
			["oauth-perso", "oauth-gone", "api-mistral", "api-gone", "provider-copilot", "provider-nope", "bad id"],
			[claude("perso")],
			[{ id: "mistral", baseUrl: "https://api.mistral.ai/v1" } as never],
		);
		expect(chain.map((c) => [c.id, c.provider])).toEqual([
			["oauth-perso", "anthropic"],
			["api-mistral", "mistral"],
			["provider-copilot", "copilot"],
		]);
	});

	it("falls back to the Claude accounts when no order was saved", () => {
		expect(buildFailoverChain([], [claude("a"), claude("b")], []).map((c) => c.id)).toEqual(["oauth-a", "oauth-b"]);
	});

	it("places the AI accounts the order names, then the ones it does not name yet", () => {
		const chain = buildFailoverChain(
			["account-o2", "oauth-a", "account-gone"],
			[claude("a")],
			[],
			[account("o1", "openai"), account("o2", "openai"), account("m1", "mistral")] as never,
		);
		expect(chain.map((c) => [c.id, c.provider])).toEqual([
			["account-o2", "openai"],
			["oauth-a", "anthropic"],
			["account-o1", "openai"],
			["account-m1", "mistral"],
		]);
	});
});

describe("offClaudeEntry", () => {
	const accounts = [account("o1", "openai"), account("o2", "openai"), account("m1", "mistral")] as never;

	it("is the pinned account, else the provider's default, else the provider", () => {
		expect(offClaudeEntry({ provider: "openai", pinKey: "openai", pinnedAccount: "o2" }, accounts, { openai: "o1" })).toBe(
			"account-o2",
		);
		expect(offClaudeEntry({ provider: "openai", pinKey: "openai" }, accounts, { openai: "o1" })).toBe("account-o1");
		expect(offClaudeEntry({ provider: "openai", pinKey: "openai" }, accounts, {})).toBe("provider-openai");
		expect(offClaudeEntry({ provider: "copilot" }, accounts, {})).toBe("provider-copilot");
	});

	it("ignores a pin or a default that names another provider's account, or none", () => {
		expect(offClaudeEntry({ provider: "openai", pinKey: "openai", pinnedAccount: "m1" }, accounts, { openai: "m1" })).toBe(
			"provider-openai",
		);
		expect(offClaudeEntry({ provider: "openai", pinKey: "openai", pinnedAccount: "gone" }, accounts, {})).toBe(
			"provider-openai",
		);
	});
});

describe("failTaskOver across the accounts of one provider", () => {
	const onOpenai = (pinnedAccount?: string) => ({
		provider: "openai",
		projectId: "p1",
		specDirs: [specDir],
		pinKey: "openai",
		pinnedAccount,
	});

	beforeEach(() => {
		stopped.value = onOpenai();
		aiAccounts.accounts = [account("o1", "openai"), account("o2", "openai"), account("o3", "openai"), account("m1", "mistral")];
		aiAccounts.defaults = { openai: "o1" };
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "account-m1", "account-o1", "account-o2", "account-o3"]);
	});

	it("moves the task to the next account of its provider and pins it on that task only", async () => {
		const { emitter, logs } = agent();
		const target = await failTaskOver(emitter, "t1", "rate_limit", "p1", NOW);
		expect(target?.id).toBe("account-o2");
		expect(resume).toHaveBeenCalledWith(emitter, "t1", "openai", {
			keepClaudeSession: false,
			accountPin: { key: "openai", id: "o2" },
		});
		expect(manager.setActiveProfile).not.toHaveBeenCalled();
		expect(logs.join("")).toContain("openai → openai (O2)");
	});

	it("starts from the account pinned on the task, not the provider's default", async () => {
		stopped.value = onOpenai("o2");
		// The chain is walked from the top: o1, the provider's default, comes first.
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", "p1", NOW))?.id).toBe("account-o1");
		expect(isCoolingDown("account-o2", NOW + 1000)).toBe(true);
		expect(isCoolingDown("account-o1", NOW + 1000)).toBe(false);
	});

	it("follows the chain's order across providers when same-provider-first is off", async () => {
		manager.getAutoSwitchSettings.mockReturnValue({
			enabled: true,
			autoSwitchOnRateLimit: true,
			autoSwitchOnAuthFailure: true,
			sameProviderFirst: false,
		});
		manager.hasValidAuth.mockReturnValue(false);
		const target = await failTaskOver(agent().emitter, "t1", "rate_limit", "p1", NOW);
		expect(target?.id).toBe("account-m1");
		expect(resume).toHaveBeenCalledWith(expect.anything(), "t1", "mistral", {
			keepClaudeSession: false,
			accountPin: { key: "mistral", id: "m1" },
		});
	});

	it("skips an account without a key and one that stopped another task lately", async () => {
		aiAccounts.accounts = [account("o1", "openai"), account("o2", "openai", false), account("o3", "openai")];
		stopped.value = onOpenai("o3");
		// Task 1 stops on o3 and moves to o1, the only other account with a key.
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", "p1", NOW))?.id).toBe("account-o1");
		expect(isCoolingDown("account-o3", NOW + 1000)).toBe(true);
		expect(isCoolingDown("account-o3", NOW + 61 * 60 * 1000)).toBe(false);
		// Task 2 stops on o1: o3 is still cooling down, o2 has no key.
		stopped.value = onOpenai("o1");
		manager.hasValidAuth.mockReturnValue(false);
		expect(await failTaskOver(agent().emitter, "t2", "rate_limit", "p1", NOW + 1000)).toBeNull();
	});

	it("keeps a refused key out of the chain longer than a limit", async () => {
		await failTaskOver(agent().emitter, "t1", "auth_failure", "p1", NOW);
		expect(isCoolingDown("account-o1", NOW + 2 * 60 * 60 * 1000)).toBe(true);
		expect(isCoolingDown("account-o1", NOW + 7 * 60 * 60 * 1000)).toBe(false);
	});

	it("starts from the Claude profile pinned on a Claude task", async () => {
		stopped.value = { provider: "anthropic", projectId: "p1", specDirs: [], pinKey: "claude", pinnedAccount: "work" };
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "oauth-work"]);
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", "p1", NOW))?.id).toBe("oauth-perso");
	});

	it("works without the AI accounts when their store cannot be read", async () => {
		aiAccounts.broken = true;
		manager.getAccountPriorityOrder.mockReturnValue(["account-o2", "provider-mistral"]);
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", "p1", NOW))?.id).toBe("provider-mistral");
	});
});

describe("failTaskOver", () => {
	it("moves a Claude task to the next Claude account and clears its pause files", async () => {
		writeFileSync(path.join(specDir, "RATE_LIMIT_PAUSE"), "x");
		const { emitter, logs } = agent();
		const target = await failTaskOver(emitter, "t1", "rate_limit", "p1", NOW);
		expect(target?.id).toBe("oauth-work");
		expect(manager.setActiveProfile).toHaveBeenCalledWith("work");
		expect(existsSync(path.join(specDir, "RATE_LIMIT_PAUSE"))).toBe(false);
		expect(resume).toHaveBeenCalledWith(emitter, "t1", "anthropic", {
			keepClaudeSession: false,
			accountPin: { key: "claude", id: "work" },
		});
		expect(logs.join("")).toContain("anthropic → anthropic (work)");
	});

	it("leaves an active API profile to sign in with a Claude account", async () => {
		profilesFile.activeProfileId = "mistral";
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-work"]);
		await failTaskOver(agent().emitter, "t1", "auth_failure", undefined, NOW);
		expect(setApi).toHaveBeenCalledWith(null);
		expect(manager.setActiveProfile).toHaveBeenCalledWith("work");
	});

	it("activates an Anthropic-compatible API profile", async () => {
		profilesFile.profiles = [{ id: "proxy", baseUrl: "https://llm.example.internal", apiKey: "k" }];
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "api-proxy"]);
		const target = await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW);
		expect(target?.id).toBe("api-proxy");
		expect(setApi).toHaveBeenCalledWith("proxy");
	});

	it("moves a task off another provider, skipping unusable accounts", async () => {
		stopped.value = { provider: "copilot", projectId: "p1", specDirs: [] };
		manager.hasValidAuth.mockImplementation((id: string) => id !== "perso");
		manager.isProfileRateLimited.mockReturnValue({ limited: true });
		profilesFile.profiles = [{ id: "mistral", baseUrl: "https://api.mistral.ai/v1" }];
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "oauth-work", "provider-copilot", "api-mistral", "provider-openai"]);
		const target = await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW);
		expect(target?.id).toBe("provider-openai");
		expect(manager.setActiveProfile).not.toHaveBeenCalled();
		expect(setApi).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalledWith(expect.anything(), "t1", "openai", { keepClaudeSession: false });
	});

	it("falls back to the Claude accounts when the stored order is broken", async () => {
		manager.getAccountPriorityOrder.mockReturnValue("oauth-work");
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW))?.id).toBe("oauth-work");
	});

	it("says so in the task log when no account is left", async () => {
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso"]);
		const { emitter, logs } = agent();
		expect(await failTaskOver(emitter, "t1", "rate_limit", undefined, NOW)).toBeNull();
		expect(logs.join("")).toContain("no other account available");
		expect(resume).not.toHaveBeenCalled();
	});

	it("does nothing when switched off, for an unknown task, or right after a move", async () => {
		manager.getAutoSwitchSettings.mockReturnValue({ enabled: false });
		expect(await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW)).toBeNull();
		manager.getAutoSwitchSettings.mockReturnValue({ enabled: true, autoSwitchOnRateLimit: true });

		stopped.value = null;
		expect(await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW)).toBeNull();
		stopped.value = { provider: "anthropic", projectId: "p1", specDirs: [] };

		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW))?.id).toBe("oauth-work");
		expect(await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW + 1000)).toBeNull();
		// Later, the tried entries are skipped: the chain goes on.
		expect((await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW + 60_000))?.id).toBe(
			"provider-copilot",
		);
	});

	it("stops after the most moves a task may make", async () => {
		manager.getAccountPriorityOrder.mockReturnValue(["oauth-perso", "oauth-work"]);
		manager.getActiveProfile.mockImplementation(() => ({ id: manager.setActiveProfile.mock.calls.at(-1)?.[0] ?? "perso" }));
		let moves = 0;
		for (let i = 0; i < 10; i++) {
			// Forget what was tried but not how often the task moved.
			if (await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW + i * 60_000)) moves += 1;
		}
		expect(moves).toBe(1);
		expect(await failTaskOver(agent().emitter, "t2", "rate_limit", undefined, NOW)).not.toBeNull();
	});

	it("caps the moves of a task even when the chain is long", async () => {
		const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
		manager.getSettings.mockReturnValue({ profiles: ids.map(claude) });
		manager.getAccountPriorityOrder.mockReturnValue(ids.map((id) => `oauth-${id}`));
		let moves = 0;
		for (let i = 0; i < 10; i++) {
			if (await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW + i * 60_000)) moves += 1;
		}
		expect(moves).toBe(6);
	});

	it("reports a resume that failed, and an error thrown on the way", async () => {
		resume.mockResolvedValueOnce({ success: false, error: "no" });
		expect(await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW)).toBeNull();
		manager.getSettings.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(await failTaskOver(agent().emitter, "t2", "rate_limit", undefined, NOW)).toBeNull();
	});

	it("does not start a second move of a task while one runs", async () => {
		let release!: () => void;
		resume.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ success: true }))));
		const first = failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW);
		await vi.waitFor(() => expect(resume).toHaveBeenCalled());
		expect(await failTaskOver(agent().emitter, "t1", "rate_limit", undefined, NOW + 60_000)).toBeNull();
		release();
		expect((await first)?.id).toBe("oauth-work");
	});
});

describe("registerProviderFailover", () => {
	it("moves a task on a pause phase and on a request from agent-process", async () => {
		const { emitter, raw } = agent();
		registerProviderFailover(emitter);
		raw.emit("execution-progress", "t1", { phase: "coding" }, "p1");
		raw.emit("execution-progress", "t1", undefined, "p1");
		expect(resume).not.toHaveBeenCalled();
		raw.emit("execution-progress", "t1", { phase: "rate_limit_paused" }, "p1");
		await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
		raw.emit(FAILOVER_REQUEST_EVENT, "t2", "auth_failure");
		await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
	});
});
