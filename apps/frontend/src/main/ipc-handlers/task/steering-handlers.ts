/**
 * Send a message to a running task, and read its queue with the deliveries
 * (`apps/backend/foundation/steering.py`).
 *
 * A local task's message is appended to `steering.jsonl` in every copy of its
 * spec directory (the project's and the worktree's): the build reads the
 * worktree's, a resume copies the project's over it. Lines are appended,
 * never rewritten, because the backend marks deliveries in the same file. A
 * server card is sent to the server (`/api/board/cards/{id}/steering`).
 *
 * Arguments come from the renderer and are checked again here (rule S6).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { SteeringMessage } from "../../../shared/types/steering";
import {
	MAX_STEERING_CHARS,
	STEERING_FILE,
	SUBTASK_ID,
	cleanSteeringText,
	messageLine,
	parseSteering,
} from "../../../shared/utils/steering";
import { appLog } from "../../app-logger";
import { type ServerCard, findServerCard } from "../../server-board-actions";
import { authedFetch } from "../../server-connection";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

const TASK_ID_MAX = 300;
type SteeringResult = IPCResult<SteeringMessage[]>;

function refused(code: string): SteeringResult {
	return { success: false, error: code };
}

function serverUrl(card: ServerCard): string {
	return `/api/board/cards/${encodeURIComponent(card.cardId)}/steering?project_id=${encodeURIComponent(card.project.id)}`;
}

function read(file: string): string {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return ""; // no message yet in this copy
	}
}

function localDirs(taskId: string): string[] | null {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return null;
	return allSpecDirs(getSpecPaths(task, project));
}

export async function listSteering(taskId: unknown): Promise<SteeringResult> {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) {
		return refused("task_not_found");
	}
	const card = findServerCard(taskId);
	if (card) {
		const got = await authedFetch<{ messages?: SteeringMessage[] }>(serverUrl(card), "GET");
		return got.ok
			? { success: true, data: got.data?.messages ?? [] }
			: { success: false, error: got.error };
	}
	const dirs = localDirs(taskId);
	if (!dirs) return refused("task_not_found");
	return {
		success: true,
		data: parseSteering(dirs.map((dir) => read(path.join(dir, STEERING_FILE)))),
	};
}

export async function sendSteering(
	taskId: unknown,
	text: unknown,
	targetSubtaskId: unknown,
): Promise<SteeringResult> {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) {
		return refused("task_not_found");
	}
	if (typeof text !== "string") return refused("empty_message");
	if (text.length > MAX_STEERING_CHARS * 2) return refused("message_too_long");
	const cleaned = cleanSteeringText(text);
	if (!cleaned) return refused("empty_message");
	let target: string | null = null;
	if (targetSubtaskId !== undefined && targetSubtaskId !== null && targetSubtaskId !== "") {
		if (typeof targetSubtaskId !== "string" || !SUBTASK_ID.test(targetSubtaskId)) {
			return refused("invalid_subtask");
		}
		target = targetSubtaskId;
	}

	const card = findServerCard(taskId);
	if (card) {
		const sent = await authedFetch<{ messages?: SteeringMessage[] }>(serverUrl(card), "POST", {
			text: cleaned,
			target_subtask_id: target,
		});
		return sent.ok
			? { success: true, data: sent.data?.messages ?? [] }
			: { success: false, error: sent.error };
	}

	const dirs = localDirs(taskId);
	if (!dirs || dirs.length === 0) return refused("task_not_found");
	const line = messageLine(
		randomUUID().replaceAll("-", ""),
		cleaned,
		new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
		"desktop",
		target,
	);
	let written = 0;
	for (const dir of dirs) {
		try {
			appendFileSync(path.join(dir, STEERING_FILE), line, { encoding: "utf-8", mode: 0o600 });
			written += 1;
		} catch (error) {
			appLog.warn(
				`[STEERING] Could not write ${dir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (written === 0) return refused("queue_unwritable");
	appLog.info(`[STEERING] ${taskId}: message queued${target ? ` for ${target}` : ""}`);
	return listSteering(taskId);
}

export function registerSteeringHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TASK_STEERING_LIST, (_, taskId: unknown) => listSteering(taskId));
	ipcMain.handle(
		IPC_CHANNELS.TASK_STEERING_SEND,
		(_, taskId: unknown, text: unknown, targetSubtaskId: unknown) =>
			sendSteering(taskId, text, targetSubtaskId),
	);
}
