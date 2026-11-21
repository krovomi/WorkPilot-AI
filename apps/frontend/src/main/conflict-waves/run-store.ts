/**
 * The "Execute in optimal order" run, kept in the project so that it survives
 * a restart (#358, lot 2): `<project>/.workpilot/execution-waves-run.json`.
 *
 * The renderer sends the state it runs; it is validated here field by field
 * (shape, bounds, closed lists) before it is written, and again, with the
 * project's tasks, when it is read back. The project root is resolved, the
 * `.workpilot` folder and the file may not be links, the folder must resolve
 * to the root's own `.workpilot`, and the write goes through a fresh temporary
 * file renamed over the target. A file that is missing, linked, oversized,
 * unreadable or incoherent gives no run: it is ignored, never half-used.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	SavedWaveRun,
	SavedWaveRunResult,
	WaveRunState,
} from "../../shared/types/conflict-waves";
import { MAX_PARALLEL_CEILING, MAX_PLAN_TASKS, PROJECT_ID, TASK_ID } from "./plan-service";

export const RUN_FILE = "execution-waves-run.json";
const RUN_VERSION = 1;
const MAX_RUN_BYTES = 256 * 1024;
const ADVANCE = new Set(["merged", "review"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskIdList(value: unknown, max: number): string[] | null {
	if (!Array.isArray(value) || value.length > max) return null;
	if (!value.every((id): id is string => typeof id === "string" && TASK_ID.test(id))) return null;
	return value;
}

/**
 * A run state, or null. Coherent: at least one wave, no empty wave, no task
 * twice, `current` within the waves (equal to their count once the last one
 * settled), every started task in a wave.
 */
export function validateRunState(raw: unknown, projectId: string): WaveRunState | null {
	if (!isRecord(raw) || raw.projectId !== projectId || !PROJECT_ID.test(projectId)) return null;
	const { waves, current, advanceWhen, maxParallel, started } = raw;
	if (!Array.isArray(waves) || waves.length === 0 || waves.length > MAX_PLAN_TASKS) return null;
	const lists = waves.map((wave) => taskIdList(wave, MAX_PLAN_TASKS));
	if (lists.some((wave) => wave === null || wave.length === 0)) return null;
	const all = (lists as string[][]).flat();
	if (all.length > MAX_PLAN_TASKS || new Set(all).size !== all.length) return null;
	if (!Number.isInteger(current) || (current as number) < 0 || (current as number) > waves.length) {
		return null;
	}
	if (typeof advanceWhen !== "string" || !ADVANCE.has(advanceWhen)) return null;
	if (
		!Number.isInteger(maxParallel) ||
		(maxParallel as number) < 1 ||
		(maxParallel as number) > MAX_PARALLEL_CEILING
	) {
		return null;
	}
	const startedIds = taskIdList(started, all.length);
	const members = new Set(all);
	if (!startedIds || new Set(startedIds).size !== startedIds.length) return null;
	if (!startedIds.every((id) => members.has(id))) return null;
	return {
		projectId,
		waves: lists as string[][],
		current: current as number,
		advanceWhen: advanceWhen as WaveRunState["advanceWhen"],
		maxParallel: maxParallel as number,
		started: [...startedIds],
	};
}

/**
 * The project's own `.workpilot` folder, resolved: refused when it is a link
 * or not a folder, or when it does not resolve inside the project root.
 * Created when `create` is set and it does not exist; null otherwise.
 */
function workpilotDir(projectPath: string, create: boolean): string | null {
	const root = fs.realpathSync(projectPath);
	const dir = path.join(root, ".workpilot");
	let stat: fs.Stats | null = null;
	try {
		stat = fs.lstatSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!stat) {
		if (!create) return null;
		fs.mkdirSync(dir);
	} else if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error("Refusing a linked or non-folder .workpilot");
	}
	if (path.relative(root, fs.realpathSync(dir)) !== ".workpilot") {
		throw new Error("Refusing a .workpilot outside the project");
	}
	return dir;
}

/**
 * The run file's text; throws otherwise. A link is refused, and the file
 * opened must be the one checked (same device and inode), so a file swapped
 * in between the two is never read. Read up to one byte past the limit.
 */
function readBounded(file: string): string {
	let fd: number | null = null;
	try {
		const before = fs.lstatSync(file);
		if (before.isSymbolicLink()) throw new Error("linked run file");
		fd = fs.openSync(file, "r");
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
			throw new Error("not the file checked");
		}
		const buffer = Buffer.alloc(MAX_RUN_BYTES + 1);
		let length = 0;
		let read: number;
		do {
			read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			length += read;
		} while (read > 0 && length < buffer.length);
		if (length > MAX_RUN_BYTES) throw new Error("oversized run file");
		return buffer.subarray(0, length).toString("utf-8");
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

/**
 * The run saved in a project, checked against its tasks: a run naming a task
 * the project no longer has is incoherent and ignored.
 */
export function readSavedRun(
	projectPath: string,
	projectId: string,
	knownTaskIds: ReadonlySet<string>,
): SavedWaveRunResult {
	const none: SavedWaveRunResult = { run: null, ignored: false };
	let text: string;
	try {
		const dir = workpilotDir(projectPath, false);
		if (!dir) return none;
		text = readBounded(path.join(dir, RUN_FILE));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return none;
		return { run: null, ignored: true };
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== RUN_VERSION) throw new Error("version");
		const savedAt = raw.savedAt;
		if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) throw new Error("date");
		const state = validateRunState(raw, projectId);
		if (!state?.waves.flat().every((id) => knownTaskIds.has(id))) {
			throw new Error("incoherent");
		}
		const run: SavedWaveRun = { ...state, savedAt: new Date(savedAt).toISOString() };
		return { run, ignored: false };
	} catch {
		return { run: null, ignored: true };
	}
}

function isLink(file: string): boolean {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Writes a validated state atomically; throws when the folder or file is refused. */
export function writeSavedRun(projectPath: string, state: WaveRunState, now: Date): void {
	const dir = workpilotDir(projectPath, true) as string;
	const target = path.join(dir, RUN_FILE);
	if (isLink(target)) throw new Error("Refusing a linked run file");
	const body = JSON.stringify({ version: RUN_VERSION, ...state, savedAt: now.toISOString() });
	// A fresh name, created exclusively: never a file or link already there.
	const temp = path.join(dir, `.${RUN_FILE}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temp, body, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		fs.renameSync(temp, target);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

/** Forgets the saved run (finished, stopped or abandoned). */
export function clearSavedRun(projectPath: string): void {
	const dir = workpilotDir(projectPath, false);
	if (!dir) return;
	// Removing a link removes the link itself, never what it points to.
	fs.rmSync(path.join(dir, RUN_FILE), { force: true });
}
