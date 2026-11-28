/**
 * Server mode: the runs the team server stopped (restarted) while they were
 * queued or running, offered in the same launch dialog as the builds this
 * computer interrupted (interrupted-prompt.ts).
 *
 * The server settles them as `interrupted` and lists those the signed-in
 * person started, and every one of a project they own
 * (`GET /users/me/interrupted-runs`, server/services/interrupted_runs.py).
 * Resuming one is the server's own route, with the permission starting a run
 * takes; « Plus tard » tells the server, so the phone does not ask again
 * either. Nothing runs on this computer.
 *
 * The answer is the server's, read as untrusted data: every field is checked
 * and bounded, and an id becomes a task id only through `serverTaskId`, whose
 * pattern the task handlers already check.
 */
import { appLog } from "../../app-logger";
import { parseServerTaskId, serverTaskId } from "../../remote-board";
import { authedFetch, getAccessToken, isServerMode } from "../../server-connection";
import type {
	InterruptedPhase,
	InterruptedResumeResult,
	InterruptedTask,
} from "../../../shared/types/interrupted-tasks";

const LIST = "/users/me/interrupted-runs";
const MAX_RUNS = 200;
const MAX_TEXT = 300;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const PHASES: ReadonlySet<string> = new Set(["spec", "planning", "coding", "qa_review"]);

/** Where each offered server task's run lives, by task id. */
const runs = new Map<string, { projectId: string; specId: string; runId: string }>();

function text(value: unknown, limit = MAX_TEXT): string | null {
	if (typeof value !== "string") return null;
	const clean = Array.from(value, (ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 127 ? " " : ch;
	})
		.join("")
		.trim();
	if (!clean) return null;
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 10_000
		? value
		: 0;
}

function isoTime(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** One row of the server's answer as a dialog row, or null when it is not one. */
export function toInterruptedTask(raw: unknown): InterruptedTask | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const { run_id: runId, spec_id: specId, project_id: projectId, card_id: cardId } = row;
	if (
		typeof runId !== "string" ||
		!ID.test(runId) ||
		typeof specId !== "string" ||
		!ID.test(specId) ||
		typeof projectId !== "string" ||
		typeof cardId !== "string"
	) {
		return null;
	}
	const taskId = serverTaskId(projectId, cardId);
	if (!parseServerTaskId(taskId)) return null;
	const phase = typeof row.phase === "string" && PHASES.has(row.phase) ? row.phase : "coding";
	const mine = row.mine === true;
	const blocker = row.blocker === "spec_missing" ? "spec_missing" : null;
	runs.set(taskId, { projectId, specId, runId });
	return {
		taskId,
		projectId,
		projectName: text(row.project_name, 120) ?? projectId,
		title: text(row.title, 200) ?? cardId,
		origin: "server_restart",
		interruptedAt: isoTime(row.interrupted_at),
		phase: phase as InterruptedPhase,
		subtasksDone: count(row.subtasks_done),
		subtasksTotal: count(row.subtasks_total),
		nextSubtask: phase === "coding" ? text(row.next_subtask) : null,
		provider: null,
		model: text(row.model, 120),
		blocker,
		// A teammate's run is listed for its project's owner, never ticked for them.
		selectedByDefault: mine && blocker === null,
		onServer: true,
		startedByName: mine ? null : text(row.started_by_name, 120),
	};
}

/** The server's interrupted runs offered to the signed-in person; none in local mode. */
export async function collectServerInterruptedTasks(): Promise<InterruptedTask[]> {
	if (!isServerMode() || !getAccessToken()) return [];
	const answer = await authedFetch<{ runs?: unknown }>(LIST, "GET");
	if (!answer.ok) {
		appLog.warn(`[interrupted-server] Could not list interrupted runs: ${answer.error}`);
		return [];
	}
	const rows = Array.isArray(answer.data?.runs) ? answer.data.runs.slice(0, MAX_RUNS) : [];
	return rows.map(toInterruptedTask).filter((task): task is InterruptedTask => task !== null);
}

export function isServerInterruptedTask(taskId: string): boolean {
	return runs.has(taskId);
}

/** Resume these runs on the server; each one the server refuses says why. */
export async function resumeServerInterrupted(
	taskIds: string[],
): Promise<InterruptedResumeResult> {
	const result: InterruptedResumeResult = { resumed: [], waiting: [], failed: [] };
	for (const taskId of taskIds) {
		const run = runs.get(taskId);
		if (!run) {
			result.failed.push({ taskId, error: "Not offered" });
			continue;
		}
		const answer = await authedFetch(
			`/projects/${encodeURIComponent(run.projectId)}/specs/${encodeURIComponent(run.specId)}/runs/${encodeURIComponent(run.runId)}/resume`,
			"POST",
		);
		if (answer.ok) {
			runs.delete(taskId);
			result.resumed.push(taskId);
		} else {
			result.failed.push({ taskId, error: answer.error });
		}
	}
	return result;
}

/** « Plus tard »: the server stops offering these runs (here and on the phone). */
export async function setServerInterruptedAside(taskIds: string[]): Promise<void> {
	const ids = taskIds.flatMap((taskId) => {
		const run = runs.get(taskId);
		runs.delete(taskId);
		return run ? [run.runId] : [];
	});
	if (ids.length === 0) return;
	const answer = await authedFetch(`${LIST}/later`, "POST", { run_ids: ids });
	if (!answer.ok) {
		appLog.warn(`[interrupted-server] Could not set runs aside: ${answer.error}`);
	}
}

/** Test seam. */
export function resetServerInterruptedForTests(): void {
	runs.clear();
}
