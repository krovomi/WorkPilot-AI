/**
 * A venv can outlive its interpreter (base Python upgraded or removed): the
 * directory is there, `bin/python` dangles, and a plain `python -m venv` exits
 * 0 without fixing it. Every page that needs Python then failed with
 * "Python environment not ready: Unhandled error. ('Python not found in
 * virtual environment')". These tests pin the repair and the error reporting.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	existing: new Set<string>(),
	spawns: [] as { command: string; args: string[] }[],
	onSpawn: (_command: string, _args: string[]): number => 0,
}));

vi.mock("node:fs", () => {
	const mod = {
		existsSync: vi.fn((p: string) => state.existing.has(String(p))),
		readdirSync: vi.fn(() => []),
		writeFileSync: vi.fn(),
		readFileSync: vi.fn(() => ""),
		mkdirSync: vi.fn(),
		renameSync: vi.fn(),
		unlinkSync: vi.fn(),
		promises: {},
	};
	return { ...mod, default: mod };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn((command: string, args: string[]) => {
		state.spawns.push({ command, args });
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			stdin: { write: () => void; end: () => void };
			kill: () => void;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.stdin = { write: () => undefined, end: () => undefined };
		proc.kill = () => undefined;
		const code = state.onSpawn(command, args);
		setImmediate(() => proc.emit("close", code));
		return proc;
	});
	const execSync = vi.fn(() => SYSTEM_PYTHON);
	const mod = { ...actual, spawn, execSync };
	return { ...mod, default: mod };
});

vi.mock("electron", () => ({
	app: {
		isPackaged: false,
		getPath: vi.fn().mockReturnValue("/mock/user/data"),
		getAppPath: vi.fn().mockReturnValue("/mock/app"),
		on: vi.fn(),
	},
}));

vi.mock("../python-detector", () => ({
	findPythonCommand: vi.fn().mockReturnValue("python"),
	getBundledPythonPath: vi.fn().mockReturnValue(null),
}));

import { isWindows } from "../platform";
import { PythonEnvManager } from "../python-env-manager";

const SYSTEM_PYTHON = "/usr/bin/python3";
const SOURCE = path.join("/repo", "apps", "backend");
const VENV = path.join(SOURCE, ".venv");
const VENV_PYTHON = isWindows()
	? path.join(VENV, "Scripts", "python.exe")
	: path.join(VENV, "bin", "python");
const REQUIREMENTS = path.join(SOURCE, "requirements.txt");

const isVenvCreation = (args: string[]) => args[0] === "-m" && args[1] === "venv";
const venvCreations = () => state.spawns.filter((s) => isVenvCreation(s.args));

describe("PythonEnvManager venv repair", () => {
	beforeEach(() => {
		state.existing = new Set([SYSTEM_PYTHON, SOURCE, REQUIREMENTS]);
		state.spawns = [];
	});

	it("rebuilds with --clear a venv whose interpreter link dangles", async () => {
		state.existing.add(VENV); // directory left, interpreter gone
		state.onSpawn = (_cmd, args) => {
			// Like CPython: without --clear the dangling link stays in place.
			if (isVenvCreation(args) && args.includes("--clear")) {
				state.existing.add(VENV_PYTHON);
			}
			return 0;
		};

		const status = await new PythonEnvManager().initialize(SOURCE);

		expect(status.ready).toBe(true);
		expect(status.pythonPath).toBe(VENV_PYTHON);
		expect(venvCreations()).toHaveLength(1);
		expect(venvCreations()[0].args).toEqual(["-m", "venv", "--clear", VENV]);
	});

	it("reports a missing interpreter plainly instead of throwing 'Unhandled error'", async () => {
		state.onSpawn = () => 0; // venv "succeeds" but never yields an interpreter

		const status = await new PythonEnvManager().initialize(SOURCE);

		expect(status.ready).toBe(false);
		expect(status.error).toContain("Python not found in virtual environment");
		expect(status.error).toContain(VENV_PYTHON);
		expect(status.error).not.toContain("Unhandled error");
		// A fresh attempt, then one retry from a clean directory.
		expect(venvCreations().map((s) => s.args.includes("--clear"))).toEqual([
			false,
			true,
		]);
	});

	it("returns the venv creation failure itself as the error", async () => {
		state.onSpawn = (_cmd, args) => (isVenvCreation(args) ? 1 : 0);

		const status = await new PythonEnvManager().initialize(SOURCE);

		expect(status.ready).toBe(false);
		expect(status.error).toMatch(/^Failed to create virtual environment/);
	});

	it("rebuilds a venv whose interpreter exists but no longer starts", async () => {
		state.existing.add(VENV).add(VENV_PYTHON);
		let rebuilt = false;
		state.onSpawn = (cmd, args) => {
			if (isVenvCreation(args)) {
				rebuilt = args.includes("--clear");
				return 0;
			}
			if (cmd === VENV_PYTHON && !rebuilt) return 103; // base Python removed
			return 0;
		};

		const status = await new PythonEnvManager().initialize(SOURCE);

		expect(status.ready).toBe(true);
		expect(venvCreations()).toHaveLength(1);
		expect(venvCreations()[0].args).toContain("--clear");
	});

	it("only installs packages when the interpreter runs but packages are missing", async () => {
		state.existing.add(VENV).add(VENV_PYTHON);
		let installed = false;
		state.onSpawn = (_cmd, args) => {
			if (args.includes("pip")) {
				installed = true;
				return 0;
			}
			if (args[0] === "-") return installed ? 0 : 1; // dependency probe
			return 0;
		};

		const status = await new PythonEnvManager().initialize(SOURCE);

		expect(status.ready).toBe(true);
		expect(venvCreations()).toHaveLength(0);
		expect(installed).toBe(true);
	});
});
