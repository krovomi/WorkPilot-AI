/**
 * A small machine for the App Emulator tests: real folders and real sockets,
 * a fake `spawn` whose processes the test scripts, and a platform switch.
 *
 * A spawned process does nothing until the test says so: `world.onSpawn`
 * decides what each command does (print, listen on its port, exit). A dev
 * server that "starts" opens a real HTTP server on the port the emulator gave
 * it, so the port probes and the readiness checks run unchanged.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

/** The real `setTimeout`, kept before a test fakes the timers. */
const realSetTimeout = globalThis.setTimeout;

export class FakeProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;
	readonly killSignals: Array<string | undefined> = [];
	/** Whether a kill makes the process exit on its own (true by default). */
	exitOnKill = true;

	constructor(readonly pid: number) {
		super();
	}

	kill(signal?: string): boolean {
		this.killed = true;
		this.killSignals.push(signal);
		if (this.exitOnKill) setImmediate(() => this.emit("close", null, signal));
		return true;
	}

	print(text: string, stream: "stdout" | "stderr" = "stdout"): void {
		this[stream].emit("data", Buffer.from(text, "utf-8"));
	}

	exit(code: number | null): void {
		this.emit("close", code, null);
	}

	fail(message: string): void {
		this.emit("error", new Error(message));
	}
}

export interface SpawnCall {
	cmd: string;
	args: string[];
	options: {
		cwd?: string;
		env?: Record<string, string | undefined>;
		shell?: boolean;
		stdio?: unknown;
	};
	proc: FakeProcess;
}

type SpawnBehaviour = (call: SpawnCall) => void;

interface World {
	windows: boolean;
	spawns: SpawnCall[];
	onSpawn: SpawnBehaviour;
	servers: Set<net.Server>;
	dirs: string[];
	nextPid: number;
}

const noBehaviour: SpawnBehaviour = () => undefined;

export const world: World = {
	windows: false,
	spawns: [],
	onSpawn: noBehaviour,
	servers: new Set(),
	dirs: [],
	nextPid: 4000,
};

export function resetWorld(): void {
	world.windows = false;
	world.spawns = [];
	world.onSpawn = noBehaviour;
	world.nextPid = 4000;
}

/** Close the servers and remove the folders a test created. */
export async function cleanWorld(): Promise<void> {
	await Promise.all([...world.servers].map(closeServer));
	world.servers.clear();
	for (const dir of world.dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		const closable = server as net.Server & { closeAllConnections?: () => void };
		closable.closeAllConnections?.();
		server.close(() => resolve());
	});
}

function fakeSpawn(cmd: string, args: string[], options: SpawnCall["options"]): FakeProcess {
	const proc = new FakeProcess(world.nextPid++);
	const call: SpawnCall = { cmd, args, options, proc };
	world.spawns.push(call);
	world.onSpawn(call);
	return proc;
}

/** `vi.mock("node:child_process", …)` factory. */
export async function childProcessModule() {
	const actual =
		await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return { ...actual, spawn: vi.fn(fakeSpawn), default: { ...actual, spawn: vi.fn(fakeSpawn) } };
}

/** `vi.mock("../platform", …)` factory: the OS the test chose. */
export async function platformModule() {
	const actual = await vi.importActual<typeof import("../platform")>("../platform");
	return {
		...actual,
		isWindows: () => world.windows,
		isUnix: () => !world.windows,
	};
}

/** The spawned commands whose program is `cmd`. */
export function spawnsOf(cmd: string): SpawnCall[] {
	return world.spawns.filter((call) => call.cmd === cmd);
}

/** A temporary project folder, filled from `{ "relative/path": "content" }`. */
export function project(files: Record<string, string> = {}, name = "proj"): string {
	const root = mkdtempSync(path.join(tmpdir(), "wp-emulator-"));
	world.dirs.push(root);
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	addFiles(dir, files);
	return dir;
}

export function addFiles(dir: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(dir, relative);
		if (relative.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

export function pkg(body: Record<string, unknown>): string {
	return JSON.stringify(body);
}

/** A port nothing listens on (asked from the OS, then released). */
export async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const { port } = server.address() as net.AddressInfo;
	await closeServer(server);
	return port;
}

/** A real HTTP server on all interfaces, as a dev server would open one. */
export async function httpServer(
	port: number,
	status: number | (() => number) = 200,
): Promise<http.Server> {
	const server = http.createServer((_req, res) => {
		res.statusCode = typeof status === "function" ? status() : status;
		res.end("ok");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, resolve);
	});
	world.servers.add(server);
	return server;
}

/** A listener that never answers HTTP: an orphaned process holding the port. */
export async function silentListener(port: number): Promise<net.Server> {
	const server = net.createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, resolve);
	});
	world.servers.add(server);
	return server;
}

/** A dev server behaviour: it listens on the `PORT` the emulator passed. */
export function startsHttpServer(status: number | (() => number) = 200): SpawnBehaviour {
	return (call) => {
		const port = Number(call.options.env?.PORT);
		httpServer(port, status).catch(() => undefined);
	};
}

/**
 * Settle a promise whose code waits on fake `setTimeout`s and real sockets:
 * advance the fake clock a step, let real I/O run, repeat.
 */
export async function drive<T>(promise: Promise<T>, maxSteps = 2000): Promise<T> {
	let settled = false;
	const watched = promise.finally(() => {
		settled = true;
	});
	watched.catch(() => undefined);
	for (let step = 0; step < maxSteps && !settled; step++) {
		await vi.advanceTimersByTimeAsync(250);
		await new Promise((resolve) => realSetTimeout(resolve, 2));
	}
	return watched;
}

/** Let real I/O and immediates run for a moment. */
export function realPause(ms = 20): Promise<void> {
	return new Promise((resolve) => realSetTimeout(resolve, ms));
}
