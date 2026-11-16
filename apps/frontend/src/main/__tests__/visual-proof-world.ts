/**
 * A machine for the visual proof tests: real folders, a real git repository
 * with a remote, a real HTTP server for the application being proven, and a
 * hidden browser whose pages are real DOMs (jsdom) built from what that server
 * answers. Only what the test machine cannot have is played: PowerShell, the
 * `gh` CLI, MSBuild, the launched desktop app, Electron's window capture and
 * the one-shot LLM call. Waiting costs no time: `delay` moves a fake clock.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import type { AppEmulatorConfig } from "../app-emulator-service";

/** What a played command answers: its output, or an error it fails with. */
export type Answer = string | Error;

export interface ExecCall {
	cmd: string;
	args: string[];
	options: { cwd?: string; env?: NodeJS.ProcessEnv; [key: string]: unknown };
}

export class FakeProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;
	constructor(readonly pid: number | undefined) {
		super();
	}
	kill(): boolean {
		this.killed = true;
		return true;
	}
}

export interface SpawnCall {
	cmd: string;
	args: string[];
	options: { cwd?: string; [key: string]: unknown };
	proc: FakeProcess;
}

interface World {
	windows: boolean;
	/** Answer of each played program, by program name (`gh`, `powershell`, a path…). */
	programs: Map<string, (args: string[], options: ExecCall["options"]) => Answer>;
	execs: ExecCall[];
	spawns: SpawnCall[];
	spawnPid: number | undefined;
	/** `findCommandInPath` answers. */
	onPath: Map<string, string>;
	msbuild: { command: string; argsPrefix: string[] } | null;
	/** Pages the hidden browser loaded, in order. */
	visits: string[];
	/** A load the hidden browser fails, by URL. */
	failLoads: Set<string>;
	/** Answer of the one-shot LLM; null = no provider. */
	llm: ((prompt: string) => string | null) | null;
	prompts: string[];
	emulator: {
		/** What the emulator detects; a test that runs the service sets it, or `detectError`. */
		config: AppEmulatorConfig | null;
		detectError?: Error;
		url: string | null;
		starts: AppEmulatorConfig[];
		stops: number;
	};
	delays: number[];
	dirs: string[];
	servers: Set<http.Server>;
}

export const world: World = {
	windows: false,
	programs: new Map(),
	execs: [],
	spawns: [],
	spawnPid: 7000,
	onPath: new Map(),
	msbuild: null,
	visits: [],
	failLoads: new Set(),
	llm: null,
	prompts: [],
	emulator: { config: null, url: null, starts: [], stops: 0 },
	delays: [],
	dirs: [],
	servers: new Set(),
};

export function resetWorld(): void {
	world.windows = false;
	world.programs = new Map();
	world.execs = [];
	world.spawns = [];
	world.spawnPid = 7000;
	world.onPath = new Map();
	world.msbuild = null;
	world.visits = [];
	world.failLoads = new Set();
	world.llm = null;
	world.prompts = [];
	world.emulator = { config: null, url: null, starts: [], stops: 0 };
	world.delays = [];
}

export async function cleanWorld(): Promise<void> {
	await Promise.all(
		[...world.servers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	world.servers.clear();
	for (const dir of world.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "vp-"): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	world.dirs.push(dir);
	return dir;
}

// ── child_process ────────────────────────────────────────────────────────────

function settle(answer: Answer): Promise<{ stdout: string; stderr: string }> {
	return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer, stderr: "" });
}

/** `vi.mock("node:child_process", …)`: git runs for real, every other program is played. */
export async function childProcessModule() {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	const realExecFile = promisify(actual.execFile);
	const run = (cmd: string, args: string[] = [], options: ExecCall["options"] = {}) => {
		world.execs.push({ cmd, args, options });
		if (cmd === "git") {
			return realExecFile(cmd, args, { ...options, encoding: "utf-8" }) as Promise<{
				stdout: string;
				stderr: string;
			}>;
		}
		const program = world.programs.get(cmd);
		return settle(program ? program(args, options) : new Error(`spawn ${cmd} ENOENT`));
	};
	// The code under test only calls `promisify(execFile)`: that is all it answers.
	const execFile = actual.execFile.bind(null);
	Object.defineProperty(execFile, promisify.custom, { value: run });
	const spawn = (cmd: string, args: string[], options: SpawnCall["options"]) => {
		const call = { cmd, args, options, proc: new FakeProcess(world.spawnPid) };
		world.spawns.push(call);
		return call.proc;
	};
	return { ...actual, execFile, spawn, default: { ...actual, execFile, spawn } };
}

