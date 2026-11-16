/**
 * @vitest-environment node
 *
 * The Browser Agent handlers check what the renderer sends before they start
 * the runner: a page address is an http(s) URL, a name is one file-name token,
 * and each value reaches the runner as `--option=value`, in an environment
 * built for a runner that calls no model.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	spawn: vi.fn(),
	staticEnv: vi.fn((_backend: string) => ({ PYTHONIOENCODING: "utf-8" })),
	resolveInProject: vi.fn((value: unknown) =>
		typeof value === "string" && value.startsWith("/projects/demo/")
			? value
			: null,
	),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			state.handlers.set(channel, handler),
	},
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const mocked = { ...actual, spawn: state.spawn };
	return { ...mocked, default: mocked };
});
vi.mock("../../python-detector", () => ({
	parsePythonCommand: (python: string) => [python, []],
}));
vi.mock("../../python-env-manager", () => ({
	getConfiguredPythonPath: () => "python3",
	pythonEnvManager: {
		getPythonEnv: () => {
			throw new Error("the runner env is built, not taken from here");
		},
	},
}));
vi.mock("../../utils/python-runner-env", () => ({
	pythonStaticRunnerEnv: state.staticEnv,
}));
vi.mock("../../security/renderer-path", () => ({
	resolveInProject: state.resolveInProject,
}));

import { registerBrowserAgentHandlers } from "../browser-agent-handlers";

registerBrowserAgentHandlers();

const PROJECT = "/projects/demo";
const OK = JSON.stringify({ success: true, data: { path: "x.png" } });

function runner(stdout = OK, code = 0) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	queueMicrotask(() => {
		child.stdout.emit("data", Buffer.from(stdout));
		child.emit("close", code);
	});
	return child;
}

function call(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<{ success: boolean; error?: string }>;
}

/** The runner's arguments after `--json`, from the last spawn. */
function runnerArgs(): string[] {
	const argv = state.spawn.mock.calls.at(-1)?.[1] as string[];
	return argv.slice(argv.indexOf("--json") + 1);
}

beforeEach(() => {
	state.spawn.mockReset();
	state.spawn.mockImplementation(() => runner());
	state.staticEnv.mockClear();
});

const HOSTILE_URLS: unknown[] = [
	"file:///etc/passwd",
	"javascript:alert(1)",
	"data:text/html,<p>",
	"--project=/elsewhere",
	"http://example.com/\nsecond",
	"http://example.com/\u0000",
	"http://example.com/\u0085",
	`https://example.com/${"a".repeat(2048)}`,
	"not a url",
	"",
	42,
	{ href: "https://example.com" },
];

const HOSTILE_NAMES: unknown[] = [
	"--project=/elsewhere",
	"-x",
	"../outside",
	"a/b",
	"login page",
	"a\u0000b",
	"a".repeat(129),
	"",
	7,
	null,
];

