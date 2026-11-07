import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quitting stops the Python bootstrap (F134): every step it spawns is killed
 * by cleanup(), and none starts afterwards. An untracked ensurepip or pip
 * install used to outlive the app and keep writing into the venv.
 */

const spawned: FakeProcess[] = [];

class FakeProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn(), end: vi.fn() };
	kill = vi.fn(() => {
		this.emit("close", null);
		return true;
	});
	constructor(readonly args: string[]) {
		super();
	}
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn((_command: string, args: string[]) => {
		const proc = new FakeProcess(args);
		spawned.push(proc);
		return proc;
	});
	return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mod = { ...actual, existsSync: vi.fn(() => true) };
	return { ...mod, default: mod };
});

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/mock/user/data"), on: vi.fn() },
}));

vi.mock("../python-detector", () => ({
	findPythonCommand: vi.fn(() => "python3"),
	getBundledPythonPath: vi.fn(() => null),
}));

import { PythonEnvManager } from "../python-env-manager";

type Internals = {
	autoBuildSourcePath: string | null;
	bootstrapPip: () => Promise<boolean>;
	installDeps: () => Promise<boolean>;
	checkDepsInstalled: () => Promise<boolean>;
};

describe("PythonEnvManager on quit", () => {
	let manager: PythonEnvManager;
	let internals: Internals;

	beforeEach(() => {
		spawned.length = 0;
		manager = new PythonEnvManager();
		internals = manager as unknown as Internals;
		internals.autoBuildSourcePath = "/repo/apps/backend";
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("kills the pip bootstrap that is still running", async () => {
		const bootstrap = internals.bootstrapPip();
		expect(spawned.map((proc) => proc.args)).toEqual([["-m", "ensurepip"]]);

		manager.cleanup();

		expect(spawned[0].kill).toHaveBeenCalledTimes(1);
		await expect(bootstrap).resolves.toBe(false);
	});

	it("kills the dependency check that is still running", async () => {
		const check = internals.checkDepsInstalled();
		expect(spawned).toHaveLength(1);

		manager.cleanup();

		expect(spawned[0].kill).toHaveBeenCalledTimes(1);
		await expect(check).resolves.toBe(false);
	});

	it("starts no Python process once the app is quitting", async () => {
		manager.cleanup();

		await expect(internals.installDeps()).resolves.toBe(false);
		await expect(internals.checkDepsInstalled()).resolves.toBe(false);
		expect(spawned).toHaveLength(0);
	});

	it("forgets a process that ended on its own", async () => {
		const bootstrap = internals.bootstrapPip();
		spawned[0].emit("close", 0);
		await expect(bootstrap).resolves.toBe(true);

		manager.cleanup();

		expect(spawned[0].kill).not.toHaveBeenCalled();
	});
});