/** `vi.mock("../platform", …)`. */
export async function platformModule() {
	const actual = await vi.importActual<typeof import("../platform")>("../platform");
	return { ...actual, isWindows: () => world.windows, isUnix: () => !world.windows };
}

/** `vi.mock("../dotnet-msbuild", …)`: what is installed on the machine. */
export async function dotnetMsbuildModule() {
	const actual = await vi.importActual<typeof import("../dotnet-msbuild")>("../dotnet-msbuild");
	return {
		...actual,
		findCommandInPath: (name: string) => world.onPath.get(name) ?? null,
		findMsBuildInvocation: () => world.msbuild,
	};
}

/** `vi.mock("../app-emulator-service", …)`: the emulator, already tested on its own. */
export function appEmulatorModule() {
	return {
		appEmulatorService: {
			detectProject: async () => {
				if (world.emulator.detectError) throw world.emulator.detectError;
				return structuredClone(world.emulator.config as AppEmulatorConfig);
			},
			startServer: async (config: AppEmulatorConfig) => {
				world.emulator.starts.push(config);
			},
			getUrl: () => world.emulator.url,
			stopServer: () => {
				world.emulator.stops += 1;
			},
		},
	};
}

/** `vi.mock("../oneshot-llm", …)`. */
export function oneShotModule() {
	return {
		runOneShotLLM: async ({ prompt }: { prompt: string }) => {
			world.prompts.push(prompt);
			return world.llm ? world.llm(prompt) : null;
		},
	};
}

/** `vi.mock("node:timers/promises", …)`: a wait moves the fake clock. */
export async function timersModule() {
	const actual = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
	return {
		...actual,
		setTimeout: async (ms: number) => {
			world.delays.push(ms);
			vi.setSystemTime(Date.now() + ms);
		},
	};
}

// ── Electron ────────────────────────────────────────────────────────────────

/** The hidden browser: each page is a DOM built from what the server answered. */
class FakeBrowserWindow {
	static opened: FakeBrowserWindow[] = [];
	url = "";
	dom: JSDOM | null = null;
	destroyed = false;
	readonly webContents = {
		loadURL: (url: string) => this.loadURL(url),
		executeJavaScript: async (script: string) => this.run(script),
		capturePage: async () => {
			const page = this.url;
			return { toPNG: () => Buffer.from(`PNG ${page}`) };
		},
	};

	constructor(readonly options: Record<string, unknown>) {
		FakeBrowserWindow.opened.push(this);
	}

	async loadURL(url: string): Promise<void> {
		world.visits.push(url);
		if (world.failLoads.has(url)) throw new Error(`ERR_CONNECTION_REFUSED (${url})`);
		const response = await fetch(url);
		const html = await response.text();
		this.url = url;
		this.dom = new JSDOM(html, { url, runScripts: "outside-only" });
		// jsdom lays nothing out; a browser scrolls the element into view.
		this.dom.window.Element.prototype.scrollIntoView = () => undefined;
	}

	/** Runs the page script in the DOM; its clock moves 200 ms per timer. */
	run(script: string): unknown {
		const { window } = this.dom as JSDOM;
		let now = 0;
		const timed = window as unknown as {
			Date: { now: () => number };
			setTimeout: (fn: () => void, ms: number) => void;
		};
		timed.Date.now = () => now;
		timed.setTimeout = (fn, ms) => {
			now += ms;
			queueMicrotask(fn);
		};
		return window.eval(script);
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	close(): void {
		this.destroyed = true;
	}
}

export const browserWindows = FakeBrowserWindow.opened;

/** `vi.mock("electron", …)`. */
export async function electronModule() {
	const actual = await vi.importActual<Record<string, unknown>>("electron");
	return {
		...actual,
		BrowserWindow: FakeBrowserWindow,
		default: { ...actual, BrowserWindow: FakeBrowserWindow },
	};
}

// ── The application being proven ────────────────────────────────────────────

export interface Route {
	status?: number;
	type?: string;
	body: string;
}

/** A real HTTP server on 127.0.0.1 answering `routes` by path (404 otherwise). */
export async function appServer(routes: Record<string, Route | string>): Promise<string> {
	const server = http.createServer((request, response) => {
		const { pathname } = new URL(request.url as string, "http://localhost");
		const route = routes[pathname];
		if (route === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found");
			return;
		}
		const { status = 200, type = "text/html", body } =
			typeof route === "string" ? { body: route } : route;
		response.writeHead(status, { "content-type": type });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	world.servers.add(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
