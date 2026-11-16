/**
 * The App Emulator starts what this process detected: the renderer names a
 * detected project, it does not choose the command, and an install runs in
 * the same environment as the dev server.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { appEmulatorService } from "../../app-emulator-service";
import { NOT_DETECTED, registerAppEmulatorHandlers } from "../app-emulator-handlers";

interface Spawned {
	cmd: string;
	args: string[];
	cwd?: string;
	env: Record<string, string | undefined>;
}

const spawned = vi.hoisted(() => [] as Spawned[]);

/** One process as its command line: Windows starts it through the shell, whole. */
const commandLine = ({ cmd, args }: Spawned) => [cmd, ...args].join(" ");

/**
 * The processes the emulator ran in the project. On Windows it also runs its
 * own helpers (PowerShell to free the port, taskkill to stop a server), which
 * run no project code and have no working folder.
 */
const launched = () => spawned.filter((proc) => proc.cwd !== undefined);

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	const spawn = (cmd: string, args: string[], options: { cwd?: string; env: Spawned["env"] }) => {
		spawned.push({ cmd, args, cwd: options.cwd, env: options.env });
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			pid: 4242,
			killed: false,
			kill: () => true,
		});
		// An install finishes at once; a dev server keeps running.
		if (args[0] === "install") setImmediate(() => proc.emit("close", 0));
		return proc;
	};
	return { ...actual, spawn, default: { ...actual, spawn } };
});

const invoke = (channel: string, ...args: unknown[]) =>
	(
		ipcMain as unknown as {
			invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown>;
		}
	).invokeHandler(channel, {}, ...args);

let root: string;

function folder(files: Record<string, string>): string {
	const dir = path.join(root, `p${Math.random().toString(36).slice(2)}`);
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(dir, name);
		mkdirSync(path.dirname(target), { recursive: true });
		if (!name.endsWith("/")) writeFileSync(target, content);
	}
	return dir;
}

async function start(config: unknown): Promise<unknown> {
	const result = invoke(IPC_CHANNELS.APP_EMULATOR_START, { config });
	await vi.advanceTimersByTimeAsync(1000);
	await new Promise((resolve) => setImmediate(resolve));
	await vi.advanceTimersByTimeAsync(0);
	return result;
}

/** Start a web project until `count` processes ran, then stop it. */
async function startUntilSpawned(config: unknown, count: number): Promise<void> {
	const result = invoke(IPC_CHANNELS.APP_EMULATOR_START, { config });
	for (let step = 0; step < 50 && launched().length < count; step++) {
		await vi.advanceTimersByTimeAsync(250);
		await new Promise((resolve) => setImmediate(resolve));
	}
	appEmulatorService.stopServer();
	await vi.advanceTimersByTimeAsync(1000);
	await result;
}

beforeAll(() => {
	registerAppEmulatorHandlers(() => null);
});

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-emulator-start-"));
	spawned.length = 0;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	appEmulatorService.stopServer();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("starting the App Emulator", () => {
	it("refuses a project that was not detected", async () => {
		const dir = folder({ "Cargo.toml": "" });

		expect(
			await start({
				type: "cli",
				framework: "rust",
				startCommand: "cargo run",
				port: 0,
				isWeb: false,
				projectDir: dir,
			}),
		).toEqual({ success: false, error: NOT_DETECTED });
		expect(await start({ projectDir: 42 })).toEqual({ success: false, error: NOT_DETECTED });
		expect(await start(undefined)).toEqual({ success: false, error: NOT_DETECTED });
		expect(spawned).toEqual([]);
	});

	it("refuses a detection that names no folder", async () => {
		const config = { type: "cli", framework: "rust", startCommand: "cargo run", port: 0, isWeb: false };
		vi.spyOn(appEmulatorService, "detectProject").mockResolvedValueOnce(config);

		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: root })).toEqual({
			success: true,
			data: config,
		});
		expect(await start({ ...config, projectDir: root })).toEqual({ success: false, error: NOT_DETECTED });
		expect(spawned).toEqual([]);
	});

	it("runs the detected command, whatever command comes back with the request", async () => {
		const dir = folder({ "Cargo.toml": "" });
		const detection = (await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir })) as {
			data: Record<string, unknown>;
		};

		expect(
			await start({ ...detection.data, startCommand: "another-program --flag", port: 1 }),
		).toEqual({ success: true });

		expect(launched().map(commandLine)).toEqual(["cargo run"]);
		expect(appEmulatorService.getConfig()).toMatchObject({ startCommand: "cargo run", port: 0 });
	});

	it("starts again from the detection, not from what an earlier start changed", async () => {
		const dir = folder({ "Cargo.toml": "" });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });
		await start({ projectDir: dir });
		const first = appEmulatorService.getConfig();
		if (first) first.startCommand = "changed";

		await start({ projectDir: dir });

		expect(launched().map(commandLine)).toEqual(["cargo run", "cargo run"]);
	});

	it("installs dependencies without the user's credentials", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-0000");
		vi.stubEnv("GITHUB_TOKEN", "gh-test-0000");
		const dir = folder({ "package.json": JSON.stringify({ scripts: { dev: "x" } }) });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });

		await startUntilSpawned({ projectDir: dir }, 2);

		const [install, server] = launched();
		expect(commandLine(install)).toBe("npm install");
		expect(install.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(install.env.GITHUB_TOKEN).toBeUndefined();
		expect(install.env.PATH).toBe(process.env.PATH);
		expect(server.env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("installs Python dependencies without the user's credentials", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-0000");
		const dir = folder({ "main.py": "", "requirements.txt": "requests" });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });

		await start({ projectDir: dir });

		const [install] = launched();
		expect(commandLine(install)).toBe("pip install -r requirements.txt");
		expect(install.env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
