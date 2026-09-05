/**
 * Tests for the real `ollama:pullModel` main-process handler.
 *
 * These exist because of a bug that shipped green: the handler registered its
 * in-flight entry from *inside* the `new Promise(...)` executor, which runs
 * synchronously, so reading the `promise` binding there hit its temporal dead
 * zone and every single pull died with
 *
 *     Error invoking remote method 'ollama:pullModel':
 *     ReferenceError: Cannot access 'promise' before initialization
 *
 * Nothing caught it. The renderer-side tests mock `window.electronAPI`, so they
 * prove the hook calls the bridge correctly and never execute one line of the
 * handler the bridge reaches. Typecheck and lint cannot see a TDZ violation
 * either — it is legal TypeScript that only fails at run time.
 *
 * So the rule these tests encode is: the handler body has to actually run,
 * over a real subprocess. Only two seams are replaced — which interpreter to
 * launch, and where the detector script lives — and a small Node program
 * stands in for `ollama_model_detector.py`, speaking the same protocol
 * (NDJSON progress on stderr, a `{success,…}` document on stdout, an exit
 * code). Everything between the IPC call and that process is the shipping
 * code path.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stand-in for `ollama_model_detector.py`, run under Node.
 *
 * Behaviour is chosen by the model name so each test can ask for the outcome
 * it needs. It records every launch in `PULL_SPAWN_LOG` so a test can prove a
 * second request did NOT start a second process.
 */
const FAKE_DETECTOR = `
const fs = require("node:fs");
const argv = process.argv.slice(1);
const model = argv[argv.indexOf("pull-model") + 1];
if (process.env.PULL_SPAWN_LOG) {
  fs.appendFileSync(process.env.PULL_SPAWN_LOG, argv.join(" ") + "\\n");
}
if (model === "hangs") {
  // Stay alive until killed, so cancellation has something to cancel.
  setInterval(() => {}, 1000);
} else if (model === "fails") {
  // The detector reports failures on STDOUT and still exits 1.
  process.stdout.write(JSON.stringify({
    success: false, error: "no GGUF build in this repo",
  }));
  process.exit(1);
} else {
  process.stderr.write(JSON.stringify({
    status: "downloading", completed: 50, total: 100,
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    success: true,
    data: { model, status: "completed", output: ["ok"] },
  }));
  process.exit(0);
}
`;

let spawnLog = "";

// Seam 1: which interpreter runs the detector. Node stands in for Python so
// the test needs no interpreter beyond the one already running it.
vi.mock("../../python-detector", () => ({
	parsePythonCommand: () => [process.execPath, ["-e", FAKE_DETECTOR]],
}));

// Seam 2: the environment the subprocess inherits, which is also how the fake
// detector is told where to log its launches.
vi.mock("../../python-env-manager", () => ({
	getConfiguredPythonPath: () => "node",
	pythonEnvManager: {
		getPythonEnv: () => ({ ...process.env, PULL_SPAWN_LOG: spawnLog }),
	},
}));

// The handler probes a few candidate locations for the detector script; none
// of them exist in a test checkout, and the path it settles on is passed
// straight through to the fake detector, which ignores it.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, default: actual, existsSync: () => true };
});

import { IPC_CHANNELS } from "../../../shared/constants";
import { registerMemoryHandlers } from "../memory-handlers";

/**
 * The vitest electron mock tracks "open" windows on the class so
 * `getAllWindows()` has something to return; the real electron typings know
 * nothing about it, and it is the real typings TypeScript resolves here.
 */
const MockBrowserWindow = BrowserWindow as unknown as typeof BrowserWindow & {
	openWindows: InstanceType<typeof BrowserWindow>[];
};

type TestIpcMain = typeof ipcMain & {
	invokeHandler: (
		channel: string,
		event: unknown,
		...args: unknown[]
	) => Promise<unknown>;
};

type PullResult = { success: boolean; error?: string; data?: unknown };

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	return (ipcMain as TestIpcMain).invokeHandler(channel, null, ...args);
}

function pull(model: string, baseUrl?: string): Promise<PullResult> {
	return invoke(
		IPC_CHANNELS.OLLAMA_PULL_MODEL,
		model,
		baseUrl,
	) as Promise<PullResult>;
}

function activePulls(): Promise<{ data: { models: string[] } }> {
	return invoke(IPC_CHANNELS.OLLAMA_ACTIVE_PULLS) as Promise<{
		data: { models: string[] };
	}>;
}

/** Launches the fake detector recorded so far. */
function spawnCount(): number {
	try {
		return readFileSync(spawnLog, "utf-8").trim().split("\n").filter(Boolean)
			.length;
	} catch {
		return 0;
	}
}

