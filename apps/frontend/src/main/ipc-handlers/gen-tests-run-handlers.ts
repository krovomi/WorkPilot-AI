/**
 * Generational tests: run the project's own suite, or import a report file.
 *
 * Pasting a report covers every stack, but few people have one at hand. The
 * runner (`runners/generational_tests_runner.py`) runs the suite once with
 * the flag that makes the stack write a report (TRX for .NET, JUnit or the
 * runner's JSON elsewhere) and stores it as a generation, or diffs it against
 * a baseline. The renderer names a detected command by its id, never a
 * command line (docs/rules/security.md, S6).
 *
 * Channels:
 *   invoke "genTests:detect"     → { projectPath } → { success, commands }
 *   invoke "genTests:run"        → GenRunRequest → capture or compare result
 *   invoke "genTests:cancel"     → void
 *   invoke "genTests:importFile" → the text of a report file the person picks
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { FLAKY_COMMAND_IDS, type FlakyCommandId } from "../../shared/types/flaky-tests";
import { showOpenDialog } from "../electron-utils";
import { isWindows } from "../platform";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const RESULT_PREFIX = "GEN_RESULT:";
const ERROR_PREFIX = "GEN_ERROR:";
const DETECT_TIMEOUT_MS = 30_000;
/** The runner stops the suite after 30 minutes; this is its margin. */
const RUN_TIMEOUT_MS = 32 * 60_000;
/** The same label rule as the archive (`generational_tests/archive.py`). */
export const GEN_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The archive refuses a larger report (`reports.MAX_REPORT_CHARS`). */
export const GEN_REPORT_MAX_BYTES = 5_000_000;

export interface GenRunRequest {
	projectPath: string;
	mode: "capture" | "compare";
	/** The new generation's label (capture) or the baseline's (compare). */
	label: string;
	commandId: FlakyCommandId | "auto";
}

export type GenRunnerResult =
	| ({ success: true } & Record<string, unknown>)
	| { success: false; error: string };

/** What the renderer sent, checked: a known mode, a valid label, a detected command's id. */
export function checkGenRunRequest(raw: unknown): GenRunRequest {
	const req = (raw ?? {}) as Record<string, unknown>;
	const { projectPath, mode, label } = req;
	if (typeof projectPath !== "string" || !projectPath) throw new Error("projectPath is required");
	if (mode !== "capture" && mode !== "compare") throw new Error("mode must be capture or compare");
	if (typeof label !== "string" || !GEN_LABEL_RE.test(label)) throw new Error("invalid label");
	const commandId = req.commandId ?? "auto";
	if (commandId !== "auto" && !(FLAKY_COMMAND_IDS as readonly unknown[]).includes(commandId)) {
		throw new Error("unknown test command");
	}
	return { projectPath, mode, label, commandId: commandId as FlakyCommandId | "auto" };
}

/** The runner's arguments after its path. */
export function genRunnerArgs(req: GenRunRequest): string[] {
	return [
		"--project-path",
		req.projectPath,
		"--mode",
		req.mode,
		req.mode === "capture" ? "--label" : "--baseline",
		req.label,
		"--command-id",
		req.commandId,
	];
}

/** The runner's answer, read from everything it printed. */
export function readGenRunnerOutput(stdout: string, exitCode: number | null): GenRunnerResult {
	const lines = stdout.split(/\r?\n/).reverse();
	const error = lines.find((line) => line.startsWith(ERROR_PREFIX));
	if (error) {
		try {
			const decoded: unknown = JSON.parse(error.slice(ERROR_PREFIX.length));
			if (typeof decoded === "string") return { success: false, error: decoded };
		} catch {
			/* fall through to the generic error */
		}
	}
	const result = lines.find((line) => line.startsWith(RESULT_PREFIX));
	if (result && exitCode === 0) {
		try {
			const payload: unknown = JSON.parse(result.slice(RESULT_PREFIX.length));
			if (payload && typeof payload === "object") {
				return { success: true, ...(payload as Record<string, unknown>) };
			}
		} catch {
			/* fall through */
		}
	}
	return { success: false, error: `runner_failed: exit code ${exitCode}` };
}

/** The runner and what it started (dotnet's test host, node workers). */
function killTree(child: ChildProcess): void {
	if (isWindows() && child.pid) {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
			/* already gone */
		});
		return;
	}
	// The runner stops the suite it started on SIGTERM.
	child.kill("SIGTERM");
}

async function spawnRunner(args: string[]): Promise<ChildProcess> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "generational_tests_runner.py");
	const pythonExe = await requirePythonPath();
	return spawn(pythonExe, [runnerPath, ...args], {
		cwd: backendPath,
		env: await pythonRunnerEnv(backendPath),
	} as Parameters<typeof spawn>[2]);
}

function collect(child: ChildProcess, timeoutMs: number): Promise<GenRunnerResult> {
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[GenTests] stderr:", chunk.toString());
	});
	return new Promise((resolve) => {
		const timer = setTimeout(() => killTree(child), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(readGenRunnerOutput(stdout, code));
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ success: false, error: `start_failed: ${err.message}` });
		});
	});
}

/** Reads through one handle, so the file checked is the file read; never more than the cap. */
export async function readReportFile(file: string): Promise<string | null> {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > GEN_REPORT_MAX_BYTES) return null;
		const buffer = Buffer.alloc(GEN_REPORT_MAX_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		return total > GEN_REPORT_MAX_BYTES ? null : buffer.toString("utf-8", 0, total);
	} finally {
		await handle.close();
	}
}

export function registerGenTestsRunHandlers(): void {
	let current: ChildProcess | null = null;

	ipcMain.handle(IPC_CHANNELS.GEN_TESTS_DETECT, async (_e, raw: unknown) => {
		const projectPath = (raw as { projectPath?: unknown } | null)?.projectPath;
		if (typeof projectPath !== "string" || !projectPath) {
			return { success: false, error: "projectPath is required" };
		}
		const child = await spawnRunner(["--project-path", projectPath, "--mode", "detect"]);
		return collect(child, DETECT_TIMEOUT_MS);
	});

	ipcMain.handle(IPC_CHANNELS.GEN_TESTS_RUN, async (_e, raw: unknown) => {
		let req: GenRunRequest;
		try {
			req = checkGenRunRequest(raw);
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
		if (current) return { success: false, error: "busy" };
		const child = await spawnRunner(genRunnerArgs(req));
		current = child;
		try {
			return await collect(child, RUN_TIMEOUT_MS);
		} finally {
			if (current === child) current = null;
		}
	});

	ipcMain.handle(IPC_CHANNELS.GEN_TESTS_CANCEL, () => {
		if (current) killTree(current);
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.GEN_TESTS_IMPORT_FILE, async () => {
		const { canceled, filePaths } = await showOpenDialog({
			properties: ["openFile"],
			filters: [
				{ name: "Test report", extensions: ["xml", "trx", "json", "jsonl", "log", "txt"] },
				{ name: "*", extensions: ["*"] },
			],
		});
		const file = filePaths?.[0];
		if (canceled || !file) return { success: false, error: "cancelled" };
		try {
			const content = await readReportFile(file);
			if (content === null) return { success: false, error: "report.too_large" };
			return { success: true, name: path.basename(file), content };
		} catch {
			return { success: false, error: "report.unreadable" };
		}
	});
}
