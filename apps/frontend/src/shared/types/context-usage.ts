/**
 * Live context-window telemetry emitted by the backend as `__TASK_EVENT__`
 * lines and forwarded untouched to the renderer on TASK_CONTEXT_USAGE.
 *
 * These events never go through XState: they describe how full the current
 * agent session is, not a state the task reached.
 */

import type { ContextPolicyMode } from "./task";

/** A one-shot command the user (or the backend) applies to the session. */
export type ContextAction = "compact" | "clear";

/** How the token count was obtained, from most to least precise. */
export type ContextUsageSource = "exact" | "reported" | "estimated";

/** The handoff summary prepared in the background before the threshold. */
export type ContextHandoffState = "idle" | "preparing" | "ready";

/** Whether the provider compacts natively or the backend emulates it. */
export type ContextCompactSupport = "native" | "emulated";

/** Fields every `__TASK_EVENT__` carries. */
interface TaskContextEventBase {
	taskId?: string;
	specId?: string;
	projectId?: string;
	timestamp?: string;
	eventId?: string;
	sequence?: number;
}

export interface TaskContextUsageEvent extends TaskContextEventBase {
	type: "CONTEXT_USAGE";
	phase: string;
	subtaskId: string | null;
	provider: string;
	model: string;
	usedTokens: number;
	windowTokens: number;
	/** 0-100, float. */
	percent: number;
	source: ContextUsageSource;
	thresholdPct: number;
	mode: ContextPolicyMode;
	handoffState: ContextHandoffState;
	recommended: ContextAction;
	compactSupport: ContextCompactSupport;
	/**
	 * Share of the prompt the provider served from its cache (0-1), over the
	 * calls that report a cache. `null`: the provider reports none — unknown,
	 * not 0. Absent from events of an older backend.
	 */
	cacheHitRatio?: number | null;
	/** Calls that reused less than half of the previous call's prompt. */
	prefixRewrites?: number;
}

export interface TaskContextActionAppliedEvent extends TaskContextEventBase {
	type: "CONTEXT_ACTION_APPLIED";
	action: ContextAction;
	trigger: "auto" | "manual";
	phase: string;
	subtaskId: string | null;
	provider: string;
	native: boolean;
	beforePct: number;
	afterPct: number | null;
}

export type TaskContextEvent =
	| TaskContextUsageEvent
	| TaskContextActionAppliedEvent;

/** The two event types forwarded on TASK_CONTEXT_USAGE. */
export const CONTEXT_EVENT_TYPES = [
	"CONTEXT_USAGE",
	"CONTEXT_ACTION_APPLIED",
] as const;
