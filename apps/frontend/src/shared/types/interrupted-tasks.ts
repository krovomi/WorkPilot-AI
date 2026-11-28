/**
 * The Kanban builds a launch found interrupted, and what the person decides
 * about them (main/ipc-handlers/task/interrupted-prompt.ts).
 */

/** Settings, Agents: what a launch does with the builds the last exit interrupted. */
export const INTERRUPTED_LAUNCH_POLICIES = ["ask", "always", "never"] as const;
export type InterruptedLaunchPolicy = (typeof INTERRUPTED_LAUNCH_POLICIES)[number];

/** « Me demander » unless the person chose otherwise: a launch starts no agent unasked. */
export const DEFAULT_INTERRUPTED_LAUNCH_POLICY: InterruptedLaunchPolicy = "ask";

export function normalizeInterruptedLaunchPolicy(value: unknown): InterruptedLaunchPolicy {
	return (INTERRUPTED_LAUNCH_POLICIES as readonly unknown[]).includes(value)
		? (value as InterruptedLaunchPolicy)
		: DEFAULT_INTERRUPTED_LAUNCH_POLICY;
}

/**
 * How the build stopped. `app_exit`: WorkPilot was closed while it ran.
 * `crash`: the app stopped without closing (crash, forced kill, OS shutdown).
 * `stopped_by_you`: « Arrêter tous les agents » or « stop » to the voice
 * assistant — listed, but not selected by default.
 */
export type InterruptionOrigin = "app_exit" | "crash" | "stopped_by_you";

/** Why a resume would fail right away, checked before offering it. */
export type InterruptedTaskBlocker = "claude_auth" | "spec_missing";

/** The phase a resume re-enters, as the backend names it. */
export type InterruptedPhase = "spec" | "planning" | "coding" | "qa_review" | "qa_fixing";

export interface InterruptedTask {
	taskId: string;
	projectId: string;
	projectName: string;
	title: string;
	origin: InterruptionOrigin;
	/** ISO time of the interruption, or of the task's last update after a crash. */
	interruptedAt: string | null;
	phase: InterruptedPhase;
	subtasksDone: number;
	subtasksTotal: number;
	/** The subtask a coding resume reopens: its title, else its description. */
	nextSubtask: string | null;
	provider: string | null;
	model: string | null;
	blocker: InterruptedTaskBlocker | null;
	/** Ticked when the dialog opens: interrupted by the app, nothing blocking. */
	selectedByDefault: boolean;
}

/** Main → renderer, once per launch. `resumed`: the « Tout reprendre » policy ran. */
export interface InterruptedTasksOffer {
	mode: "ask" | "resumed";
	tasks: InterruptedTask[];
	/** With `mode: "resumed"`: the tasks started (or waiting for a slot). */
	resumed?: string[];
}

export interface InterruptedResumeResult {
	/** Started now. */
	resumed: string[];
	/** Their project's « En cours » is full: each starts when a slot frees up. */
	waiting: string[];
	failed: { taskId: string; error: string }[];
}
