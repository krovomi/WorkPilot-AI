/**
 * A blocked subtask: why the agent stopped, and how a person unblocks it.
 *
 * The rules are the backend's (`apps/backend/foundation/subtask_unblock.py`):
 * the same fields, the same four answers. The main process applies them to a
 * local task's plan (`main/ipc-handlers/task/subtask-unblock-handlers.ts`);
 * a server card's plan is changed by the server's route. The loaders read the
 * fields back for the subtask panel (`subtaskBlockFields`).
 */

/** Why a subtask is blocked, as the backend writes `blocked_kind`. */
export const BLOCKED_KINDS = [
	"needs_human",
	"manual_verification",
	"max_attempts",
	"file_validation",
	"tool_concurrency",
	"agent",
] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

/** What a person can answer from the subtask panel. */
export const UNBLOCK_ACTIONS = ["complete", "skip", "retry", "answer"] as const;
export type UnblockAction = (typeof UNBLOCK_ACTIONS)[number];

/** Answers that send the subtask back to the agent (the build restarts). */
export const RESTART_ACTIONS: ReadonlySet<UnblockAction> = new Set([
	"retry",
	"answer",
]);

/** Statuses a person can unblock: blocked, and failed. */
export const UNBLOCKABLE_STATUSES: ReadonlySet<string> = new Set([
	"blocked",
	"failed",
]);

export const MAX_REPLY = 4000;
export const MAX_REASON = 1000;

/** Stable error codes, translated by the panel (`tasks:subtasks.unblock.errors`). */
export type UnblockError =
	| "invalid_action"
	| "reply_required"
	| "reply_too_long"
	| "subtask_not_found"
	| "not_blocked"
	| "task_running"
	| "task_not_found"
	| "plan_unreadable";

export class UnblockRefused extends Error {
	constructor(readonly code: UnblockError) {
		super(code);
		this.name = "UnblockRefused";
	}
}

/** How a person resolved a subtask without the agent. */
export interface HumanResolution {
	action: "complete" | "skip";
	at: string;
	reason?: string;
}

/** The block-related fields of a subtask, as the panel reads them. */
export interface SubtaskBlockFields {
	blockedReason?: string;
	blockedKind?: BlockedKind;
	humanReply?: string;
	humanResolution?: HumanResolution;
}

type PlanRecord = Record<string, unknown>;

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** `blocked_reason`, or the `_blocked_reason` older agents wrote. */
export function planBlockedReason(subtask: PlanRecord): string {
	return (
		text(subtask.blocked_reason) || text(subtask._blocked_reason)
	).slice(0, MAX_REASON);
}

/** The panel's view of a plan subtask's block, reply and resolution. */
export function subtaskBlockFields(subtask: PlanRecord): SubtaskBlockFields {
	const fields: SubtaskBlockFields = {};
	const reason = planBlockedReason(subtask);
	if (reason) fields.blockedReason = reason;
	const kind = subtask.blocked_kind;
	if (typeof kind === "string" && (BLOCKED_KINDS as readonly string[]).includes(kind)) {
		fields.blockedKind = kind as BlockedKind;
	}
	const reply = text(subtask.human_reply);
	if (reply) fields.humanReply = reply.slice(0, MAX_REPLY);
	const resolution = subtask.human_resolution as PlanRecord | undefined;
	if (
		resolution &&
		typeof resolution === "object" &&
		(resolution.action === "complete" || resolution.action === "skip")
	) {
		fields.humanResolution = {
			action: resolution.action,
			at: text(resolution.at),
			...(text(resolution.reason) ? { reason: text(resolution.reason) } : {}),
		};
	}
	return fields;
}

function planSubtasks(plan: PlanRecord): PlanRecord[] {
	const phases = Array.isArray(plan.phases) ? plan.phases : [];
	const out: PlanRecord[] = [];
	for (const phase of phases) {
		if (!phase || typeof phase !== "object") continue;
		const record = phase as PlanRecord;
		const items = Array.isArray(record.subtasks)
			? record.subtasks
			: Array.isArray(record.chunks)
				? record.chunks
				: [];
		for (const item of items) {
			if (item && typeof item === "object") out.push(item as PlanRecord);
		}
	}
	return out;
}

/** Mark the plan as running again, its QA sign-off to be done again. */
export function reopenPlan(plan: PlanRecord, now: string): void {
	plan.status = "in_progress";
	plan.planStatus = "in_progress";
	plan.updated_at = now;
	const signoff = plan.qa_signoff;
	if (signoff && typeof signoff === "object") {
		(signoff as PlanRecord).status = "pending";
	}
}

/**
 * Apply a person's answer to a blocked (or failed) subtask of `plan`, in place.
 * Returns the updated subtask; throws `UnblockRefused` when it cannot apply.
 */
export function applyUnblock(
	plan: PlanRecord,
	subtaskId: string,
	action: string,
	reply?: string,
	now: string = new Date().toISOString(),
): PlanRecord {
	if (!(UNBLOCK_ACTIONS as readonly string[]).includes(action)) {
		throw new UnblockRefused("invalid_action");
	}
	const said = text(reply);
	if (action === "answer" && !said) throw new UnblockRefused("reply_required");
	if (said.length > MAX_REPLY) throw new UnblockRefused("reply_too_long");
	const subtask = planSubtasks(plan).find((s) => String(s.id) === subtaskId);
	if (!subtask) throw new UnblockRefused("subtask_not_found");
	if (!UNBLOCKABLE_STATUSES.has(String(subtask.status))) {
		throw new UnblockRefused("not_blocked");
	}

	const previousReason = planBlockedReason(subtask);
	delete subtask.blocked_reason;
	delete subtask._blocked_reason;
	delete subtask.blocked_kind;

	if (action === "complete" || action === "skip") {
		subtask.status = "completed";
		subtask.human_resolution = {
			action,
			at: now,
			...(previousReason ? { reason: previousReason } : {}),
		};
		return subtask;
	}

	subtask.status = "pending";
	subtask.unblocked_at = now;
	delete subtask.human_resolution;
	if (action === "answer") {
		subtask.human_reply = said;
		subtask.human_reply_at = now;
	}
	reopenPlan(plan, now);
	return subtask;
}
