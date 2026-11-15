/**
 * Windsurf (Codeium): the connection test, the usage snapshot, and what the
 * app reads from the Windsurf IDE's own state database.
 *
 * The IDE's `state.vscdb` is a real SQLite file written under a temporary
 * home. CI installs dependencies without their build scripts, so the native
 * better-sqlite3 binding is absent there: the module is replaced by a thin
 * adapter over Node's built-in `node:sqlite`, which runs the same SQL on the
 * same file. Codeium's servers are answered by a stubbed `fetch`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	settings: undefined as Record<string, unknown> | undefined,
	profiles: { profiles: [], activeProfileId: null, version: 1 } as unknown,
	failClose: false,
	/** Handles opened through the fake better-sqlite3 and not closed yet. */
	openHandles: 0,
}));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () =>
		store.settings ? structuredClone(store.settings) : undefined,
	writeSettingsFile: vi.fn(),
}));

vi.mock("../../utils/profile-manager", () => ({
	loadProfilesFile: async () => structuredClone(store.profiles),
	saveProfilesFile: vi.fn(),
}));

vi.mock("../windsurf-sqlite", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const asBetterSqlite = (row: unknown) => {
		if (!row || typeof row !== "object") return row;
		const out: Record<string, unknown> = { ...(row as object) };
		for (const [k, v] of Object.entries(out)) {
			if (v instanceof Uint8Array) out[k] = Buffer.from(v);
		}
		return out;
	};
	class Database {
		private readonly db: InstanceType<typeof DatabaseSync>;
		constructor(file: string, options?: { readonly?: boolean }) {
			this.db = new DatabaseSync(file, { readOnly: options?.readonly ?? false });
			store.openHandles++;
		}
		prepare(sql: string) {
			const statement = this.db.prepare(sql);
			return {
				get: (...params: never[]) => asBetterSqlite(statement.get(...params)),
				all: (...params: never[]) =>
					statement.all(...params).map(asBetterSqlite),
			};
		}
		close() {
			if (this.db.isOpen) {
				this.db.close();
				store.openHandles--;
			}
			if (store.failClose) throw new Error("database is busy");
		}
	}
	return { loadBetterSqlite: () => Database };
});

import { DatabaseSync } from "node:sqlite";
import {
	CredentialManager,
	detectWindsurfLocalToken,
	readWindsurfCachedPlanInfo,
} from "../credential-manager";

// ── state.vscdb ─────────────────────────────────────────────────────────────

let home: string;
const savedEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	APPDATA: process.env.APPDATA,
};

/** Every place the app looks for the IDE's database: one per OS. */
function dbPaths(): string[] {
	const tail = ["Windsurf", "User", "globalStorage", "state.vscdb"];
	return [
		join(home, "AppData", "Roaming", ...tail),
		join(home, "Library", "Application Support", ...tail),
		join(home, ".config", ...tail),
	];
}

function writeStateDb(entries: Record<string, string | Buffer>): void {
	for (const file of dbPaths()) {
		mkdirSync(join(file, ".."), { recursive: true });
		rmSync(file, { force: true });
		const db = new DatabaseSync(file);
		db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
		const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
		for (const [key, value] of Object.entries(entries)) insert.run(key, value);
		db.close();
	}
}

// ── protobuf, as Windsurf stores userStatusProtoBinaryBase64 ────────────────

function varint(value: number): number[] {
	const out: number[] = [];
	let n = value;
	do {
		let byte = n % 128;
		n = Math.floor(n / 128);
		if (n > 0) byte |= 0x80;
		out.push(byte);
	} while (n > 0);
	return out;
}
const field = (num: number, wire: number) => varint((num << 3) | wire);
const vField = (num: number, value: number) => [...field(num, 0), ...varint(value)];
const lenField = (num: number, bytes: number[]) => [
	...field(num, 2),
	...varint(bytes.length),
	...bytes,
];