/** Wait until the handler has launched its subprocess at least `n` times. */
async function waitForSpawns(n: number): Promise<void> {
	for (let i = 0; i < 200 && spawnCount() < n; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(spawnCount()).toBeGreaterThanOrEqual(n);
}

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(tmpdir(), "workpilot-pull-"));
	spawnLog = path.join(tempDir, "spawns.log");
	writeFileSync(spawnLog, "");
	registerMemoryHandlers();
});

afterEach(() => {
	MockBrowserWindow.openWindows.length = 0;
	rmSync(tempDir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("ollama:pullModel handler", () => {
	it("starts a pull instead of throwing", async () => {
		// The regression itself. Before the fix this rejected with
		// "Cannot access 'promise' before initialization" — every pull, always,
		// so the feature was completely inert in the shipped app.
		await expect(pull("llama3.3")).resolves.toMatchObject({ success: true });
	});

	it("passes the configured base URL through to the detector", async () => {
		// A pull sent to localhost while the run talks to a custom host lands the
		// model where nothing will look for it: "downloaded" and still missing.
		await pull("llama3.3", "http://192.168.1.20:11434");
		expect(readFileSync(spawnLog, "utf-8")).toContain(
			"--base-url http://192.168.1.20:11434",
		);
	});

	it("omits --base-url when none is configured", async () => {
		await pull("llama3.3");
		expect(readFileSync(spawnLog, "utf-8")).not.toContain("--base-url");
	});

	it("reports the detector's own error rather than an exit code", async () => {
		// The detector writes {success:false,error} to stdout AND exits 1, so a
		// handler that only read the code hid the actionable message behind
		// "Échec du téléchargement (code 1)".
		await expect(pull("fails")).resolves.toMatchObject({
			success: false,
			error: "no GGUF build in this repo",
		});
	});

	it("joins a running pull instead of starting a second one", async () => {
		// Clicking twice, or re-picking the model while it downloads, must not
		// spend the bandwidth twice for the same bytes.
		const first = pull("hangs");
		await waitForSpawns(1);
		const second = pull("hangs");

		await invoke(IPC_CHANNELS.OLLAMA_CANCEL_PULL, "hangs");
		await Promise.all([first, second]);

		expect(spawnCount()).toBe(1);
	});

	it("reports a cancellation as PULL_CANCELLED, not as a failure", async () => {
		// The renderer tells the two apart: a cancellation is the user's own
		// decision and must not raise an error toast.
		const pending = pull("hangs");
		await waitForSpawns(1);

		await expect(
			invoke(IPC_CHANNELS.OLLAMA_CANCEL_PULL, "hangs"),
		).resolves.toMatchObject({ success: true, data: { cancelled: true } });

		await expect(pending).resolves.toMatchObject({
			success: false,
			error: "PULL_CANCELLED",
		});
	});

	it("reports nothing to cancel for a model that is not downloading", async () => {
		await expect(
			invoke(IPC_CHANNELS.OLLAMA_CANCEL_PULL, "llama3.3"),
		).resolves.toMatchObject({ success: true, data: { cancelled: false } });
	});

	it("lists a pull that is still running", async () => {
		// A download outlives the view that started it, so a view mounting later
		// asks for this instead of showing the model as "to download".
		const pending = pull("hangs");
		await waitForSpawns(1);

		expect((await activePulls()).data.models).toContain("hangs");

		await invoke(IPC_CHANNELS.OLLAMA_CANCEL_PULL, "hangs");
		await pending;
	});

	it("frees the model's slot once a pull settles", async () => {
		// An entry nobody removes silently blocks every later retry of that
		// model — the failure mode would be a Download button that does nothing.
		await pull("llama3.3");
		expect((await activePulls()).data.models).not.toContain("llama3.3");

		await pull("llama3.3");
		expect(spawnCount()).toBe(2);
	});

	it("refuses an empty model name without spawning anything", async () => {
		await expect(pull("  ")).resolves.toMatchObject({ success: false });
		expect(spawnCount()).toBe(0);
	});

	it("broadcasts progress to every open window", async () => {
		// Only the window that invoked the pull holds its promise; every other
		// view tracks the same download through these events.
		const win = new BrowserWindow();
		// The shared electron mock's stub functions do not record their calls,
		// so this one is replaced with a spy rather than changing that mock's
		// semantics for every other suite that uses it.
		const send = vi.fn();
		win.webContents.send = send;
		MockBrowserWindow.openWindows.push(win);

		await pull("llama3.3");

		const sent = send.mock.calls
			.filter(([channel]) => channel === IPC_CHANNELS.OLLAMA_PULL_PROGRESS)
			.map(([, payload]) => payload as Record<string, unknown>);

		expect(sent).toContainEqual(
			expect.objectContaining({ modelName: "llama3.3", percentage: 50 }),
		);
		// …and a terminal event, so a window that did not start the download
		// stops spinning on one that has finished.
		expect(sent).toContainEqual(
			expect.objectContaining({ modelName: "llama3.3", status: "completed" }),
		);
	});
});
