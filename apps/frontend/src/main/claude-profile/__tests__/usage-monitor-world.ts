/**
 * The machine a UsageMonitor runs on, faked for its tests: the Claude
 * profiles, the API profiles file, the app settings, the credential stores,
 * the network (by URL), the `claude usage` command and the provider helpers.
 *
 * Each test file mocks the monitor's modules with the objects exported here
 * (`vi.mock(path, async () => (await import("./usage-monitor-world")).x)`),
 * so every file reads and writes the same world. `resetWorld()` starts over.
 */

import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { EnsureValidTokenResult } from "../token-refresh";

export interface FakeClaudeProfile {
	id: string;
	name: string;
	email?: string;
	configDir?: string;
	isAuthenticated?: boolean;
	oauthToken?: string;
	usage?: {
		sessionUsagePercent?: number;
		weeklyUsagePercent?: number;
		lastUpdated?: Date;
	};
	rateLimitEvents?: Array<{
		type: "session" | "weekly";
		resetAt: Date;
		hitAt: Date;
	}>;
}

export interface FakeAPIProfile {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
}

type Answer =
	| Response
	| Error
	| ((call: FetchCall) => Response | Promise<Response>);

export interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

const emptyAutoSwitch = () => ({
	enabled: true,
	proactiveSwapEnabled: true,
	usageCheckInterval: 0,
	sessionThreshold: 95,
	weeklyThreshold: 99,
	autoSwitchOnRateLimit: false,
	autoSwitchOnAuthFailure: false,
});

function freshWorld() {
	return {
		claude: {
			profiles: [] as FakeClaudeProfile[],
			activeProfileId: null as string | null,
		},
		autoSwitch: emptyAutoSwitch() as ReturnType<typeof emptyAutoSwitch>,
		priorityOrder: [] as string[],
		apiFile: {
			profiles: [] as FakeAPIProfile[],
			activeProfileId: null as string | null,
			version: 1,
		},
		apiFileError: null as Error | null,
		settings: {} as Record<string, unknown> | undefined,
		settingsError: null as Error | null,
		settingsWriteError: null as Error | null,
		writtenSettings: [] as Record<string, unknown>[],
		/** Credential store of each config dir */
		keychain: new Map<
			string,
			{ token: string | null; email: string | null; error?: string }
		>(),
		/** ensureValidToken answer of each config dir; none = read from the keychain */
		tokens: new Map<string | undefined, EnsureValidTokenResult | Error>(),
		/** reactiveTokenRefresh answer of each config dir */
		reactive: new Map<string | undefined, EnsureValidTokenResult | Error>(),
		clearedKeychains: [] as Array<string | undefined>,
		initError: null as Error | null,
		/** First matching prefix wins; a list answers in turn, its last answer repeats */
		routes: new Map<string, Answer | Answer[]>(),
		fetchCalls: [] as FetchCall[],
		/** What `claude usage` does; null = the command cannot be spawned */
		cli: { stdout: "", stderr: "", code: 0 as number | null } as {
			stdout: string;
			stderr: string;
			code: number | null;
		} | null,
		spawns: [] as Array<{ command: string; args: string[]; configDir?: string }>,
		codex: null as unknown,
		codexError: null as Error | null,
		windsurfPlan: { success: false, error: "no cached plan" } as unknown,
		windsurfPlanError: null as Error | null,
		windsurfToken: { success: false } as unknown,
		windsurfTokenError: null as Error | null,
		apiActivations: [] as string[],
		apiActivationError: null as Error | null,
		calls: {
			setActiveProfile: [] as string[],
			updateUsage: [] as Array<[string, number, number]>,
			batchUpdates: [] as unknown[],
			clearRateLimitEvents: [] as string[],
		},
	};
}

export let world = freshWorld();

export function resetWorld(): void {
	world = freshWorld();
}

/** A JSON answer, as fetch gives it. */
export function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText: status === 200 ? "OK" : `Status ${status}`,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** An answer whose body is not JSON. */
export function text(body: string, status: number): Response {
	return new Response(body, { status, statusText: `Status ${status}` });
}

export function answer(prefix: string, ...answers: Answer[]): void {
	world.routes.set(prefix, answers.length === 1 ? answers[0] : answers);
}

