/**
 * CredentialManager: profiles, provider switching, connection tests and the
 * environment handed to the Python backend.
 *
 * settings.json and profiles.json are held in memory behind their real
 * modules' contracts (neither read ever throws; a file can still be
 * malformed). Provider APIs are answered by a stubbed `fetch`, except the
 * local LLM probe, which talks to a real HTTP server on 127.0.0.1. The Claude
 * CLI profile files are real files under a temporary home.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeProfile } from "../../../shared/types/agent";
import type { ProfilesFile } from "../../../shared/types/profile";
import type { ClaudeProfileManager } from "../../claude-profile-manager";

const store = vi.hoisted(() => ({
	settings: undefined as Record<string, unknown> | undefined,
	profiles: { profiles: [], activeProfileId: null, version: 1 } as unknown,
	savedProfiles: [] as unknown[],
	savedSettings: [] as Record<string, unknown>[],
	saveProfilesError: null as Error | null,
	writeSettingsError: null as Error | null,
	claudeManager: null as unknown,
}));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () =>
		store.settings ? structuredClone(store.settings) : undefined,
	writeSettingsFile: (settings: Record<string, unknown>) => {
		if (store.writeSettingsError) throw store.writeSettingsError;
		store.savedSettings.push(structuredClone(settings));
		store.settings = structuredClone(settings);
	},
}));

vi.mock("../../utils/profile-manager", () => ({
	loadProfilesFile: async () => structuredClone(store.profiles),
	saveProfilesFile: async (data: unknown) => {
		if (store.saveProfilesError) throw store.saveProfilesError;
		store.savedProfiles.push(structuredClone(data));
		store.profiles = structuredClone(data);
	},
}));

vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => store.claudeManager,
}));

import { CredentialManager } from "../credential-manager";

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];
let fetchRoutes: Array<(url: string) => Response | Promise<Response> | undefined>;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, statusText = "OK"): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { "Content-Type": "application/json" },
	});
}

function profile(
	id: string,
	baseUrl: string,
	apiKey: string,
	name = id,
): ProfilesFile["profiles"][number] {
	return { id, name, baseUrl, apiKey, createdAt: 0, updatedAt: 0 };
}

function setProfiles(
	profiles: ProfilesFile["profiles"],
	activeProfileId: string | null = null,
): void {
	store.profiles = { profiles, activeProfileId, version: 1 };
}

let home: string;
const savedEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	APPDATA: process.env.APPDATA,
};

beforeEach(() => {
	store.settings = undefined;
	setProfiles([]);
	store.savedProfiles = [];
	store.savedSettings = [];
	store.saveProfilesError = null;
	store.writeSettingsError = null;
	store.claudeManager = null;
	home = mkdtempSync(join(tmpdir(), "cred-manager-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.APPDATA = join(home, "AppData", "Roaming");
	fetchCalls = [];
	fetchRoutes = [];
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		fetchCalls.push({ url, init });
		if (url.startsWith("http://127.0.0.1:")) return realFetch(url, init);
		for (const route of fetchRoutes) {
			const answer = await route(url);
			if (answer) return answer;
		}
		throw new TypeError(`fetch failed: ${url}`);
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.env.HOME = savedEnv.HOME;
	process.env.USERPROFILE = savedEnv.USERPROFILE;
	if (savedEnv.APPDATA === undefined) delete process.env.APPDATA;
	else process.env.APPDATA = savedEnv.APPDATA;
	rmSync(home, { recursive: true, force: true });
});

describe("initialize", () => {
	it("drops the placeholder profiles a past version generated and repoints the active one", async () => {
		setProfiles(
			[
				profile("fake", "https://api.anthropic.com", "sk-ant-placeholder", ""),
				profile("real", "https://api.openai.com/v1", "sk-real-openai-key", "Work"),
			],
			"fake",
		);

		await new CredentialManager().initialize();

		expect(store.savedProfiles).toHaveLength(1);
		const saved = store.savedProfiles[0] as ProfilesFile;
		expect(saved.profiles.map((p) => p.id)).toEqual(["real"]);
		expect(saved.activeProfileId).toBe("real");
		expect(console.warn).toHaveBeenCalledWith(
			"[CredentialManager] Removed 1 placeholder profile(s): fake",
		);
	});

	it("leaves the active pointer alone when it survives, and empties it when nothing is left", async () => {
		setProfiles(
			[
				profile("a", "https://api.openai.com/v1", "sk-real-openai-key"),
				profile("b", "https://api.openai.com/v1", "test-123"),
			],
			"a",
		);
		await new CredentialManager().initialize();
		expect((store.savedProfiles[0] as ProfilesFile).activeProfileId).toBe("a");

		setProfiles([profile("only", "https://x.example", "")], "only");
		store.savedProfiles = [];
		await new CredentialManager().initialize();
		expect((store.savedProfiles[0] as ProfilesFile).activeProfileId).toBeNull();
	});

	it("does not rewrite profiles.json when there is nothing to remove", async () => {
		setProfiles([profile("a", "https://api.openai.com/v1", "sk-real-key")]);
		await new CredentialManager().initialize();
		expect(store.savedProfiles).toEqual([]);
	});

	it("keeps going when the cleanup cannot save", async () => {
		setProfiles(
			[profile("fake", "https://api.anthropic.com", "test-x")],
			"fake",
		);
		store.saveProfilesError = new Error("disk full");
		const manager = new CredentialManager();
		await manager.initialize();
		// The profile list in memory still names "fake": nothing was saved.
		expect(manager.getActiveCredential()?.credentials.profileId).toBe("fake");
	});

	it("logs instead of throwing when profiles.json has no profile list", async () => {
		store.profiles = { activeProfileId: "x", version: 1 };
		await new CredentialManager().initialize();
		expect(console.error).toHaveBeenCalledWith(
			"[CredentialManager] Failed to initialize:",
			expect.any(TypeError),
		);
	});
});

describe("active credential restored at startup", () => {
	it("comes from the active API profile, with its provider read from the URL", async () => {
		setProfiles(
			[
				profile("p1", "https://api.openai.com/v1", "sk-openai-real", "OpenAI"),
				profile("p2", "https://llm.internal.example", "key-2", "Internal"),
			],
			"p1",
		);
		const manager = new CredentialManager();
		await manager.initialize();
		expect(manager.getActiveCredential()).toMatchObject({
			provider: "openai",
			type: "api_key",
			credentials: {
				apiKey: "sk-openai-real",
				baseUrl: "https://api.openai.com/v1",
				profileId: "p1",
				profileName: "OpenAI",
			},
			isActive: true,
		});

		setProfiles(store.profiles ? (store.profiles as ProfilesFile).profiles : [], "p2");
		const second = new CredentialManager();
		await second.initialize();
		expect(second.getActiveCredential()?.provider).toBe("custom");
	});

	it.each([
		[
			"a Windsurf key with Windsurf selected",
			{ selectedProvider: "windsurf", globalWindsurfApiKey: " sk-ws-1 " },
			{ provider: "windsurf", type: "api_key", credentials: { apiKey: "sk-ws-1" } },
		],
		[
			"another provider chosen in the settings",
			{ selectedProvider: "copilot", globalWindsurfApiKey: "sk-ws-1" },
			{ provider: "copilot", type: "oauth", credentials: {} },
		],
		[
			"Windsurf chosen without a key (SSO)",
			{ selectedProvider: "windsurf" },
			{ provider: "windsurf", type: "oauth", credentials: {} },
		],
		[
			"a Windsurf key and no choice saved",
			{ globalWindsurfApiKey: "sk-ws-2" },
			{ provider: "windsurf", type: "api_key", credentials: { apiKey: "sk-ws-2" } },
		],
	])("comes from settings.json: %s", async (_label, settings, expected) => {
		store.settings = settings;
		setProfiles([], "gone");
		const manager = new CredentialManager();
		await manager.initialize();
		expect(manager.getActiveCredential()).toMatchObject(expected);
	});

	it.each([
		["Claude chosen", { selectedProvider: "claude", globalWindsurfApiKey: "k" }],
		["Anthropic chosen", { selectedProvider: "anthropic" }],
		["nothing saved", {}],
	])("stays empty when %s", async (_label, settings) => {
		store.settings = settings;
		const manager = new CredentialManager();
		await manager.initialize();
		expect(manager.getActiveCredential()).toBeNull();
	});

	it("survives a settings.json whose Windsurf key is not text", async () => {
		store.settings = { globalWindsurfApiKey: 42 };
		const manager = new CredentialManager();
		await manager.initialize();
		expect(manager.getActiveCredential()).toBeNull();
	});
});

describe("events", () => {
	it("reloads the active credential when the profiles change", async () => {
		const manager = new CredentialManager();
		await manager.initialize();
		expect(manager.getActiveCredential()).toBeNull();

		setProfiles(
			[profile("p", "https://api.mistral.ai/v1", "mistral-key")],
			"p",
		);
		const updated = new Promise((resolve) =>
			manager.once("credential:updated", resolve),
		);
		manager.emit("profile:changed");
		await expect(updated).resolves.toMatchObject({ provider: "mistral" });
	});

	it("stores and re-announces usage data", async () => {
		const manager = new CredentialManager();
		await manager.initialize();
		const changed = vi.fn();
		manager.on("usage:changed", changed);

		manager.updateUsageData("openai", { usage: { sessionPercent: 10 } });
		manager.updateUsageData("openai", { profileName: "Work" });

		expect(manager.getUsageData("openai")).toMatchObject({
			provider: "openai",
			profileName: "Work",
			usage: { sessionPercent: 10 },
		});
		expect(changed).toHaveBeenCalledTimes(2);
		expect(manager.getUsageData("mistral")).toBeNull();

		const copy = manager.getAllUsageData();
		copy.delete("openai");
		expect(manager.getUsageData("openai")).not.toBeNull();
	});

	it("forgets everything on cleanup", async () => {
		setProfiles([profile("p", "https://api.openai.com", "sk-1")], "p");
		const manager = new CredentialManager();
		await manager.initialize();
		manager.updateUsageData("openai", {});
		manager.cleanup();
		expect(manager.getActiveCredential()).toBeNull();
		expect(manager.getAllUsageData().size).toBe(0);
		expect(manager.listenerCount("usage:updated")).toBe(0);
	});
});

describe("setActiveProvider", () => {
	it("activates an API profile, saves it and the provider choice, and says so", async () => {
		setProfiles([profile("p", "https://api.deepseek.com", "ds-key", "DS")]);
		const manager = new CredentialManager();
		const switched = vi.fn();
		const updated = vi.fn();
		manager.on("provider:switched", switched);
		manager.on("credential:updated", updated);

		await manager.setActiveProvider("deepseek", "api_key", "p");

		expect((store.profiles as ProfilesFile).activeProfileId).toBe("p");
		expect(store.settings?.selectedProvider).toBe("deepseek");
		expect(manager.getActiveCredential()).toMatchObject({
			provider: "deepseek",
			type: "api_key",
			credentials: { apiKey: "ds-key", profileId: "p", profileName: "DS" },
		});
		expect(switched).toHaveBeenCalledWith({ provider: "deepseek", type: "api_key" });
		expect(updated).toHaveBeenCalledOnce();
	});

	it("refuses an unknown profile", async () => {
		const manager = new CredentialManager();
		await expect(
			manager.setActiveProvider("openai", "api_key", "missing"),
		).rejects.toThrow("Profile missing not found");
		expect(store.settings).toBeUndefined();
	});

	it("switches to OAuth by clearing the active API profile", async () => {
		setProfiles([profile("p", "https://api.openai.com", "sk-1")], "p");
		store.settings = { theme: "dark" };
		const manager = new CredentialManager();
		await manager.initialize();

		await manager.setActiveProvider("copilot", "oauth");

		expect((store.profiles as ProfilesFile).activeProfileId).toBeNull();
		expect(store.settings).toEqual({ theme: "dark", selectedProvider: "copilot" });
		expect(manager.getActiveCredential()).toMatchObject({
			provider: "copilot",
			type: "oauth",
			credentials: {},
		});
	});

	it("still switches when settings.json cannot be written", async () => {
		store.writeSettingsError = new Error("read-only");
		const manager = new CredentialManager();
		await manager.setActiveProvider("windsurf", "oauth");
		expect(manager.getActiveCredential()?.provider).toBe("windsurf");
		expect(console.warn).toHaveBeenCalledWith(
			"[CredentialManager] Failed to persist selectedProvider to settings.json:",
			store.writeSettingsError,
		);
	});

	it("only records the provider for an API-key switch that names no profile", async () => {
		const manager = new CredentialManager();
		await manager.setActiveProvider("openai", "api_key");
		expect(manager.getActiveCredential()).toBeNull();
		expect(store.settings?.selectedProvider).toBe("openai");
	});

	it("passes on a failure to save profiles.json", async () => {
		store.saveProfilesError = new Error("disk full");
		const manager = new CredentialManager();
		await expect(manager.setActiveProvider("copilot", "oauth")).rejects.toThrow(
			"disk full",
		);
		expect(console.error).toHaveBeenCalled();
	});
});

describe("testProvider: Anthropic", () => {
	/** The three calls the credential manager makes, typed against the real class. */
	type ProfileManagerSeam = Pick<
		ClaudeProfileManager,
		"getActiveProfile" | "hasValidAuth" | "getSettings"
	>;
	function claudeManager(opts: {
		active?: { id: string; email?: string; name?: string };
		valid?: string[];
		all?: Array<{ id: string; email?: string; name?: string }>;
	}): ProfileManagerSeam {
		return {
			getActiveProfile: () => opts.active as ClaudeProfile,
			hasValidAuth: (id?: string) => (opts.valid ?? []).includes(id ?? ""),
			getSettings: () => ({
				profiles: (opts.all ?? []) as ClaudeProfile[],
				activeProfileId: "",
			}),
		};
	}

	it("trusts the app's active Claude profile", async () => {
		store.claudeManager = claudeManager({
			active: { id: "c1", email: "me@example.com" },
			valid: ["c1"],
		});
		await expect(new CredentialManager().testProvider("claude")).resolves.toEqual({
			success: true,
			message: "Anthropic OAuth authentication active",
			details: { method: "OAuth", profile: "me@example.com" },
		});
	});

	it("finds a signed-in profile that is not the active one, then falls back on names", async () => {
		store.claudeManager = claudeManager({
			active: { id: "c1", name: "Main" },
			valid: ["c2"],
			all: [{ id: "c1", name: "Main" }, { id: "c2", name: "Second" }],
		});
		const result = await new CredentialManager().testProvider("anthropic");
		expect(result.details).toEqual({ method: "OAuth", profile: "Second" });

		store.claudeManager = claudeManager({ active: { id: "c1" }, valid: ["c1"] });
		expect(
			(await new CredentialManager().testProvider("claude")).details,
		).toEqual({ method: "OAuth", profile: "Claude OAuth" });

		store.claudeManager = claudeManager({ valid: ["c3"], all: [{ id: "c3" }] });
		expect(
			(await new CredentialManager().testProvider("claude")).details,
		).toEqual({ method: "OAuth", profile: "Claude OAuth" });
	});

	it("does not take a signed-out active profile when the manager lists no others", async () => {
		store.claudeManager = claudeManager({ active: { id: "c1" } });
		expect((await new CredentialManager().testProvider("claude")).success).toBe(
			false,
		);
	});

	it("reads an authenticated profile from the Claude CLI's profiles.json", async () => {
		store.claudeManager = claudeManager({ all: [] });
		const dir = join(home, ".config", "claude-code");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "profiles.json"),
			JSON.stringify({
				profiles: [
					{ name: "Off", isAuthenticated: false },
					{ name: "CLI user", isAuthenticated: true },
				],
			}),
			"utf-8",
		);
		// A broken or listless file elsewhere is skipped, not fatal.
		const appData = join(home, "AppData", "Roaming", "claude");
		mkdirSync(appData, { recursive: true });
		writeFileSync(join(appData, "profiles.json"), "{not json", "utf-8");
		const config = join(home, ".config", "claude");
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "profiles.json"), '{"profiles":{}}', "utf-8");

		const result = await new CredentialManager().testProvider("claude");
		expect(result).toMatchObject({
			success: true,
			details: { profile: "CLI user" },
		});
	});

	it("skips a CLI profile list with nobody signed in", async () => {
		delete process.env.APPDATA;
		const dir = join(home, ".config", "claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "profiles.json"),
			JSON.stringify({ profiles: [{ name: "Off" }] }),
			"utf-8",
		);
		const result = await new CredentialManager().testProvider("claude");
		expect(result.success).toBe(false);
	});

	it("accepts a real Anthropic API profile, never a placeholder one", async () => {
		setProfiles([
			profile("x", "https://api.anthropic.com", "sk-ant-placeholder"),
		]);
		expect((await new CredentialManager().testProvider("claude")).success).toBe(
			false,
		);

		setProfiles([
			profile("y", "https://api.anthropic.com", "sk-ant-api03-real", "Mine"),
		]);
		expect(
			(await new CredentialManager().testProvider("claude")).details,
		).toEqual({ method: "OAuth", profile: "Mine" });

		setProfiles([profile("z", "https://api.anthropic.com", "sk-ant-api03-real", "")]);
		expect(
			(await new CredentialManager().testProvider("claude")).details,
		).toEqual({ method: "OAuth", profile: "Anthropic (API Key)" });
	});

	it("accepts a global Anthropic key from the settings", async () => {
		store.settings = { globalAnthropicApiKey: "sk-ant-global" };
		expect(
			(await new CredentialManager().testProvider("claude")).details,
		).toEqual({ method: "OAuth", profile: "Anthropic (API Key)" });
	});

	it("says how to sign in when nothing is found", async () => {
		store.claudeManager = {
			getActiveProfile: () => {
				throw new Error("not initialised");
			},
		};
		store.profiles = { version: 1 };
		store.settings = { globalAnthropicApiKey: 7 };
		await expect(new CredentialManager().testProvider("claude")).resolves.toEqual({
			success: false,
			message:
				"Anthropic not authenticated. Please sign in with Claude Code or OAuth.",
		});
	});

	it("answers through the public wrapper used by the IPC handlers", async () => {
		store.settings = { globalAnthropicApiKey: "sk-ant-global" };
		await expect(
			new CredentialManager().checkClaudeOAuthStatusPublic(),
		).resolves.toEqual({
			isAuthenticated: true,
			profileName: "Anthropic (API Key)",
		});
	});
});

