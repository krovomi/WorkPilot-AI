/**
 * What a person can do to a card from the phone, and how each action maps to
 * the server. Same mapping as the desktop's `server-board-actions.ts`:
 * "Start" writes the spec when there is none, otherwise builds, approving
 * the spec first when the card asks for a review; "Stop" cancels the card's
 * queued or running run.
 */

import type { Api } from "../api/endpoints";
import type { AgentRun, BoardCard, CardDetails } from "../api/types";
import { ACTIVE_COLUMNS } from "./columns";

export type CardAction =
	| "start"
	| "approve"
	| "stop"
	| "requestChanges"
	| "merge"
	| "createPr"
	| "retry"
	| "delete";

const ACTIVE_RUN = new Set(["queued", "running"]);

/** The run still in the queue or running, if any (the server lists newest first). */
export function activeRun(runs: readonly AgentRun[]): AgentRun | undefined {
	return runs.find((run) => ACTIVE_RUN.has(run.status));
}

/** The actions the card offers now. The server checks every one again. */
export function availableActions(
	card: BoardCard,
	details: CardDetails | null,
	runs: readonly AgentRun[],
): CardAction[] {
	if (!card.specId) return [];
	const running = !!activeRun(runs) || ACTIVE_COLUMNS.has(card.column);
	if (running) return ["stop"];
	const hasSpec = !!details?.spec;
	const needsApproval = hasSpec && !!details?.requireReview && !details.approval.approved;
	switch (card.column) {
		case "backlog":
			return needsApproval ? ["approve", "start", "delete"] : ["start", "delete"];
		case "human_review":
			if (needsApproval) return ["approve", "start"];
			return ["merge", "createPr", "requestChanges"];
		case "build_failed":
		case "error":
			return ["retry", "requestChanges"];
		case "pr_created":
			return ["merge"];
		default:
			return [];
	}
}

/** Start the card's next step: its spec, or its build. */
export async function startCard(
	client: Api,
	projectId: string,
	card: BoardCard,
	details: CardDetails | null,
): Promise<void> {
	if (!card.specId) throw new Error("card_not_indexed");
	if (!details?.spec) {
		await client.startRun(projectId, card.specId, "spec");
		return;
	}
	if (details.requireReview && !details.approval.approved) {
		await client.approve(projectId, card.id);
	}
	await client.startRun(projectId, card.specId, "build");
}

/** Cancel the card's queued or running run; false when there was none. */
export async function stopCard(client: Api, projectId: string, card: BoardCard): Promise<boolean> {
	if (!card.specId) return false;
	const run = activeRun(await client.runs(projectId, card.specId));
	if (!run) return false;
	const result = await client.cancelRun(projectId, card.specId, run.id);
	return result.cancelled;
}

/** Send the work back with what to change, then build again. */
export async function sendBack(client: Api, projectId: string, card: BoardCard, feedback: string): Promise<void> {
	if (!card.specId) throw new Error("card_not_indexed");
	const text = feedback.trim();
	if (!text) throw new Error("feedback_required");
	await client.requestChanges(projectId, card.id, text);
	await client.startRun(projectId, card.specId, "build");
}

/** The permissions an action needs, as the server checks them. */
export const ACTION_PERMISSIONS: Record<CardAction, readonly string[]> = {
	start: ["agent.execute"],
	retry: ["agent.execute"],
	approve: ["review.approve"],
	requestChanges: ["review.approve", "agent.execute"],
	merge: ["agent.execute", "task.merge"],
	createPr: ["agent.execute", "vcs.pr.create"],
	stop: [],
	delete: ["task.delete"],
};

/** The actions the person's permissions allow, so a button that would 403 is not shown. */
export function allowedActions(actions: readonly CardAction[], can: (permission: string) => boolean): CardAction[] {
	return actions.filter((action) => ACTION_PERMISSIONS[action].every(can));
}