function planProto(plan: {
	start?: number;
	end?: number;
	usedMessages?: number;
	usedFlowActions?: number;
	totalMessages?: number;
	totalFlowActions?: number;
	cycleStart?: number;
}): string {
	const sub = [
		// Fields the parser has to step over: a fixed32, a fixed64, a string.
		...field(4, 5), 1, 2, 3, 4,
		...field(5, 1), 1, 2, 3, 4, 5, 6, 7, 8,
		...lenField(10, [0x61, 0x62]),
		...(plan.start !== undefined ? lenField(2, vField(1, plan.start)) : []),
		...(plan.end !== undefined ? lenField(3, vField(1, plan.end)) : []),
		// A nested message that is not a timestamp is ignored.
		...lenField(3, vField(2, 5)),
		...lenField(2, []),
		...vField(6, plan.usedMessages ?? 0),
		...vField(7, plan.usedFlowActions ?? 0),
		...vField(8, plan.totalMessages ?? 0),
		...vField(9, plan.totalFlowActions ?? 0),
		...vField(17, plan.cycleStart ?? 0),
	];
	const root = [
		...vField(1, 7),
		...field(2, 5), 0, 0, 0, 0,
		...field(3, 1), 0, 0, 0, 0, 0, 0, 0, 0,
		...lenField(4, [1, 2, 3]),
		...lenField(13, sub),
	];
	return Buffer.from(root).toString("base64");
}

const DAY = 86_400;

function cachedPlan(overrides: Record<string, unknown> = {}) {
	return {
		planName: "Pro",
		startTimestamp: 1_000_000 * 1000,
		endTimestamp: (1_000_000 + 30 * DAY) * 1000,
		usage: {
			duration: 0,
			messages: 500,
			flowActions: 1000,
			flexCredits: 0,
			usedMessages: 100,
			usedFlowActions: 200,
			usedFlexCredits: 0,
			remainingMessages: 400,
			remainingFlowActions: 800,
			remainingFlexCredits: 0,
		},
		hasBillingWritePermissions: false,
		gracePeriodStatus: 0,
		...overrides,
	};
}

// ── Codeium's servers ───────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];
let answer: (call: FetchCall) => Response | Promise<Response>;

const CREDITS = "https://server.codeium.com/api/v1/GetTeamCreditBalance";
const GET_USER =
	"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetUser";
const TEAM_INFO =
	"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetTeamInfo";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, statusText: "S" });
}
const bearer = (call: FetchCall) =>
	(call.init?.headers as Record<string, string> | undefined)?.Authorization;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "windsurf-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.APPDATA = join(home, "AppData", "Roaming");
	store.settings = undefined;
	store.profiles = { profiles: [], activeProfileId: null, version: 1 };
	store.failClose = false;
	store.openHandles = 0;
	fetchCalls = [];
	answer = () => json({}, 404);
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		fetchCalls.push(call);
		return answer(call);
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
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

function windsurfProfile(apiKey: string, name = "Team key") {
	store.profiles = {
		profiles: [
			{
				id: "ws",
				name,
				baseUrl: "https://server.codeium.com",
				apiKey,
				createdAt: 0,
				updatedAt: 0,
			},
		],
		activeProfileId: null,
		version: 1,
	};
}

// ── detectWindsurfLocalToken ────────────────────────────────────────────────

