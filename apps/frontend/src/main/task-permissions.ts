/**
 * The questions ACP agents ask before they act, held for the card.
 *
 * A build process announces a question with a `PERMISSION_REQUESTED` task
 * event and withdraws it with `PERMISSION_RESOLVED`. The answer goes back on
 * that process's stdin, one line (`ANSWER_PREFIX`), and only for a question
 * this registry holds, naming one of the options that question offered. The
 * build checks again on its side (`acp_permissions.py`).
 *
 * A task event is parsed from the build's stdout, and an agent's text can
 * reach that stdout: a forged question is possible. It can make the card ask
 * something; the answer then names a request the build never made and is
 * ignored there. It can never answer a real question.
 */
import { z } from "zod";
import type {
	TaskPermissionAnswerResult,
	TaskPermissionRequest,
} from "../shared/types/task-permission";

/** The line the backend reads on stdin (`acp_permissions.ANSWER_PREFIX`). */
export const ANSWER_PREFIX = "__WORKPILOT_PERMISSION_ANSWER__:";

/** The environment variable that tells the backend the card can be asked. */
export const PERMISSION_CHANNEL_ENV = { WORKPILOT_PERMISSION_CHANNEL: "stdin" } as const;

const RequestId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const OptionId = z.string().regex(/^[A-Za-z0-9_.:@#+=-]{1,128}$/);

const RequestSchema = z.object({
	requestId: RequestId,
	agent: z.string().max(80),
	title: z.string().max(300),
	kind: z.string().regex(/^[a-z_]{1,32}$/),
	options: z
		.array(
			z.object({
				optionId: OptionId,
				name: z.string().min(1).max(80),
				kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
			}),
		)
		.min(1)
		.max(8),
	locations: z.array(z.string().max(500)).max(10),
	expiresAt: z.string().max(40),
});

/** The question carried by a `PERMISSION_REQUESTED` event, or null. */
export function parsePermissionRequest(
	taskId: string,
	event: { request?: unknown; projectId?: unknown },
	projectId?: string,
): TaskPermissionRequest | null {
	const parsed = RequestSchema.safeParse(event.request);
	if (!parsed.success) return null;
	return { ...parsed.data, taskId, projectId };
}

/** The request id a `PERMISSION_RESOLVED` event withdraws, or null. */
export function resolvedRequestId(event: { requestId?: unknown }): string | null {
	const parsed = RequestId.safeParse(event.requestId);
	return parsed.success ? parsed.data : null;
}

export class TaskPermissionRegistry {
	private readonly byTask = new Map<string, Map<string, TaskPermissionRequest>>();

	add(request: TaskPermissionRequest): void {
		const pending = this.byTask.get(request.taskId) ?? new Map();
		pending.set(request.requestId, request);
		this.byTask.set(request.taskId, pending);
	}

	/** Remove one question; whether it was there. */
	remove(taskId: string, requestId: string): boolean {
		const pending = this.byTask.get(taskId);
		const removed = pending?.delete(requestId) ?? false;
		if (pending && pending.size === 0) this.byTask.delete(taskId);
		return removed;
	}

	/** Every question of a task, gone with its process. */
	clearTask(taskId: string): TaskPermissionRequest[] {
		const pending = [...(this.byTask.get(taskId)?.values() ?? [])];
		this.byTask.delete(taskId);
		return pending;
	}

	list(): TaskPermissionRequest[] {
		return [...this.byTask.values()].flatMap((pending) => [...pending.values()]);
	}

	/**
	 * Check an answer and hand back the line to write, or why it is refused.
	 * The question stays until the build says it is resolved.
	 */
	answer(
		taskId: unknown,
		requestId: unknown,
		optionId: unknown,
	): { line: string } | Exclude<TaskPermissionAnswerResult, { ok: true }> {
		if (typeof taskId !== "string" || typeof requestId !== "string") {
			return { ok: false, reason: "not_pending" };
		}
		const request = this.byTask.get(taskId)?.get(requestId);
		if (!request) return { ok: false, reason: "not_pending" };
		if (!request.options.some((option) => option.optionId === optionId)) {
			return { ok: false, reason: "invalid_option" };
		}
		return {
			line: `${ANSWER_PREFIX}${JSON.stringify({ requestId, optionId })}\n`,
		};
	}
}

export const taskPermissions = new TaskPermissionRegistry();