function headersOf(init?: RequestInit): Record<string, string> {
	const out: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

export async function fakeFetch(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = String(input);
	const call: FetchCall = {
		url,
		method: init?.method ?? "GET",
		headers: headersOf(init),
		body: typeof init?.body === "string" ? init.body : undefined,
	};
	world.fetchCalls.push(call);
	for (const [prefix, route] of world.routes) {
		if (!url.startsWith(prefix)) continue;
		let next: Answer;
		if (Array.isArray(route)) {
			next = route.length > 1 ? (route.shift() as Answer) : route[0];
		} else {
			next = route;
		}
		if (next instanceof Error) throw next;
		if (typeof next === "function") return next(call);
		return next.clone();
	}
	throw new Error(`connect ECONNREFUSED (no route for ${url})`);
}

export function callsTo(prefix: string): FetchCall[] {
	return world.fetchCalls.filter((c) => c.url.startsWith(prefix));
}

const find = (id: string | null | undefined) =>
	world.claude.profiles.find((p) => p.id === id);

export const profileManager = {
	getSettings: () => ({
		profiles: world.claude.profiles,
		activeProfileId: world.claude.activeProfileId,
	}),
	getAutoSwitchSettings: () => world.autoSwitch,
	getActiveProfile: () => find(world.claude.activeProfileId),
	getProfile: (id: string) => find(id),
	getProfilesSortedByAvailability: () => [...world.claude.profiles],
	setActiveProfile: (id: string) => {
		world.calls.setActiveProfile.push(id);
		world.claude.activeProfileId = id;
		return true;
	},
	getAccountPriorityOrder: () => world.priorityOrder,
	updateProfileUsageFromAPI: (id: string, session: number, weekly: number) => {
		world.calls.updateUsage.push([id, session, weekly]);
	},
	batchUpdateProfileUsageFromAPI: (updates: unknown[]) => {
		world.calls.batchUpdates.push(...updates);
	},
	clearRateLimitEvents: (id: string) => {
		world.calls.clearRateLimitEvents.push(id);
	},
};

export const claudeProfileManagerModule = {
	getClaudeProfileManager: () => profileManager,
	initializeClaudeProfileManager: async () => {
		if (world.initError) throw world.initError;
		return profileManager;
	},
};

export const profileFileModule = {
	loadProfilesFile: async () => {
		if (world.apiFileError) throw world.apiFileError;
		return world.apiFile;
	},
	setActiveAPIProfile: async (id: string) => {
		if (world.apiActivationError) throw world.apiActivationError;
		world.apiActivations.push(id);
		world.apiFile.activeProfileId = id;
	},
};

export const settingsModule = {
	readSettingsFile: () => {
		if (world.settingsError) throw world.settingsError;
		return world.settings;
	},
	writeSettingsFile: (settings: Record<string, unknown>) => {
		if (world.settingsWriteError) throw world.settingsWriteError;
		world.writtenSettings.push({ ...settings });
	},
};

export function storeOf(configDir: string | undefined) {
	return (
		(configDir && world.keychain.get(configDir)) || {
			token: null,
			email: null,
		}
	);
}

export const credentialUtilsModule = {
	getCredentialsFromKeychain: (configDir?: string) => storeOf(configDir),
	clearKeychainCache: (configDir?: string) => {
		world.clearedKeychains.push(configDir);
	},
};

function tokenAnswer(
	answers: Map<string | undefined, EnsureValidTokenResult | Error>,
	configDir: string | undefined,
): EnsureValidTokenResult {
	const set = answers.get(configDir);
	if (set instanceof Error) throw set;
	if (set) return set;
	const stored = storeOf(configDir);
	return stored.token
		? { token: stored.token, wasRefreshed: false }
		: {
				token: null,
				wasRefreshed: false,
				error: "No credentials",
				errorCode: "missing_credentials",
			};
}

export const tokenRefreshModule = {
	ensureValidToken: vi.fn(async (configDir: string | undefined) =>
		tokenAnswer(world.tokens, configDir),
	),
	reactiveTokenRefresh: vi.fn(async (configDir: string | undefined) =>
		tokenAnswer(world.reactive, configDir),
	),
};

export const credentialManagerModule = {
	readWindsurfCachedPlanInfo: async () => {
		if (world.windsurfPlanError) throw world.windsurfPlanError;
		return world.windsurfPlan;
	},
	detectWindsurfLocalToken: async () => {
		if (world.windsurfTokenError) throw world.windsurfTokenError;
		return world.windsurfToken;
	},
};

export async function codexUsageModule() {
	const actual =
		await vi.importActual<typeof import("../codex-usage")>("../codex-usage");
	return {
		...actual,
		fetchCodexRateLimits: async () => {
			if (world.codexError) throw world.codexError;
			return world.codex;
		},
	};
}

export const envUtilsModule = {
	getSpawnCommand: (command: string) => command,
	getSpawnOptions: (_command: string, options: object) => options,
};

/** `claude usage` as the world says it behaves, answered on the next tick. */
export const childProcessModule = {
	spawn: (command: string, args: string[], options?: { env?: Record<string, string> }) => {
		const configDir = options?.env?.CLAUDE_CONFIG_DIR;
		world.spawns.push({ command, args, ...(configDir && { configDir }) });
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		const cli = world.cli;
		setImmediate(() => {
			if (!cli) {
				child.emit("error", new Error("spawn claude ENOENT"));
				return;
			}
			if (cli.stdout) child.stdout.emit("data", Buffer.from(cli.stdout));
			if (cli.stderr) child.stderr.emit("data", Buffer.from(cli.stderr));
			child.emit("close", cli.code);
		});
		return child;
	},
	/** Imported by modules the monitor loads (windows-paths.ts); no tool runs here. */
	execFile: (command: string, ...rest: unknown[]) => {
		const callback = rest.find((value) => typeof value === "function") as
			| ((error: Error) => void)
			| undefined;
		setImmediate(() => callback?.(new Error(`spawn ${command} ENOENT`)));
	},
};