describe("detectWindsurfLocalToken", () => {
	it("says Windsurf is missing when its database is", async () => {
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: false,
			error: "Windsurf IDE not found. Install Windsurf and sign in first.",
		});
	});

	it("reads the key and the account from windsurfAuthStatus", async () => {
		writeStateDb({
			windsurfAuthStatus: JSON.stringify({
				apiKey: "sk-ws-01",
				userName: "Ada",
				email: "ada@example.com",
			}),
		});
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: true,
			apiKey: "sk-ws-01",
			userName: "Ada (ada@example.com)",
		});
	});

	it.each([
		[{ accessToken: "eyJ.sso", email: "sso@example.com" }, "eyJ.sso", "sso@example.com"],
		[{ token: "tok-1", name: "Grace" }, "tok-1", "Grace"],
		[{ apiKey: "sk-ws-2", userName: "Lin", name: "ignored" }, "sk-ws-2", "Lin"],
	])("takes an SSO token stored as %j", async (auth, key, user) => {
		writeStateDb({ windsurfAuthStatus: JSON.stringify(auth) });
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: true,
			apiKey: key,
			userName: user,
		});
	});

	it("ignores a value that is neither text nor a blob", async () => {
		for (const file of dbPaths()) {
			mkdirSync(join(file, ".."), { recursive: true });
			const db = new DatabaseSync(file);
			db.exec("CREATE TABLE ItemTable (key TEXT, value BLOB)");
			db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("windsurfAuthStatus", 5);
			db.close();
		}
		const result = await detectWindsurfLocalToken();
		expect(result.success).toBe(false);
	});

	it("takes a raw token, stored as text or as a blob", async () => {
		writeStateDb({ windsurfAuthStatus: Buffer.from("sk-ws-raw", "utf-8") });
		expect((await detectWindsurfLocalToken()).apiKey).toBe("sk-ws-raw");
		writeStateDb({ windsurfAuthStatus: "eyJraw" });
		expect((await detectWindsurfLocalToken()).apiKey).toBe("eyJraw");
	});

	it("falls back to the enterprise keys, in order", async () => {
		writeStateDb({
			windsurfAuthStatus: "not a token",
			"windsurf.authToken": JSON.stringify({ key: "enterprise-key" }),
		});
		expect((await detectWindsurfLocalToken()).apiKey).toBe("enterprise-key");

		const longToken = "x".repeat(41);
		writeStateDb({ "windsurf.authToken": longToken });
		expect((await detectWindsurfLocalToken()).apiKey).toBe(longToken);

		writeStateDb({ "windsurf.authToken": "sk-short" });
		expect((await detectWindsurfLocalToken()).apiKey).toBe("sk-short");

		writeStateDb({
			"windsurf.authToken": "short",
			"codeium.apiKey": "codeium-key-123",
		});
		expect((await detectWindsurfLocalToken()).apiKey).toBe("codeium-key-123");

		writeStateDb({
			"codeium.apiKey": "tiny",
			"service-auth/windsurf": JSON.stringify({ accessToken: "service-token" }),
		});
		expect((await detectWindsurfLocalToken()).apiKey).toBe("service-token");

		writeStateDb({ "service-auth/windsurf": JSON.stringify({ token: "svc-tok" }) });
		expect((await detectWindsurfLocalToken()).apiKey).toBe("svc-tok");

		writeStateDb({ "service-auth/windsurf": "y".repeat(50) });
		expect((await detectWindsurfLocalToken()).apiKey).toBe("y".repeat(50));
	});

	it("names the account from codeium.windsurf-windsurf_auth", async () => {
		writeStateDb({
			windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }),
			"codeium.windsurf-windsurf_auth": JSON.stringify({ email: "e@example.com" }),
		});
		expect((await detectWindsurfLocalToken()).userName).toBe("e@example.com");

		writeStateDb({
			windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }),
			"codeium.windsurf-windsurf_auth": "Plain Name",
		});
		expect((await detectWindsurfLocalToken()).userName).toBe("Plain Name");

		writeStateDb({
			windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }),
			"codeium.windsurf-windsurf_auth": "{}",
		});
		expect((await detectWindsurfLocalToken()).userName).toBe("{}");

		writeStateDb({ windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }) });
		expect(await detectWindsurfLocalToken()).toEqual({
			success: true,
			apiKey: "sk-ws",
			userName: undefined,
		});
	});

	it("lists the keys it saw when no token is there", async () => {
		writeStateDb({
			windsurfAuthStatus: JSON.stringify({ email: "x@example.com" }),
			"service-auth/windsurf": "short",
			unrelated: "1",
		});
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: false,
			error:
				"No API key found in Windsurf auth data. Sign in to Windsurf IDE first. Found 2 related keys: service-auth/windsurf, windsurfAuthStatus",
		});

		writeStateDb({ unrelated: "1" });
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: false,
			error: "No API key found in Windsurf auth data. Sign in to Windsurf IDE first.",
		});
	});

	it("says nothing more when the database has no item table to list", async () => {
		for (const file of dbPaths()) {
			mkdirSync(join(file, ".."), { recursive: true });
			const db = new DatabaseSync(file);
			db.exec("CREATE TABLE Other (x)");
			db.close();
		}
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: false,
			error: "No API key found in Windsurf auth data. Sign in to Windsurf IDE first.",
		});
		// The listing query failed: its handle used to stay open, which Windows
		// turns into a locked file (EBUSY) for the IDE and for the next writer.
		expect(store.openHandles).toBe(0);
	});

	it("reports a database it cannot open", async () => {
		for (const file of dbPaths()) mkdirSync(file, { recursive: true });
		const result = await detectWindsurfLocalToken();
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Could not open Windsurf database: /);
	});

	it("reports a database that fails while being read", async () => {
		writeStateDb({ windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }) });
		store.failClose = true;
		await expect(detectWindsurfLocalToken()).resolves.toEqual({
			success: false,
			error: "Error querying Windsurf database: database is busy",
		});
	});
});

