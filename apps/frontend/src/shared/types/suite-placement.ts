/**
 * Where a task's long suites run (`apps/backend/test_placement/`) and what
 * became of a suite sent to the forge's CI.
 */

/** `auto` computes from the machine; `machine` and `ci` are manual choices. */
export type TestPlacementMode = "auto" | "machine" | "ci";

export const TEST_PLACEMENT_MODES: readonly TestPlacementMode[] = [
	"auto",
	"machine",
	"ci",
];

/** Where the backend decided the full suite runs (`test_placement.json`). */
export type SuiteTarget = "machine" | "server" | "ci" | "queue";

export interface SuitePlacement {
	target: SuiteTarget;
	/** Closed list: chosen, alone, room, pr, server, branch_push, no_route, turn, not_followed. */
	reason: string;
	mode: TestPlacementMode;
	/** What the machine lacked: cpu, ram, vram. */
	short: Array<"cpu" | "ram" | "vram">;
	decidedBy?: "task" | "project" | "default";
	waitedSeconds?: number;
	/** Unix seconds. */
	at?: number;
	facts: Record<string, number>;
}

/** The suite of a task branch pushed to the forge's CI, kept in the plan. */
export interface CiSuiteRecord {
	state: "pending" | "passed" | "failed" | "not_started";
	branch: string;
	sha: string;
	/** ISO time of the push. */
	pushedAt: string;
	/** The QA sign-off this push answers, so a restart does not push twice. */
	signoffAt?: string;
	/** A pipeline was started because the push alone did not start one. */
	triggered?: boolean;
	/** Why it did not start: push_failed, no_pipeline. */
	reason?: string;
	webUrl?: string;
}
