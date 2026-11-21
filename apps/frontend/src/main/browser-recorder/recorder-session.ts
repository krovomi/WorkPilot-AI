/**
 * One recording at a time: the recorder runner, its steps, its events (#387).
 *
 * `browser_recorder_runner.py record` opens the page in a browser window the
 * person drives and prints each step it records. The main keeps those steps
 * (read through `parseRecordedStep`, at most `MAX_RECORDED_STEPS`), so an
 * export later sends the runner only steps it made itself: the renderer only
 * picks which ones to keep, by id. A check the recorder proposes after an
 * action (a step with `after`) is kept apart, at most `MAX_SUGGESTIONS`, and
 * is exported only when the renderer names it. A dialog the page opens
 * (`RECORDER_DIALOG:`) waits for the person's answer in the app, which goes
 * back to the runner on its stdin, for that dialog's id only. The runner gets the static environment
 * (no provider, no key, no Claude profile, S1): it calls no model, and the
 * page it opens is someone else's code.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	MAX_RECORDED_STEPS,
	MAX_SUGGESTIONS,
	parsePendingDialog,
	parseRecordedStep,
	readDialogAnswer,
	type RecordedStep,
	type RecorderEvent,
} from "../../shared/types/browser-recorder";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonStaticRunnerEnv } from "../utils/python-runner-env";
import { decodeRunnerError } from "../utils/runner-error";

export const STEP_PREFIX = "RECORDER_STEP:";
export const DONE_PREFIX = "RECORDER_DONE:";
export const EXPORT_PREFIX = "RECORDER_EXPORT:";
export const ERROR_PREFIX = "RECORDER_ERROR:";
export const DIALOG_PREFIX = "RECORDER_DIALOG:";
const MAX_URL = 2048;

export type SpawnRunner = (args: string[]) => Promise<ChildProcess>;

export interface RecorderDeps {
	readonly spawnRunner: SpawnRunner;
	readonly broadcast: (event: RecorderEvent) => void;
}

/** The backend folder, where the runners live. */
export async function backendPath(): Promise<string> {
	const { app } = await import("electron");
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** Starts `browser_recorder_runner.py` with `args`, without a shell or credentials. */
export const spawnRecorderRunner: SpawnRunner = async (args) => {
	const backend = await backendPath();
	const runner = path.resolve(backend, "runners", "browser_recorder_runner.py");
	const python = await requirePythonPath();
	return spawn(python, [runner, ...args], { cwd: backend, env: pythonStaticRunnerEnv(backend) });
};

/** Sends a recorder event to every window. */
export function broadcastRecorderEvent(event: RecorderEvent): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_CHANNELS.BROWSER_AGENT_RECORD_EVENT, event);
	}
}

const defaultDeps: RecorderDeps = { spawnRunner: spawnRecorderRunner, broadcast: broadcastRecorderEvent };

interface Session {
	projectPath: string;
	steps: RecordedStep[];
	suggestions: RecordedStep[];
	child: ChildProcess | null;
	/** The id of the dialog waiting for an answer. */
	dialog: number | null;
}

let session: Session | null = null;