// ── readWindsurfCachedPlanInfo ──────────────────────────────────────────────

describe("readWindsurfCachedPlanInfo", () => {
	it("says Windsurf is not installed when its database is missing", async () => {
		await expect(readWindsurfCachedPlanInfo()).resolves.toEqual({
			success: false,
			error: "Windsurf IDE not installed",
		});
	});

	it("says when the IDE has cached no plan", async () => {
		writeStateDb({ other: "1" });
		await expect(readWindsurfCachedPlanInfo()).resolves.toEqual({
			success: false,
			error: "No cached plan info in Windsurf IDE",
		});
	});

	it("returns the cached plan and the account name", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf-windsurf_auth": JSON.stringify({ userName: "Ada" }),
		});
		await expect(readWindsurfCachedPlanInfo()).resolves.toEqual({
			success: true,
			planInfo: cachedPlan(),
			userName: "Ada",
		});
	});

	it("takes a plain account name, but not a blob of text", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf-windsurf_auth": "Grace",
		});
		expect((await readWindsurfCachedPlanInfo()).userName).toBe("Grace");

		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf-windsurf_auth": JSON.stringify({ email: "g@example.com" }),
		});
		expect((await readWindsurfCachedPlanInfo()).userName).toBe("g@example.com");

		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf-windsurf_auth": "z".repeat(200),
		});
		expect((await readWindsurfCachedPlanInfo()).userName).toBeUndefined();
	});

	it("rolls a plan from the previous billing cycle forward and marks it stale", async () => {
		const plan = cachedPlan();
		const cycleSeconds = 30 * DAY;
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(plan),
			windsurfAuthStatus: JSON.stringify({
				userStatusProtoBinaryBase64: planProto({
					start: 1_000_000,
					end: 1_000_000 + cycleSeconds + 10 * DAY,
					cycleStart: 1_000_000 + cycleSeconds + 3 * DAY,
					totalMessages: 600,
					totalFlowActions: 1200,
				}),
			}),
		});
		const { planInfo } = await readWindsurfCachedPlanInfo();
		expect(planInfo).toMatchObject({
			isStale: true,
			startTimestamp: plan.endTimestamp,
			endTimestamp: plan.endTimestamp + cycleSeconds * 1000,
			usage: { messages: 600, flowActions: 1200, usedMessages: 100 },
		});
	});

	it("keeps the totals when the newer cycle does not give them", async () => {
		const plan = cachedPlan();
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(plan),
			windsurfAuthStatus: JSON.stringify({
				userStatusProtoBinaryBase64: planProto({
					start: 1_000_000 + 40 * DAY,
					end: 1_000_000 + 70 * DAY,
				}),
			}),
		});
		const { planInfo } = await readWindsurfCachedPlanInfo();
		expect(planInfo?.isStale).toBe(true);
		expect(planInfo?.usage.messages).toBe(500);
		expect(planInfo?.usage.flowActions).toBe(1000);
	});

	it("leaves a current plan alone", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			windsurfAuthStatus: JSON.stringify({
				userStatusProtoBinaryBase64: planProto({
					start: 1_000_000,
					end: 1_000_000 + 30 * DAY,
					cycleStart: 1_000_000 + 7 * DAY,
				}),
			}),
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());
	});

	it.each([
		["no plan message", Buffer.from([...vField(1, 1), ...lenField(4, [1])]).toString("base64")],
		["a plan without its dates", Buffer.from(lenField(13, vField(6, 9))).toString("base64")],
		["an unknown wire type", Buffer.from([...field(1, 3), ...lenField(13, [])]).toString("base64")],
		["a plan with an unknown wire type", Buffer.from(lenField(13, [...field(1, 3), 0])).toString("base64")],
	])("ignores a status with %s", async (_label, proto) => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			windsurfAuthStatus: JSON.stringify({ userStatusProtoBinaryBase64: proto }),
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());
	});

	it("ignores an auth status that is not JSON or carries no status", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			windsurfAuthStatus: "sk-raw",
		});
		expect((await readWindsurfCachedPlanInfo()).success).toBe(true);
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			windsurfAuthStatus: "{}",
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());
	});

	it("takes the higher usage from the IDE's fresher status snapshot", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf": JSON.stringify({
				"windsurf.state.cachedUserStatus": planProto({
					start: 1_000_000,
					end: 1_000_000 + 30 * DAY,
					usedMessages: 450,
					usedFlowActions: 1500,
				}),
			}),
		});
		const { planInfo } = await readWindsurfCachedPlanInfo();
		expect(planInfo?.usage).toMatchObject({
			usedMessages: 450,
			remainingMessages: 50,
			usedFlowActions: 1500,
			remainingFlowActions: 0,
		});
	});

	it("does not lower the usage, nor take a snapshot from an older cycle", async () => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf": JSON.stringify({
				"windsurf.state.cachedUserStatus": planProto({
					start: 1_000_000,
					end: 1_000_000 + 30 * DAY,
					usedMessages: 5,
					usedFlowActions: 5,
				}),
			}),
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());

		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf": JSON.stringify({
				"windsurf.state.cachedUserStatus": planProto({
					start: 900_000,
					end: 1_000_000,
					usedMessages: 499,
				}),
			}),
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());
	});

	it.each([
		["a blob that is not JSON", "{oops"],
		["a blob without a snapshot", JSON.stringify({ other: 1 })],
		["a snapshot that is not text", JSON.stringify({ "windsurf.state.cachedUserStatus": 4 })],
		["an empty snapshot", JSON.stringify({ "windsurf.state.cachedUserStatus": "" })],
		[
			"a snapshot without a plan",
			JSON.stringify({
				"windsurf.state.cachedUserStatus": Buffer.from(vField(1, 2)).toString("base64"),
			}),
		],
	])("ignores %s", async (_label, blob) => {
		writeStateDb({
			"windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()),
			"codeium.windsurf": blob,
		});
		expect((await readWindsurfCachedPlanInfo()).planInfo).toEqual(cachedPlan());
	});

	it("reports a cached plan that is not JSON", async () => {
		writeStateDb({ "windsurf.settings.cachedPlanInfo": "{broken" });
		const result = await readWindsurfCachedPlanInfo();
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Error reading Windsurf plan info: /);
	});

	it("reports a database it cannot open, or that fails to close", async () => {
		for (const file of dbPaths()) mkdirSync(file, { recursive: true });
		expect((await readWindsurfCachedPlanInfo()).error).toMatch(
			/^Could not open Windsurf database: /,
		);

		rmSync(home, { recursive: true, force: true });
		mkdirSync(home);
		writeStateDb({ "windsurf.settings.cachedPlanInfo": JSON.stringify(cachedPlan()) });
		store.failClose = true;
		await expect(readWindsurfCachedPlanInfo()).resolves.toEqual({
			success: false,
			error: "Error reading Windsurf plan info: database is busy",
		});
	});
});