describe("page address", () => {
	it.each(HOSTILE_URLS)("refuses %j for a screenshot, before the runner starts", async (url) => {
		const result = await call(IPC_CHANNELS.BROWSER_AGENT_CAPTURE_SCREENSHOT, PROJECT, "home", url);
		expect(result).toEqual({ success: false, error: "Only an http or https URL can be opened" });
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it.each(HOSTILE_URLS)("refuses %j for a navigation", async (url) => {
		const result = await call(IPC_CHANNELS.BROWSER_AGENT_NAVIGATE, PROJECT, url);
		expect(result.success).toBe(false);
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it.each(HOSTILE_URLS.filter(Boolean))("refuses %j for a comparison", async (url) => {
		const result = await call(IPC_CHANNELS.BROWSER_AGENT_COMPARE, PROJECT, "home", url);
		expect(result.success).toBe(false);
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it("passes an http(s) URL as one --url= argument", async () => {
		await call(IPC_CHANNELS.BROWSER_AGENT_CAPTURE_SCREENSHOT, PROJECT, "home", "http://localhost:3000");
		expect(runnerArgs()).toEqual(["screenshot", "--url=http://localhost:3000/", "--name=home"]);

		await call(IPC_CHANNELS.BROWSER_AGENT_NAVIGATE, PROJECT, "https://example.com/a?b=-c");
		expect(runnerArgs()).toEqual([
			"screenshot",
			"--url=https://example.com/a?b=-c",
			"--name=navigation_preview",
		]);

		await call(IPC_CHANNELS.BROWSER_AGENT_COMPARE, PROJECT, "home", "https://example.com");
		expect(runnerArgs()).toEqual(["compare", "--name=home", "--url=https://example.com/"]);
	});

	it("compares against the last screenshot when no URL is sent", async () => {
		await call(IPC_CHANNELS.BROWSER_AGENT_COMPARE, PROJECT, "home");
		expect(runnerArgs()).toEqual(["compare", "--name=home"]);
	});
});

describe("screenshot and baseline name", () => {
	it.each(HOSTILE_NAMES)("refuses %j on every handler that takes one", async (name) => {
		for (const [channel, ...rest] of [
			[IPC_CHANNELS.BROWSER_AGENT_CAPTURE_SCREENSHOT, "https://example.com"],
			[IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE],
			[IPC_CHANNELS.BROWSER_AGENT_DELETE_BASELINE],
			[IPC_CHANNELS.BROWSER_AGENT_COMPARE],
		]) {
			const result = await call(channel, PROJECT, name, ...rest);
			expect(result.success, channel).toBe(false);
			expect(result.error, channel).toMatch(/^A name may only contain/);
		}
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it("passes a name as one --name= argument", async () => {
		await call(IPC_CHANNELS.BROWSER_AGENT_DELETE_BASELINE, PROJECT, "home_v1.2-b");
		expect(runnerArgs()).toEqual(["baseline", "delete", "--name=home_v1.2-b"]);

		await call(IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE, PROJECT, "home");
		expect(runnerArgs()).toEqual(["baseline", "set", "--name=home"]);

		const shot = `${PROJECT}/.workpilot/browser-agent/screenshots/home.png`;
		await call(IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE, PROJECT, "home", shot);
		expect(runnerArgs()).toEqual(["baseline", "set", "--name=home", `--screenshot=${shot}`]);
	});

	it("refuses a baseline screenshot outside the project", async () => {
		const result = await call(IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE, PROJECT, "home", "/etc/passwd");
		expect(result.success).toBe(false);
		expect(state.spawn).not.toHaveBeenCalled();
	});
});

describe("runner launch", () => {
	it("starts the runner in the project, with the built environment", async () => {
		await call(IPC_CHANNELS.BROWSER_AGENT_LIST_BASELINES, PROJECT);
		const [cmd, argv, options] = state.spawn.mock.calls[0];
		expect(cmd).toBe("python3");
		expect(argv[0]).toMatch(/backend[\\/]runners[\\/]browser_agent_runner\.py$/);
		expect(argv.slice(1)).toEqual([`--project=${PROJECT}`, "--json", "baseline", "list"]);
		expect(options).toMatchObject({ cwd: PROJECT, env: { PYTHONIOENCODING: "utf-8" } });
		expect(state.staticEnv.mock.calls[0][0]).toMatch(/backend$/);
		expect(argv[0].startsWith(state.staticEnv.mock.calls[0][0])).toBe(true);
	});

	it.each([undefined, "", 3])("starts nothing without a project folder (%j)", async (project) => {
		const result = await call(IPC_CHANNELS.BROWSER_AGENT_RUN_TESTS, project);
		expect(result.success).toBe(false);
		expect(state.spawn).not.toHaveBeenCalled();
		await call(IPC_CHANNELS.BROWSER_AGENT_GET_DASHBOARD, project);
		expect(state.spawn).not.toHaveBeenCalled();
	});
});