/** An absolute http(s) address, the only kind recorded. */
export function readRecordUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > MAX_URL) return null;
	try {
		const url = new URL(raw.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Adds or replaces (same id) a step of the session; false past `cap`. */
function upsert(steps: RecordedStep[], step: RecordedStep, cap: number): boolean {
	const index = steps.findIndex((s) => s.id === step.id);
	if (index >= 0) {
		steps[index] = step;
		return true;
	}
	if (steps.length >= cap) return false;
	steps.push(step);
	return true;
}

/** Calls `onLine` for each complete line `child` prints. */
export function readLines(child: ChildProcess, onLine: (line: string) => void): void {
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
			newline = buffer.indexOf("\n");
		}
	});
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export async function startRecording(
	projectPath: unknown,
	rawUrl: unknown,
	deps: RecorderDeps = defaultDeps,
): Promise<{ success: boolean; error?: string }> {
	if (typeof projectPath !== "string" || !projectPath) return { success: false, error: "No project" };
	const url = readRecordUrl(rawUrl);
	if (!url) return { success: false, error: "Only an http:// or https:// address can be recorded." };
	if (session?.child) return { success: false, error: "A recording is already running." };

	const current: Session = { projectPath, steps: [], suggestions: [], child: null, dialog: null };
	session = current;
	let child: ChildProcess;
	try {
		child = await deps.spawnRunner(["record", `--url=${url}`, `--project=${projectPath}`]);
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
	current.child = child;
	let ended = false;
	readLines(child, (line) => {
		if (line.startsWith(STEP_PREFIX)) {
			const step = parseRecordedStep(parseJson(line.slice(STEP_PREFIX.length)));
			const kept = step?.after
				? upsert(current.suggestions, step, MAX_SUGGESTIONS)
				: step && upsert(current.steps, step, MAX_RECORDED_STEPS);
			if (step && kept) deps.broadcast({ type: "step", step });
		} else if (line.startsWith(DIALOG_PREFIX)) {
			const dialog = parsePendingDialog(parseJson(line.slice(DIALOG_PREFIX.length)));
			if (!dialog) return;
			current.dialog = dialog.id;
			deps.broadcast({ type: "dialog", dialog });
		} else if (line.startsWith(DONE_PREFIX)) {
			const done = (parseJson(line.slice(DONE_PREFIX.length)) ?? {}) as Record<string, unknown>;
			ended = true;
			deps.broadcast({
				type: "stopped",
				reason: done.reason === "closed" ? "closed" : "stopped",
				truncated: done.truncated === true,
			});
		} else if (line.startsWith(ERROR_PREFIX)) {
			ended = true;
			deps.broadcast({ type: "error", message: decodeRunnerError(line.slice(ERROR_PREFIX.length)) });
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => console.error("[BrowserRecorder]", chunk.toString()));
	const finish = (message: string) => {
		current.child = null;
		if (!ended) deps.broadcast({ type: "error", message });
		ended = true;
	};
	child.on("error", (error) => finish(error.message));
	child.on("close", (code) => finish(`The recorder stopped (exit code ${code}).`));
	deps.broadcast({ type: "started", url });
	return { success: true };
}

/** Asks the running recorder to stop; it closes its window and reports. */
export function stopRecording(): { success: boolean } {
	const child = session?.child;
	if (!child?.stdin || child.stdin.destroyed) return { success: false };
	child.stdin.write("stop\n");
	return { success: true };
}

/** Sends the person's answer to the dialog the running recorder is waiting on (S6: read again here). */
export function answerDialog(raw: unknown): { success: boolean } {
	const answer = readDialogAnswer(raw);
	const child = session?.child;
	if (!answer || !session || session.dialog !== answer.id || !child?.stdin || child.stdin.destroyed) {
		return { success: false };
	}
	session.dialog = null;
	child.stdin.write(`dialog ${JSON.stringify(answer)}\n`);
	return { success: true };
}

/** The steps (and kept checks) of `projectPath`'s last recording whose ids are in `ids`, in that order. */
export function recordedSteps(projectPath: string, ids: readonly string[]): RecordedStep[] {
	if (!session || session.projectPath !== projectPath) return [];
	const byId = new Map([...session.steps, ...session.suggestions].map((step) => [step.id, step]));
	return ids.map((id) => byId.get(id)).filter((step): step is RecordedStep => step !== undefined);
}

/** The steps of `projectPath`'s last recording, in order, once it has stopped (not its proposed checks). */
export function sessionSteps(projectPath: string): RecordedStep[] {
	if (!session || session.projectPath !== projectPath || session.child) return [];
	return [...session.steps];
}

/** Gives a step of the stopped recording new selectors: the step updated, or null. */
export function updateStepSelectors(
	projectPath: string,
	id: string,
	selectors: RecordedStep["selectors"],
): RecordedStep | null {
	if (!session || session.projectPath !== projectPath || session.child) return null;
	const index = session.steps.findIndex((step) => step.id === id);
	if (index < 0) return null;
	const step = { ...session.steps[index], selectors };
	session.steps[index] = step;
	return step;
}

/** For tests: forget the session. */
export function resetRecorderSessionForTests(): void {
	session = null;
}