// ── CredentialManager.testProvider("windsurf") ──────────────────────────────

describe("Windsurf connection test", () => {
	it("accepts a team service key sent in the body", async () => {
		windsurfProfile("team-service-key");
		answer = (call) => (call.url === CREDITS && !bearer(call) ? json({}) : json({}, 400));
		await expect(new CredentialManager().testProvider("windsurf")).resolves.toEqual({
			success: true,
			message: "Windsurf connection successful",
			details: { method: "Service Key", source: "API profile", authType: "api_key" },
		});
		expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
			service_key: "team-service-key",
		});
	});

	it("retries a personal key as a bearer token", async () => {
		store.settings = { globalWindsurfApiKey: " sk-ws-personal " };
		answer = (call) => (bearer(call) ? json({}) : json({}, 400));
		const result = await new CredentialManager().testProvider("windsurf");
		expect(result.details).toEqual({
			method: "Bearer",
			source: "global settings",
			authType: "api_key",
		});
		expect(bearer(fetchCalls[1])).toBe("Bearer sk-ws-personal");
	});

	it("checks an SSO token with GetUser, never in the body", async () => {
		store.settings = { globalWindsurfApiKey: "eyJsso" };
		answer = (call) => (call.url === GET_USER ? json({}) : json({}, 401));
		const result = await new CredentialManager().testProvider("windsurf");
		expect(result.details).toEqual({
			method: "SSO/OAuth",
			source: "global settings",
			authType: "sso",
		});
		expect(fetchCalls.map((c) => c.url)).toEqual([CREDITS, GET_USER]);
	});

	it("trusts the IDE's sign-in when every server check refuses the key", async () => {
		windsurfProfile("sk-ws-refused");
		writeStateDb({ windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws-ide" }) });
		answer = (call) => {
			if (call.url === GET_USER) throw new TypeError("offline");
			return json({}, 403);
		};
		await expect(new CredentialManager().testProvider("windsurf")).resolves.toEqual({
			success: true,
			message: "Windsurf token verified from local IDE",
			details: { method: "local IDE", source: "local IDE detection", authType: "sso" },
		});
	});

	it("uses the IDE's token when nothing else holds one", async () => {
		writeStateDb({ windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws-ide" }) });
		const result = await new CredentialManager().testProvider("windsurf");
		expect(result).toEqual({
			success: true,
			message: "Windsurf token verified from local IDE",
			details: { method: "local IDE", source: "local IDE detection", authType: "sso" },
		});
		expect(bearer(fetchCalls[1])).toBe("Bearer sk-ws-ide");
	});

	it("says to sign in when the key is refused and the IDE has none", async () => {
		store.settings = { globalWindsurfApiKey: "sk-ws-refused" };
		await expect(new CredentialManager().testProvider("windsurf")).resolves.toEqual({
			success: false,
			message:
				"Windsurf token not found in local IDE. Please open Windsurf IDE and sign in.",
		});
	});

	it("says no token was found anywhere", async () => {
		store.profiles = { version: 1 };
		store.settings = { globalWindsurfApiKey: 12 };
		await expect(new CredentialManager().testProvider("windsurf")).resolves.toEqual({
			success: false,
			message: "No Windsurf token found. Configure via SSO or provide an API key.",
		});
		expect(fetchCalls).toEqual([]);
	});

	it("reports a network failure", async () => {
		windsurfProfile("team-key");
		answer = () => {
			throw new TypeError("getaddrinfo ENOTFOUND server.codeium.com");
		};
		await expect(new CredentialManager().testProvider("windsurf")).resolves.toEqual({
			success: false,
			message: "getaddrinfo ENOTFOUND server.codeium.com",
		});
		answer = () => Promise.reject("reset");
		expect(
			(await new CredentialManager().testProvider("windsurf")).message,
		).toBe("Windsurf test failed");
	});
});

// ── CredentialManager.fetchWindsurfUsage ────────────────────────────────────

describe("Windsurf usage", () => {
	it("turns the team's credit balance into a usage snapshot", async () => {
		windsurfProfile("team-key", "Team");
		const now = Date.parse("2026-11-14T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		answer = (call) =>
			!bearer(call)
				? json({
						promptCreditsPerSeat: 100,
						numSeats: 4,
						addOnCreditsAvailable: 50,
						addOnCreditsUsed: 50,
						billingCycleStart: "2026-11-01T12:00:00Z",
						billingCycleEnd: "2026-12-01T12:00:00Z",
					})
				: json({}, 500);
		const manager = new CredentialManager();
		const updated = vi.fn();
		manager.on("usage:updated", updated);

		const usage = await manager.fetchWindsurfUsage();

		const end = Date.parse("2026-12-01T12:00:00Z");
		expect(usage).toEqual({
			provider: "windsurf",
			profileId: "ws",
			profileName: "Team",
			usage: {
				sessionPercent: 10,
				weeklyPercent: 43,
				sessionResetTimestamp: end,
				weeklyResetTimestamp: end,
				needsReauthentication: false,
			},
			timestamp: now,
		});
		expect(manager.getUsageData("windsurf")).toEqual(usage);
		expect(updated).toHaveBeenCalledWith(usage);
	});

	it("caps the cycle at 100 % and reads empty balances as 0 %", async () => {
		store.settings = { globalWindsurfApiKey: "team-key" };
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-15T00:00:00Z"));
		answer = () =>
			json({
				billingCycleStart: "2026-11-01T00:00:00Z",
				billingCycleEnd: "2026-12-01T00:00:00Z",
			});
		const usage = await new CredentialManager().fetchWindsurfUsage();
		expect(usage?.usage).toMatchObject({ sessionPercent: 0, weeklyPercent: 100 });
		expect(usage?.profileId).toBe("windsurf-global");
	});

	it("retries a refused body key as a bearer token, with no cycle dates", async () => {
		store.settings = { globalWindsurfApiKey: "sk-ws" };
		answer = (call) => (bearer(call) ? json({ addOnCreditsUsed: 5 }) : json({}, 401));
		const usage = await new CredentialManager().fetchWindsurfUsage();
		expect(usage?.usage).toEqual({
			sessionPercent: 100,
			weeklyPercent: 0,
			sessionResetTimestamp: undefined,
			weeklyResetTimestamp: undefined,
			needsReauthentication: false,
		});
		expect(fetchCalls).toHaveLength(2);
	});

	it("names the IDE's SSO account", async () => {
		writeStateDb({
			windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws", name: "Ada" }),
		});
		answer = () => json({});
		const usage = await new CredentialManager().fetchWindsurfUsage();
		expect(usage).toMatchObject({ profileId: "windsurf-sso", profileName: "Windsurf (Ada)" });

		writeStateDb({ windsurfAuthStatus: JSON.stringify({ apiKey: "sk-ws" }) });
		expect((await new CredentialManager().fetchWindsurfUsage())?.profileName).toBe(
			"Windsurf (SSO)",
		);
	});

	it("reads an SSO token's usage from the team info", async () => {
		store.settings = { globalWindsurfApiKey: "eyJsso" };
		answer = (call) =>
			call.url === TEAM_INFO
				? json({ promptCreditsPerSeat: 10, numSeats: 2, addOnCreditsUsed: 5 })
				: json({}, 403);
		const manager = new CredentialManager();
		const updated = vi.fn();
		manager.on("usage:updated", updated);
		const usage = await manager.fetchWindsurfUsage();
		expect(usage?.usage).toEqual({
			sessionPercent: 20,
			weeklyPercent: 0,
			needsReauthentication: false,
		});
		expect(updated).toHaveBeenCalledOnce();
		expect(fetchCalls.map((c) => c.url)).toEqual([CREDITS, TEAM_INFO]);
	});

	it.each([
		["seats only", { numSeats: 3 }, 0],
		["one seat by default", { promptCreditsPerSeat: 10, addOnCreditsUsed: 5 }, 33],
		["defaults", { addOnCreditsUsed: 0, promptCreditsPerSeat: 0, numSeats: 1 }, 0],
	])("reads team info with %s", async (_label, team, pct) => {
		store.settings = { globalWindsurfApiKey: "eyJsso" };
		answer = (call) => (call.url === TEAM_INFO ? json(team) : json({}, 403));
		const usage = await new CredentialManager().fetchWindsurfUsage();
		expect(usage?.usage.sessionPercent).toBe(pct);
	});

	it("keeps Windsurf connected at 0 % when the servers give no usage", async () => {
		const cases: Array<[string, (call: FetchCall) => Response]> = [
			["eyJsso", () => json({}, 403)],
			["eyJsso", (call) => (call.url === TEAM_INFO ? json({}) : json({}, 403))],
			[
				"eyJsso",
				(call) => {
					if (call.url === TEAM_INFO) throw new TypeError("offline");
					return json({}, 403);
				},
			],
			["sk-ws", () => json({}, 500)],
		];
		for (const [key, respond] of cases) {
			store.settings = { globalWindsurfApiKey: key };
			answer = respond;
			const manager = new CredentialManager();
			const updated = vi.fn();
			manager.on("usage:updated", updated);
			const usage = await manager.fetchWindsurfUsage();
			expect(usage?.usage).toEqual({
				sessionPercent: 0,
				weeklyPercent: 0,
				needsReauthentication: false,
			});
			expect(manager.getUsageData("windsurf")).toEqual(usage);
			expect(updated).not.toHaveBeenCalled();
		}
		expect(console.error).toHaveBeenCalledWith(
			"[CredentialManager] Windsurf credits API returned error:",
			500,
			"S",
		);
	});

	it("has nothing to show without a key", async () => {
		store.settings = { globalWindsurfApiKey: "  " };
		await expect(new CredentialManager().fetchWindsurfUsage()).resolves.toBeNull();
		expect(fetchCalls).toEqual([]);
	});

	it("returns nothing when the profiles or the network fail", async () => {
		store.profiles = { version: 1 };
		await expect(new CredentialManager().fetchWindsurfUsage()).resolves.toBeNull();

		store.profiles = { profiles: [], version: 1 };
		store.settings = { globalWindsurfApiKey: 5 };
		await expect(new CredentialManager().fetchWindsurfUsage()).resolves.toBeNull();

		store.settings = { globalWindsurfApiKey: "sk-ws" };
		answer = () => {
			throw new TypeError("offline");
		};
		await expect(new CredentialManager().fetchWindsurfUsage()).resolves.toBeNull();
		expect(console.error).toHaveBeenCalledWith(
			"[CredentialManager] Windsurf usage fetch failed:",
			expect.any(TypeError),
		);
	});
});
