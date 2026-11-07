/**
 * Goal mode IPC: read and write a task's goal.
 *
 * The goal is the task's definition of done: a command, the exit code that
 * means "done", a number of QA passes and a spending cap
 * (docs/architecture/goal-mode.md). It lives in `<spec>/.workpilot-goal.json`,
 * not in task_metadata.json, because agents may write the metadata and none
 * may write this file (`security/path_guard.py`). Only this handler writes it,
 * in every copy of the spec directory: the backend reads the main copy
 * first, and a worktree build falls back to its own.
 *
 * A server card's goal goes to the server (`server-card-settings.ts`), which
 * writes it where its build reads it.
 *
 * The renderer names a task and sends a goal; the goal is validated here with
 * the backend's rules (`goal/spec.py`), and the backend validates it again.
 *
 * Channels:
 *   invoke TASK_GOAL_GET (taskId)              → IPCResult<TaskGoalState>
 *   invoke TASK_GOAL_SET (taskId, goal | null) → IPCResult<TaskGoalState>
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, TaskGoal, TaskGoalState } from "../../../shared/types";
import { appLog } from "../../app-logger";
import { findServerCard } from "../../server-board-actions";
import { getServerCardGoal, setServerCardGoal } from "../../server-card-settings";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

export const GOAL_FILE = ".workpilot-goal.json";

const MAX_COMMAND_CHARS = 4096;
const MAX_PROTECTED = 64;
const MAX_PATTERN_CHARS = 512;

type Sanitized = { goal: TaskGoal; error?: undefined } | { goal?: undefined; error: string };

function wholeNumber(value: unknown, name: string, low: number, high: number): number | string {
	if (typeof value !== "number" || !Number.isInteger(value)) return `${name} must be a whole number`;
	if (value < low || value > high) return `${name} must be between ${low} and ${high}`;
	return value;
}

/** A goal from the renderer, reduced to what `goal/spec.py` accepts. */
export function sanitizeGoal(raw: unknown): Sanitized {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "The goal must be an object" };
	}
	const input = raw as Record<string, unknown>;
	const command = typeof input.command === "string" ? input.command.trim() : "";
	if (!command) return { error: "The goal needs a command" };
	if (command.length > MAX_COMMAND_CHARS || /[\0\r\n]/.test(command)) {
		return { error: "The command must be one line" };
	}
	const goal: TaskGoal = { command };

	const numbers: [keyof TaskGoal, number, number][] = [
		["expectedExit", 0, 255],
		["timeoutSeconds", 10, 7200],
		["maxRounds", 1, 50],
	];
	for (const [key, low, high] of numbers) {
		if (input[key] === undefined || input[key] === null) continue;
		const value = wholeNumber(input[key], key, low, high);
		if (typeof value === "string") return { error: value };
		(goal as unknown as Record<string, number>)[key] = value;
	}

	if (input.maxCostUsd !== undefined && input.maxCostUsd !== null) {
		const cost = input.maxCostUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0 || cost > 10_000) {
			return { error: "maxCostUsd must be above 0 and at most 10000" };
		}
		goal.maxCostUsd = cost;
	}

	if (input.protected !== undefined && input.protected !== null) {
		if (!Array.isArray(input.protected) || input.protected.length > MAX_PROTECTED) {
			return { error: `protected must be a list of at most ${MAX_PROTECTED} paths` };
		}
		const patterns: string[] = [];
		for (const entry of input.protected) {
			if (typeof entry !== "string" || !entry.trim()) {
				return { error: "A protected path must be a non-empty string" };
			}
			const pattern = entry.trim().replaceAll("\\", "/");
			if (pattern.length > MAX_PATTERN_CHARS || pattern.includes("\0")) {
				return { error: "A protected path is too long" };
			}
			if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) {
				return { error: `Protected path "${entry}" must be relative to the repository` };
			}
			if (pattern.split("/").includes("..")) {
				return { error: `Protected path "${entry}" may not contain ".."` };
			}
			if (!patterns.includes(pattern)) patterns.push(pattern);
		}
		if (patterns.length > 0) goal.protected = patterns;
	}
	return { goal };
}

/** The goal in the first directory that has one. */
export function readGoal(specDirs: string[]): TaskGoalState {
	for (const dir of specDirs) {
		const file = path.join(dir, GOAL_FILE);
		if (!existsSync(file)) continue;
		try {
			const result = sanitizeGoal(JSON.parse(readFileSync(file, "utf-8")));
			return result.goal ? { goal: result.goal } : { goal: null, error: result.error };
		} catch (error) {
			return { goal: null, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { goal: null };
}

/**
 * Write (or, for null, remove) the goal in every directory. Write-then-rename:
 * the backend never reads half a file, and a symbolic link planted at the
 * name is replaced, not followed.
 */
export function writeGoal(specDirs: string[], goal: TaskGoal | null): string[] {
	const failed: string[] = [];
	for (const dir of specDirs) {
		const file = path.join(dir, GOAL_FILE);
		try {
			if (goal === null) {
				if (existsSync(file)) unlinkSync(file);
				continue;
			}
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(goal, null, 2), "utf-8");
			renameSync(temp, file);
		} catch (error) {
			appLog.warn(`[TASK_GOAL_SET] Could not update ${dir}:`, error);
			failed.push(dir);
		}
	}
	return failed;
}

/** Main copy first: that is the one the backend reads first. */
function goalDirs(taskId: string): string[] | null {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return null;
	const paths = getSpecPaths(task, project);
	const dirs = allSpecDirs(paths);
	const main = dirs.filter((dir) => dir === paths.mainSpecDir);
	return [...main, ...dirs.filter((dir) => dir !== paths.mainSpecDir)];
}

export function registerGoalHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.TASK_GOAL_GET,
		async (_, taskId: unknown): Promise<IPCResult<TaskGoalState>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			// A server card's goal is the server's file: the mirror here is never read.
			const serverCard = findServerCard(taskId);
			if (serverCard) return getServerCardGoal(serverCard);
			const dirs = goalDirs(taskId);
			if (!dirs) return { success: false, error: "Task not found" };
			return { success: true, data: readGoal(dirs) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_GOAL_SET,
		async (_, taskId: unknown, raw: unknown): Promise<IPCResult<TaskGoalState>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			let goal: TaskGoal | null = null;
			if (raw !== null) {
				const result = sanitizeGoal(raw);
				if (!result.goal) return { success: false, error: result.error };
				goal = result.goal;
			}
			const serverCard = findServerCard(taskId);
			if (serverCard) return setServerCardGoal(serverCard, goal);
			const dirs = goalDirs(taskId);
			if (!dirs) return { success: false, error: "Task not found" };
			if (dirs.length === 0) return { success: false, error: "The task has no spec directory" };
			const failed = writeGoal(dirs, goal);
			if (failed.length > 0) {
				// A copy left with the old goal would be read by a worktree build.
				return { success: false, error: `Could not update the goal in ${failed.join(", ")}` };
			}
			appLog.info(`[TASK_GOAL_SET] task=${taskId} goal=${goal ? "set" : "removed"} dirs=${dirs.length}`);
			return { success: true, data: { goal } };
		},
	);
}
