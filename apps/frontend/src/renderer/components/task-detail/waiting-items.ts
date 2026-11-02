import type {
	PrFollowupStatus,
	Task,
	TaskPipelineStatus,
} from "../../../shared/types";
import type { PanelCardId } from "./panel-sections";

/**
 * What the task needs from the person now, for the "waiting for you" banner.
 *
 * Every item is read from state the app already holds — nothing is fetched or
 * guessed here — and points at the card that handles it:
 *
 * | Item | Read from | Card |
 * |---|---|---|
 * | `permission` | `task-permission-store` (an ACP agent's question, validated by main) | the question itself (`TaskPermissionPrompt`) |
 * | `plan` | `task.status === "human_review"` and `reviewReason === "plan_review"` | the review (`PlanApprovalSection`) |
 * | `failed` | `task.status === "error"`, or human review for `errors` | the failure banner, above the tabs |
 * | `ci` | `task-store.pipelineStatuses[task.id].state === "failed"`, no repair running | the CI pipeline card |
 * | `prChecks` | `pr-followup-store`: the last look saw failing checks, or gave up, and nothing runs | the PR follow-through card |
 * | `goal` | `task.goal.status` other than `met`, once no agent works on the task | the goal card |
 * | `review` | any other human review (built, QA rejected or unverified, stopped) | the review |
 *
 * A red CI the automatic repair is already handling, or failing checks the
 * follow-through is fixing, are not waiting for the person: they are left out.
 */
export type WaitingItemId =
	| "permission"
	| "plan"
	| "failed"
	| "ci"
	| "prChecks"
	| "goal"
	| "review";

export interface WaitingItem {
	readonly id: WaitingItemId;
	/** The card that handles it; `failure` is the banner above the tabs. */
	readonly target: PanelCardId | "failure";
}

export interface WaitingInput {
	readonly task: Task;
	readonly hasPermissionQuestion: boolean;
	readonly pipeline?: TaskPipelineStatus;
	readonly prFollowup?: PrFollowupStatus;
}

/** An agent is working on the task: a verdict is not final yet. */
const AGENT_AT_WORK = new Set<Task["status"]>(["queue", "in_progress", "ai_review"]);

export function collectWaitingItems({
	task,
	hasPermissionQuestion,
	pipeline,
	prFollowup,
}: WaitingInput): WaitingItem[] {
	const items: WaitingItem[] = [];
	const inReview = task.status === "human_review";
	const reason = task.reviewReason;

	if (hasPermissionQuestion) items.push({ id: "permission", target: "permission" });
	if (inReview && reason === "plan_review") items.push({ id: "plan", target: "review" });
	if (task.status === "error" || (inReview && reason === "errors")) {
		items.push({ id: "failed", target: "failure" });
	}
	if (pipeline?.state === "failed" && !pipeline.autoFixInProgress) {
		items.push({ id: "ci", target: "ciPipeline" });
	}
	const round = prFollowup?.round;
	const prUrl = task.prUrl ?? task.metadata?.prUrl;
	if (
		prUrl &&
		round &&
		!prFollowup?.running &&
		(round.failing.length > 0 || round.decision === "stuck" || round.decision === "exhausted")
	) {
		items.push({ id: "prChecks", target: "prFollowup" });
	}
	if (task.goal && task.goal.status !== "met" && !AGENT_AT_WORK.has(task.status)) {
		items.push({ id: "goal", target: "goal" });
	}
	if (inReview && reason !== "plan_review" && reason !== "errors") {
		items.push({ id: "review", target: "review" });
	}
	return items;
}