describe("testProvider: local LLM server", () => {
	let server: Server | null = null;

	async function serve(paths: string[]): Promise<string> {
		server = createServer((req, res) => {
			if (paths.includes(req.url ?? "")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	afterEach(async () => {
		await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
		server = null;
	});

	it("finds an OpenAI-compatible server (LM Studio, vLLM) from a chat URL", async () => {
		const root = await serve(["/v1/models"]);
		store.settings = { globalOllamaApiUrl: `${root}/v1/chat/completions/` };
		await expect(new CredentialManager().testProvider("lmstudio")).resolves.toEqual({
			success: true,
			message: `Serveur LLM local accessible (${root})`,
			details: { baseUrl: root, endpoint: "/v1/models" },
		});
	});

	it("falls back to Ollama's native tag list", async () => {
		const root = await serve(["/api/tags"]);
		store.settings = { globalOllamaBaseUrl: `${root}/v1` };
		const result = await new CredentialManager().testProvider("ollama");
		expect(result).toMatchObject({
			success: true,
			details: { baseUrl: root, endpoint: "/api/tags" },
		});
	});

	it("strips a bare /chat/completions suffix too", async () => {
		const root = await serve(["/v1/models"]);
		store.settings = { globalOllamaApiUrl: `${root}/chat/completions` };
		const result = await new CredentialManager().testProvider("local");
		expect(result.details).toMatchObject({ baseUrl: root });
	});

	it("says the server cannot be reached, on the default port when none is set", async () => {
		const result = await new CredentialManager().testProvider("ollama");
		expect(result).toEqual({
			success: false,
			message:
				"Serveur LLM local injoignable à http://localhost:11434. Vérifie qu'Ollama/LM Studio tourne et que l'URL est correcte.",
		});
		expect(fetchCalls.map((c) => c.url)).toEqual([
			"http://localhost:11434/v1/models",
			"http://localhost:11434/api/tags",
		]);
	});

	it("reports a broken URL setting instead of throwing", async () => {
		store.settings = { globalOllamaApiUrl: 11434 };
		const result = await new CredentialManager().testProvider("ollama");
		expect(result.success).toBe(false);
		expect(console.error).toHaveBeenCalled();
	});
});

describe("testProvider: API-key providers", () => {
	it("tests a preset OpenAI profile at /v1/models, not /v1/v1/models", async () => {
		setProfiles([
			profile("o", "https://api.openai.com/v1", "sk-openai-real", "Work"),
		]);
		fetchRoutes.push((url) =>
			url === "https://api.openai.com/v1/models"
				? json({ data: [{ id: "a" }, { id: "b" }] })
				: undefined,
		);
		await expect(new CredentialManager().testProvider("openai")).resolves.toEqual({
			success: true,
			message: "openai connection successful",
			details: {
				method: "API Key",
				profileName: "Work",
				status: 200,
				modelCount: 2,
			},
		});
		expect(fetchCalls[0].init?.headers).toEqual({
			Authorization: "Bearer sk-openai-real",
		});
	});

	it("tests a Mistral preset profile the same way", async () => {
		setProfiles([profile("m", "https://api.mistral.ai/v1/", "mistral-key", "")]);
		fetchRoutes.push((url) =>
			url === "https://api.mistral.ai/v1/models" ? json({ models: [1] }) : undefined,
		);
		const result = await new CredentialManager().testProvider("mistral");
		expect(result.details).toMatchObject({ profileName: "mistral", modelCount: 1 });
	});

	it("prefers an OpenAI Codex CLI login over any key", async () => {
		const result = await new CredentialManager(async () => true).testProvider(
			"openai",
		);
		expect(result).toEqual({
			success: true,
			message: "OpenAI Codex CLI authentication active",
			details: { method: "OAuth (Codex CLI)", profile: "OpenAI Codex CLI" },
		});
		expect(fetchCalls).toEqual([]);
	});

	it.each([
		[
			"google",
			{ globalGoogleApiKey: " g-key " },
			"https://generativelanguage.googleapis.com/v1/models",
		],
		[
			"gemini",
			{ globalGoogleDeepMindApiKey: "dm-key" },
			"https://generativelanguage.googleapis.com/v1/models",
		],
		["deepseek", { globalDeepSeekApiKey: "ds" }, "https://api.deepseek.com/v1/models"],
		["grok", { globalGrokApiKey: "gk" }, "https://api.x.ai/v1/models"],
		["openai", { globalOpenAIApiKey: "sk-1" }, "https://api.openai.com/v1/models"],
	])("tests %s with the key from the settings", async (provider, settings, url) => {
		store.settings = settings;
		fetchRoutes.push((u) => (u === url ? json({}) : undefined));
		const result = await new CredentialManager(async () => false).testProvider(
			provider,
		);
		expect(result).toMatchObject({
			success: true,
			details: { method: "API Key", profileName: provider, status: 200 },
		});
		expect(fetchCalls.map((c) => c.url)).toEqual([url]);
	});

	it("sends a Google key in its header, never in the URL", async () => {
		store.settings = { globalGoogleApiKey: "g-key" };
		fetchRoutes.push(() => json({}));
		await new CredentialManager(async () => false).testProvider("google");
		const [call] = fetchCalls;
		expect(call.url).not.toContain("g-key");
		expect(call.init?.headers).toEqual({ "x-goog-api-key": "g-key" });
	});

	it("skips a placeholder profile and uses the global key", async () => {
		setProfiles([profile("g", "https://api.deepseek.com", "test-fake")]);
		store.settings = { globalDeepSeekApiKey: "real-ds" };
		fetchRoutes.push(() => json({}));
		await new CredentialManager().testProvider("deepseek");
		expect(fetchCalls[0].init?.headers).toEqual({ Authorization: "Bearer real-ds" });
	});

	it("uses the active credential when nothing else has a key", async () => {
		setProfiles(
			[profile("p", "https://api.deepseek.com/v1", "ds-active", "Active")],
			"p",
		);
		const manager = new CredentialManager();
		await manager.initialize();
		// Read the profile list as missing from now on.
		store.profiles = { version: 1 };
		fetchRoutes.push(() => json({}));
		const result = await manager.testProvider("deepseek");
		expect(result.details).toMatchObject({ profileName: "Active" });
		expect(fetchCalls[0].url).toBe("https://api.deepseek.com/v1/models");
	});

	it("says what is missing when no key exists", async () => {
		store.settings = { globalMistralApiKey: "   " };
		await expect(new CredentialManager().testProvider("mistral")).resolves.toEqual({
			success: false,
			message:
				"Provider mistral not configured. Add an API key in Custom Endpoints or provider settings.",
		});
		store.settings = { globalMistralApiKey: 5 };
		expect((await new CredentialManager().testProvider("mistral")).success).toBe(
			false,
		);
		store.settings = undefined;
		expect((await new CredentialManager().testProvider("nobody")).success).toBe(
			false,
		);
	});

	it("reports the HTTP status of a refused key", async () => {
		store.settings = { globalGrokApiKey: "bad" };
		fetchRoutes.push(() => json({}, 401, "Unauthorized"));
		await expect(new CredentialManager().testProvider("grok")).resolves.toEqual({
			success: false,
			message: "grok API returned HTTP 401: Unauthorized",
		});
	});

	it("reports a network failure, and an answer that is not JSON", async () => {
		store.settings = { globalOpenAIApiKey: "sk-1" };
		const failed = await new CredentialManager(async () => false).testProvider(
			"openai",
		);
		expect(failed).toEqual({
			success: false,
			message: "fetch failed: https://api.openai.com/v1/models",
		});

		fetchRoutes.push(() => Promise.reject("socket hang up"));
		expect(
			await new CredentialManager(async () => false).testProvider("openai"),
		).toEqual({ success: false, message: "openai connection test failed" });

		fetchRoutes.length = 0;
		fetchRoutes.push(() => new Response("<html>", { status: 200 }));
		const notJson = await new CredentialManager(async () => false).testProvider(
			"openai",
		);
		expect(notJson.details).toMatchObject({ status: 200, modelCount: undefined });
	});

	it("only checks that a key exists for a provider it cannot call", async () => {
		store.settings = { globalCursorApiKey: "cur" };
		await expect(new CredentialManager().testProvider("cursor")).resolves.toEqual({
			success: true,
			message: "cursor connection successful",
			details: {
				method: "API Key (not validated)",
				profileName: "cursor",
			},
		});
	});

	it("refuses a blank key held by the active credential", async () => {
		const manager = new CredentialManager();
		setProfiles([profile("p", "https://llm.example", "   ")], "p");
		// Placeholder cleanup would drop a blank key: load it without initialize.
		await manager.setActiveProvider("custom", "api_key", "p");
		await expect(manager.testProvider("custom")).resolves.toEqual({
			success: false,
			message: "custom has no API key configured",
		});
	});

	it("turns an unexpected error into a failed test", async () => {
		const manager = new CredentialManager(async () => {
			throw new Error("codex exploded");
		});
		await expect(manager.testProvider("openai")).resolves.toEqual({
			success: false,
			message: "codex exploded",
		});
		const odd = new CredentialManager(() => Promise.reject(3));
		await expect(odd.testProvider("openai")).resolves.toEqual({
			success: false,
			message: "Test failed",
		});
	});
});

describe("validateActiveCredentials", () => {
	async function withActive(baseUrl: string, apiKey = "key-1") {
		setProfiles([profile("p", baseUrl, apiKey)]);
		const manager = new CredentialManager();
		await manager.setActiveProvider(
			new URL(baseUrl).hostname.includes("anthropic")
				? "anthropic"
				: (
						manager as unknown as { detectProviderFromUrl(u: string): string }
					).detectProviderFromUrl(baseUrl),
			"api_key",
			"p",
		);
		return manager;
	}

	it("is false without an active credential, true for OAuth", async () => {
		const manager = new CredentialManager();
		expect(await manager.validateActiveCredentials()).toBe(false);
		await manager.setActiveProvider("copilot", "oauth");
		expect(await manager.validateActiveCredentials()).toBe(true);
	});

	it.each([
		["https://api.anthropic.com", "https://api.anthropic.com/v1/models"],
		["https://api.openai.com/v1", "https://api.openai.com/v1/models"],
		["https://api.mistral.ai/v1", "https://api.mistral.ai/v1/models"],
		["https://api.deepseek.com", "https://api.deepseek.com/v1/models"],
		["https://api.x.ai", "https://api.x.ai/v1/models"],
		[
			"https://generativelanguage.googleapis.com/v1beta",
			"https://generativelanguage.googleapis.com/v1/models",
		],
	])("calls the models endpoint for %s", async (baseUrl, expected) => {
		const manager = await withActive(baseUrl);
		const before = manager.getActiveCredential()?.lastValidated ?? 0;
		fetchRoutes.push((url) => (url === expected ? json({}) : undefined));
		vi.spyOn(Date, "now").mockReturnValue(before + 1000);
		await expect(manager.validateActiveCredentials()).resolves.toBe(true);
		expect(manager.getActiveCredential()?.lastValidated).toBe(before + 1000);
		expect(fetchCalls.map((c) => c.url)).toEqual([expected]);
	});

	it("validates an active Google key through its header", async () => {
		const manager = await withActive("https://generativelanguage.googleapis.com/v1beta");
		fetchRoutes.push(() => json({}));
		await expect(manager.validateActiveCredentials()).resolves.toBe(true);
		const [call] = fetchCalls;
		expect(call.url).not.toContain("key-1");
		expect(call.init?.headers).toEqual({ "x-goog-api-key": "key-1" });
	});

	it("calls Anthropic's own API when the profile names no URL", async () => {
		setProfiles([profile("p", "", "sk-ant-1")]);
		const manager = new CredentialManager();
		await manager.setActiveProvider("anthropic", "api_key", "p");
		fetchRoutes.push(() => json({}));
		await manager.validateActiveCredentials();
		expect(fetchCalls[0].url).toBe("https://api.anthropic.com/v1/models");
	});

	it("sends the Anthropic headers", async () => {
		const manager = await withActive("https://api.anthropic.com", "sk-ant-1");
		fetchRoutes.push(() => json({}));
		await manager.validateActiveCredentials();
		expect(fetchCalls[0].init?.headers).toEqual({
			"x-api-key": "sk-ant-1",
			"anthropic-version": "2023-06-01",
		});
	});

	it("asks a local Ollama for its tags", async () => {
		setProfiles([profile("p", "https://ollama.ai", "k")]);
		const manager = new CredentialManager();
		await manager.setActiveProvider("ollama", "api_key", "p");
		fetchRoutes.push(() => json({}));
		await manager.validateActiveCredentials();
		expect(fetchCalls[0].url).toBe("https://ollama.ai/api/tags");

		setProfiles([profile("q", "", "k")]);
		const local = new CredentialManager();
		await local.setActiveProvider("ollama", "api_key", "q");
		await local.validateActiveCredentials();
		expect(fetchCalls[1].url).toBe("http://localhost:11434/api/tags");
	});

	it("is false for a refused key or a network error", async () => {
		const manager = await withActive("https://api.openai.com/v1");
		const before = manager.getActiveCredential()?.lastValidated;
		fetchRoutes.push(() => json({}, 403, "Forbidden"));
		expect(await manager.validateActiveCredentials()).toBe(false);
		expect(manager.getActiveCredential()?.lastValidated).toBe(before);

		fetchRoutes.length = 0;
		expect(await manager.validateActiveCredentials()).toBe(false);
		expect(console.error).toHaveBeenCalledWith(
			"[CredentialManager] Credential validation failed:",
			expect.any(TypeError),
		);
	});

	it("accepts any non-blank key for a provider it cannot call", async () => {
		setProfiles([
			profile("p", "https://llm.example", "abc"),
			profile("q", "https://llm.example", "  "),
		]);
		const manager = new CredentialManager();
		await manager.setActiveProvider("custom", "api_key", "p");
		expect(await manager.validateActiveCredentials()).toBe(true);
		await manager.setActiveProvider("custom", "api_key", "q");
		expect(await manager.validateActiveCredentials()).toBe(false);
	});
});

describe("environment for the Python backend", () => {
	async function activeProfile(provider: string, baseUrl: string, apiKey = "k1") {
		setProfiles([profile("p", baseUrl, apiKey)]);
		const manager = new CredentialManager();
		await manager.setActiveProvider(provider, "api_key", "p");
		store.settings = undefined;
		return manager;
	}

	it("passes Copilot by name only: gh holds its credentials", () => {
		store.settings = { selectedProvider: "Copilot", globalOpenAIApiKey: "sk" };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "copilot",
		});
	});

	it("takes a provider's key and base URL from a matching profile first", async () => {
		setProfiles([
			profile("p", "https://api.mistral.ai/v1", "profile-key"),
		]);
		const manager = new CredentialManager();
		await manager.initialize();
		store.settings = { selectedProvider: "mistral", globalMistralApiKey: "global" };
		expect(manager.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "mistral",
			MISTRAL_API_KEY: "profile-key",
			MISTRAL_BASE_URL: "https://api.mistral.ai/v1",
		});
	});

	it("matches a profile that names its provider, with no base URL", async () => {
		store.profiles = {
			profiles: [{ id: "p", name: "p", provider: "aws", apiKey: "AKIA1" }],
			activeProfileId: null,
			version: 1,
		};
		const manager = new CredentialManager();
		await manager.initialize();
		store.settings = { selectedProvider: "aws" };
		expect(manager.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "aws",
			AWS_ACCESS_KEY_ID: "AKIA1",
		});
	});

	it("skips a profile whose URL is not text, and a profile list that is missing", async () => {
		store.profiles = {
			profiles: [{ id: "p", name: "p", baseUrl: 1, apiKey: "nope" }],
			activeProfileId: null,
			version: 1,
		};
		const manager = new CredentialManager();
		await manager.initialize();
		store.settings = { selectedProvider: "meta", globalMetaApiKey: "meta-key" };
		expect(manager.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "meta",
			META_API_KEY: "meta-key",
		});

		const broken = new CredentialManager();
		store.profiles = { activeProfileId: null, version: 1 };
		await broken.initialize();
		expect(broken.getEnvironmentVariables()).toMatchObject({
			META_API_KEY: "meta-key",
		});
	});

	it("never exports an OpenAI key in Codex CLI mode", () => {
		store.settings = {
			selectedProvider: "openai",
			globalOpenAIAuthMode: "codex-cli",
			globalOpenAIApiKey: "sk-real",
		};
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "openai",
			OPENAI_AUTH_MODE: "codex-cli",
		});
	});

	it("hands Ollama its URL and model, under both model names", () => {
		store.settings = {
			selectedProvider: "ollama",
			globalOllamaApiUrl: " http://localhost:1234 ",
			globalOllamaModel: " hf.co/org/model ",
		};
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "ollama",
			OLLAMA_BASE_URL: "http://localhost:1234",
			OLLAMA_MODEL: "hf.co/org/model",
			LOCAL_LLM_MODEL: "hf.co/org/model",
		});

		store.settings = {
			selectedProvider: "ollama",
			globalOllamaBaseUrl: "http://legacy:11434",
		};
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "ollama",
			OLLAMA_BASE_URL: "http://legacy:11434",
		});

		store.settings = { selectedProvider: "ollama" };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "ollama",
		});
	});

	it("names a custom provider without a key to give", () => {
		store.settings = { selectedProvider: "custom" };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "custom",
		});
	});

	it("routes a Windsurf credential, with its key when it has one", async () => {
		const withKey = await activeProfile("windsurf", "https://server.codeium.com", "sk-ws");
		expect(withKey.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
			WINDSURF_API_KEY: "sk-ws",
			WINDSURF_BASE_URL: "https://server.codeium.com",
		});

		const sso = new CredentialManager();
		await sso.setActiveProvider("windsurf", "oauth");
		store.settings = undefined;
		expect(sso.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
		});

		setProfiles([profile("blank", "", "")]);
		const blank = new CredentialManager();
		await blank.setActiveProvider("windsurf", "api_key", "blank");
		store.settings = undefined;
		expect(blank.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
		});
	});

	it("names a non-Claude OAuth provider so the backend does not fall back to Claude", async () => {
		const manager = new CredentialManager();
		await manager.setActiveProvider("gemini-cli", "oauth");
		store.settings = undefined;
		expect(manager.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "gemini-cli",
		});
	});

	it("uses a leftover Windsurf key unless Claude was chosen", async () => {
		store.settings = { globalWindsurfApiKey: " sk-ws-old " };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
			WINDSURF_API_KEY: "sk-ws-old",
		});

		store.settings = { selectedProvider: "claude", globalWindsurfApiKey: "sk-ws" };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({});

		const claude = new CredentialManager();
		await claude.setActiveProvider("claude", "oauth");
		store.settings = { globalWindsurfApiKey: "sk-ws" };
		expect(claude.getEnvironmentVariables("anthropic")).toEqual({
			SELECTED_LLM_PROVIDER: "claude",
		});

		store.settings = { globalWindsurfApiKey: 9 };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({});
	});

	it("survives a settings.json whose provider is not text", () => {
		store.settings = { selectedProvider: 12 };
		expect(new CredentialManager().getEnvironmentVariables()).toEqual({});
	});

	it.each([
		["anthropic", "https://proxy.example", {
			ANTHROPIC_API_KEY: "k1",
			ANTHROPIC_AUTH_TOKEN: "k1",
			ANTHROPIC_BASE_URL: "https://proxy.example",
		}],
		["claude", "", { ANTHROPIC_API_KEY: "k1", ANTHROPIC_AUTH_TOKEN: "k1" }],
		["openai", "https://api.openai.com/v1", {
			OPENAI_API_KEY: "k1",
			OPENAI_BASE_URL: "https://api.openai.com/v1",
		}],
		["openai", "", { OPENAI_API_KEY: "k1" }],
		["google", "https://g.example", { GOOGLE_API_KEY: "k1" }],
		["mistral", "https://m.example", { MISTRAL_API_KEY: "k1", MISTRAL_BASE_URL: "https://m.example" }],
		["mistral", "", { MISTRAL_API_KEY: "k1" }],
		["deepseek", "https://d.example", { DEEPSEEK_API_KEY: "k1", DEEPSEEK_BASE_URL: "https://d.example" }],
		["deepseek", "", { DEEPSEEK_API_KEY: "k1" }],
		["grok", "https://x.example", { GROK_API_KEY: "k1", GROK_BASE_URL: "https://x.example" }],
		["grok", "", { GROK_API_KEY: "k1" }],
		["meta", "https://meta.example", { META_API_KEY: "k1", META_BASE_URL: "https://meta.example" }],
		["meta", "", { META_API_KEY: "k1" }],
		["aws", "https://bedrock.example", { AWS_ACCESS_KEY_ID: "k1", AWS_BEDROCK_ENDPOINT: "https://bedrock.example" }],
		["aws", "", { AWS_ACCESS_KEY_ID: "k1" }],
		["ollama", "http://gpu:11434", { OLLAMA_BASE_URL: "http://gpu:11434" }],
		["ollama", "", {}],
		["cursor", "https://c.example", { CURSOR_API_KEY: "k1", CURSOR_BASE_URL: "https://c.example" }],
		["cursor", "", { CURSOR_API_KEY: "k1" }],
		["openrouter", "https://openrouter.ai/api", { LLM_API_KEY: "k1", LLM_BASE_URL: "https://openrouter.ai/api" }],
		["openrouter", "", { LLM_API_KEY: "k1" }],
	])("exports the active %s profile (base URL %j)", async (provider, baseUrl, expected) => {
		const manager = await activeProfile(provider, baseUrl);
		expect(manager.getEnvironmentVariables()).toEqual({
			...expected,
			SELECTED_LLM_PROVIDER: provider,
		});
	});

	it("drops blank values from an active profile's environment", async () => {
		const manager = await activeProfile("openai", "", "");
		expect(manager.getEnvironmentVariables()).toEqual({
			SELECTED_LLM_PROVIDER: "openai",
		});
	});

	it("gives a page's Windsurf choice the global key when no credential holds one", () => {
		store.settings = { selectedProvider: "claude", globalWindsurfApiKey: " sk-ws " };
		expect(new CredentialManager().getEnvironmentVariables("windsurf")).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
			WINDSURF_API_KEY: "sk-ws",
		});

		store.settings = { selectedProvider: "claude" };
		expect(new CredentialManager().getEnvironmentVariables("windsurf")).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
		});

		store.settings = { selectedProvider: "claude", globalWindsurfApiKey: 3 };
		expect(new CredentialManager().getEnvironmentVariables("windsurf")).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
		});
	});

	it("adds the global Windsurf key when a page picks Windsurf over another active profile", async () => {
		const manager = await activeProfile("openai", "", "sk-openai");
		store.settings = { globalWindsurfApiKey: " sk-ws-global " };
		expect(manager.getEnvironmentVariables("windsurf")).toMatchObject({
			SELECTED_LLM_PROVIDER: "windsurf",
			WINDSURF_API_KEY: "sk-ws-global",
		});
	});

	it("keeps the key an active Windsurf credential already gave", async () => {
		const manager = await activeProfile("windsurf", "", "sk-ws-active");
		store.settings = { globalWindsurfApiKey: "sk-ws-global" };
		expect(manager.getEnvironmentVariables("windsurf")).toEqual({
			SELECTED_LLM_PROVIDER: "windsurf",
			WINDSURF_API_KEY: "sk-ws-active",
		});
	});

	it("treats a blank page choice as no choice", () => {
		store.settings = { selectedProvider: "copilot" };
		expect(new CredentialManager().getEnvironmentVariables("  ")).toEqual({
			SELECTED_LLM_PROVIDER: "copilot",
		});
	});
});
