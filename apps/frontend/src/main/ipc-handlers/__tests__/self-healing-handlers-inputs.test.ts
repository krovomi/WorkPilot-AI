/**
 * @vitest-environment node
 *
 * The Self-Healing handlers check what the renderer sends before the runner
 * starts or the config file is written: ids, modes, sources, settings. A
 * production source's settings reach the runner on stdin.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	spawns: [] as Array<{ args: string[]; options: Record<string, unknown>; stdin: string[] }>,
	stdout: "{}",
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: vi.fn(async () => ({ PATH: "/usr/bin" })),
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: (_command: string, args: string[], options: Record<string, unknown>) => {
		const stdin: string[] = [];
		state.spawns.push({ args, options, stdin });
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			stdin: { end: (data: string) => stdin.push(data) },
			kill: vi.fn(),
		});
		setTimeout(() => {
			proc.stdout.emit("data", Buffer.from(state.stdout));
			proc.emit("close", 0);
		}, 0);
		return proc;
	},
}));

import { INVALID_INPUT, modeConfig, sourceConfig } from "../self-healing-inputs";
import { registerSelfHealingHandlers } from "../self-healing-handlers";

function call(channel: string, ...args: unknown[]): Promise<unknown> {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return Promise.resolve(handler({}, ...args));
}

const HOSTILE_IDS = ["--project=/etc", "--x", "", "a b", "../x", 7, null, "a".repeat(129)];

describe("Self-Healing handler inputs", () => {
	let project: string;

	beforeEach(() => {
		project = mkdtempSync(path.join(tmpdir(), "self-healing-inputs-"));
		state.handlers.clear();
		state.spawns = [];
		state.stdout = "{}";
		registerSelfHealingHandlers(() => null);
	});

	afterEach(() => {
		rmSync(project, { recursive: true, force: true });
	});

	it.each([
		IPC_CHANNELS.SELF_HEALING_TRIGGER_FIX,
		IPC_CHANNELS.SELF_HEALING_DISMISS_INCIDENT,
		IPC_CHANNELS.SELF_HEALING_RETRY_INCIDENT,
		IPC_CHANNELS.SELF_HEALING_CANCEL_OPERATION,
	])("%s refuses an id that is not one, and starts nothing", async (channel) => {
		for (const id of HOSTILE_IDS) {
			expect(await call(channel, project, id)).toEqual(INVALID_INPUT);
		}
		expect(state.spawns).toEqual([]);
	});

	it("keeps an incident id to 64 characters, an operation id to 128", async () => {
		expect(await call(IPC_CHANNELS.SELF_HEALING_DISMISS_INCIDENT, project, "a".repeat(65))).toEqual(INVALID_INPUT);
		expect(state.spawns).toEqual([]);
		await call(IPC_CHANNELS.SELF_HEALING_CANCEL_OPERATION, project, "a".repeat(128));
		expect(state.spawns).toHaveLength(1);
	});

	it("passes a well-formed incident id to the runner", async () => {
		await call(IPC_CHANNELS.SELF_HEALING_DISMISS_INCIDENT, project, "0123456789ab");
		await call(IPC_CHANNELS.SELF_HEALING_CANCEL_OPERATION, project, "op-0123456789ab");
		expect(state.spawns.map((s) => s.args.slice(-3))).toEqual([
			["dismiss", "--incident-id", "0123456789ab"],
			["cancel", "--operation-id", "op-0123456789ab"],
		]);
	});

	it.each([IPC_CHANNELS.SELF_HEALING_TRIGGER_FIX, IPC_CHANNELS.SELF_HEALING_RETRY_INCIDENT])(
		"%s starts the runner on a well-formed incident id",
		async (channel) => {
			expect(await call(channel, project, "0123456789ab")).toEqual({ success: true });
			expect(state.spawns[0].args.slice(-2)).toEqual(["--incident-id", "0123456789ab"]);
		},
	);

	it("lists incidents of a known mode only", async () => {
		expect(await call(IPC_CHANNELS.SELF_HEALING_GET_INCIDENTS, project, "--project")).toEqual(INVALID_INPUT);
		expect(await call(IPC_CHANNELS.SELF_HEALING_GET_INCIDENTS, project, 3)).toEqual(INVALID_INPUT);
		expect(state.spawns).toEqual([]);
		state.stdout = "[]";
		await call(IPC_CHANNELS.SELF_HEALING_GET_INCIDENTS, project, "cicd");
		await call(IPC_CHANNELS.SELF_HEALING_GET_INCIDENTS, project);
		expect(state.spawns.map((s) => s.args.slice(3))).toEqual([["incidents", "--mode", "cicd"], ["incidents"]]);
	});

	it.each([
		IPC_CHANNELS.SELF_HEALING_CICD_CONFIG,
		IPC_CHANNELS.SELF_HEALING_PRODUCTION_CONFIG,
		IPC_CHANNELS.SELF_HEALING_PROACTIVE_CONFIG,
	])("%s saves flat settings and refuses anything else", async (channel) => {
		const refused = [
			null,
			"enabled",
			[true],
			{ nested: { enabled: true } },
			{ constructor: true },
			{ "bad key": true },
			{ list: [1, 2] },
			{ text: "line\nbreak" },
			{ big: "x".repeat(2049) },
			{ ratio: Number.NaN },
			Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, true])),
		];
		for (const config of refused) {
			expect(await call(channel, project, config)).toEqual(INVALID_INPUT);
		}
		const saved = (await call(channel, project, {
			enabled: true,
			riskThreshold: 40,
			watchBranches: ["main"],
			severityThreshold: "high",
			note: null,
		})) as { success: boolean };
		expect(saved.success).toBe(true);
		const file = JSON.parse(readFileSync(path.join(project, ".workpilot", "self-healing", "config.json"), "utf-8"));
		expect(Object.values(file)).toEqual([
			{ enabled: true, riskThreshold: 40, watchBranches: ["main"], severityThreshold: "high", note: null },
		]);
	});

	it("sends a production source's settings on stdin, and only the four it reads", async () => {
		state.stdout = '{"success": true, "source": "sentry"}';
		const answer = await call(IPC_CHANNELS.SELF_HEALING_PRODUCTION_CONNECT, project, {
			source: "sentry",
			server_url: "https://sentry.example",
			api_key: "placeholder-key",
			project_id: "p1",
			environment: "",
			extra: "dropped",
		});
		expect(answer).toEqual({ success: true, source: "sentry" });
		const [spawned] = state.spawns;
		expect(spawned.args.slice(-5)).toEqual(["connect", "--source", "sentry", "--config", "-"]);
		expect(spawned.args.join(" ")).not.toContain("placeholder-key");
		expect(spawned.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
		expect(JSON.parse(spawned.stdin[0])).toEqual({
			source: "sentry",
			server_url: "https://sentry.example",
			api_key: "placeholder-key",
			project_id: "p1",
		});
	});

	it.each([
		null,
		"sentry",
		{ source: "splunk" },
		{ source: "sentry", server_url: "file:///etc/hosts" },
		{ source: "sentry", server_url: "not a url" },
		{ source: "sentry", api_key: "a\nb" },
		{ source: "sentry", project_id: 42 },
	])("refuses the production source %j", async (config) => {
		expect(await call(IPC_CHANNELS.SELF_HEALING_PRODUCTION_CONNECT, project, config)).toEqual(INVALID_INPUT);
		expect(state.spawns).toEqual([]);
	});

	it("disconnects a known source only", async () => {
		expect(await call(IPC_CHANNELS.SELF_HEALING_PRODUCTION_DISCONNECT, project, "--source")).toEqual(
			INVALID_INPUT,
		);
		expect(state.spawns).toEqual([]);
		state.stdout = '{"success": true}';
		await call(IPC_CHANNELS.SELF_HEALING_PRODUCTION_DISCONNECT, project, "datadog");
		expect(state.spawns[0].args.slice(-3)).toEqual(["disconnect", "--source", "datadog"]);
		expect(state.spawns[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
	});

	it("takes settings without a prototype, and a source without a server URL", () => {
		const bare = Object.assign(Object.create(null), { enabled: true });
		expect(modeConfig(bare)).toEqual({ enabled: true });
		expect(sourceConfig({ source: "pagerduty", api_key: "placeholder-key" })).toEqual({
			source: "pagerduty",
			api_key: "placeholder-key",
		});
		expect(sourceConfig({ source: "sentry", server_url: "http://sentry.local" })).toEqual({
			source: "sentry",
			server_url: "http://sentry.local",
		});
	});
});
