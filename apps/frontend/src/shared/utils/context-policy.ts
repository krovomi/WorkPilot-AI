/**
 * Context-window policy: defaults, normalisation and the small pure helpers
 * shared by the main process (which writes `contextPolicy` and the
 * CONTEXT_ACTION.json marker) and the renderer (form, gauge, store).
 *
 * The contract with the backend is fixed: `contextPolicy` in
 * `task_metadata.json` = { mode, thresholdPct (30..90 step 5), prepareHandoff },
 * absent = DEFAULT_CONTEXT_POLICY.
 */

import type {
	ContextAction,
	TaskContextActionAppliedEvent,
	TaskContextEvent,
	TaskContextUsageEvent,
} from "../types/context-usage";
import { CONTEXT_EVENT_TYPES } from "../types/context-usage";
import type { ContextPolicy, ContextPolicyMode } from "../types/task";

export const CONTEXT_THRESHOLD_MIN = 30;
export const CONTEXT_THRESHOLD_MAX = 90;
export const CONTEXT_THRESHOLD_STEP = 5;
export const CONTEXT_THRESHOLD_DEFAULT = 50;

/** Points below the threshold where the gauge turns amber. */
export const CONTEXT_NEAR_MARGIN = 10;

export const CONTEXT_POLICY_MODES: readonly ContextPolicyMode[] = [
	"auto",
	"compact",
	"clear",
	"off",
];

export const CONTEXT_ACTIONS: readonly ContextAction[] = ["compact", "clear"];

export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({
	mode: "auto",
	thresholdPct: CONTEXT_THRESHOLD_DEFAULT,
	prepareHandoff: true,
});

export function isContextPolicyMode(value: unknown): value is ContextPolicyMode {
	return (
		typeof value === "string" &&
		(CONTEXT_POLICY_MODES as readonly string[]).includes(value)
	);
}

export function isContextAction(value: unknown): value is ContextAction {
	return (
		typeof value === "string" &&
		(CONTEXT_ACTIONS as readonly string[]).includes(value)
	);
}

/** Clamp to 30..90 and snap to the 5-point grid; garbage gives the default. */
export function normalizeThreshold(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) {
		return CONTEXT_THRESHOLD_DEFAULT;
	}
	const snapped =
		Math.round(n / CONTEXT_THRESHOLD_STEP) * CONTEXT_THRESHOLD_STEP;
	return Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, snapped));
}

/** A complete, valid policy from whatever was stored (partial, stale, absent). */
export function normalizeContextPolicy(raw: unknown): ContextPolicy {
	const source =
		raw && typeof raw === "object" ? (raw as Partial<ContextPolicy>) : {};
	return {
		mode: isContextPolicyMode(source.mode)
			? source.mode
			: DEFAULT_CONTEXT_POLICY.mode,
		thresholdPct:
			source.thresholdPct === undefined
				? DEFAULT_CONTEXT_POLICY.thresholdPct
				: normalizeThreshold(source.thresholdPct),
		prepareHandoff:
			typeof source.prepareHandoff === "boolean"
				? source.prepareHandoff
				: DEFAULT_CONTEXT_POLICY.prepareHandoff,
	};
}

/** The policy a task runs with: its own, or the defaults. */
export function resolveContextPolicy(
	metadata: { contextPolicy?: unknown } | null | undefined,
): ContextPolicy {
	return normalizeContextPolicy(metadata?.contextPolicy);
}

export function sameContextPolicy(a: ContextPolicy, b: ContextPolicy): boolean {
	return (
		a.mode === b.mode &&
		a.thresholdPct === b.thresholdPct &&
		a.prepareHandoff === b.prepareHandoff
	);
}

export function isDefaultContextPolicy(policy: ContextPolicy): boolean {
	return sameContextPolicy(policy, DEFAULT_CONTEXT_POLICY);
}

export type ContextZone = "ok" | "near" | "over";

/**
 * Where the gauge sits relative to the threshold: green below, amber within
 * CONTEXT_NEAR_MARGIN points of it, red at or above it.
 */
export function contextZone(percent: number, thresholdPct: number): ContextZone {
	if (percent >= thresholdPct) return "over";
	if (percent >= thresholdPct - CONTEXT_NEAR_MARGIN) return "near";
	return "ok";
}

/** 950 → "950", 84_000 → "84k", 1_250_000 → "1.3M". */
export function formatTokenCount(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "0";
	if (value >= 1_000_000) {
		const m = value / 1_000_000;
		return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
	}
	if (value >= 1_000) {
		const k = value / 1_000;
		return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
	}
	return String(Math.round(value));
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

export function isContextEventType(
	type: unknown,
): type is TaskContextEvent["type"] {
	return (
		typeof type === "string" &&
		(CONTEXT_EVENT_TYPES as readonly string[]).includes(type)
	);
}

/**
 * A well-formed context event from an untrusted payload, or null.
 * Missing numbers become safe defaults rather than NaN in the gauge.
 */
export function parseContextEvent(raw: unknown): TaskContextEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	const base = {
		taskId: typeof e.taskId === "string" ? e.taskId : undefined,
		specId: typeof e.specId === "string" ? e.specId : undefined,
		projectId: typeof e.projectId === "string" ? e.projectId : undefined,
		timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
		eventId: typeof e.eventId === "string" ? e.eventId : undefined,
		sequence: typeof e.sequence === "number" ? e.sequence : undefined,
	};

	if (e.type === "CONTEXT_USAGE") {
		const usage: TaskContextUsageEvent = {
			...base,
			type: "CONTEXT_USAGE",
			phase: str(e.phase),
			subtaskId: nullableStr(e.subtaskId),
			provider: str(e.provider),
			model: str(e.model),
			usedTokens: Math.max(0, num(e.usedTokens, 0)),
			windowTokens: Math.max(0, num(e.windowTokens, 0)),
			percent: Math.min(100, Math.max(0, num(e.percent, 0))),
			source:
				e.source === "exact" || e.source === "reported"
					? e.source
					: "estimated",
			thresholdPct: normalizeThreshold(e.thresholdPct),
			mode: isContextPolicyMode(e.mode) ? e.mode : DEFAULT_CONTEXT_POLICY.mode,
			handoffState:
				e.handoffState === "preparing" || e.handoffState === "ready"
					? e.handoffState
					: "idle",
			recommended: e.recommended === "clear" ? "clear" : "compact",
			compactSupport: e.compactSupport === "native" ? "native" : "emulated",
		};
		return usage;
	}

	if (e.type === "CONTEXT_ACTION_APPLIED") {
		if (!isContextAction(e.action)) return null;
		const applied: TaskContextActionAppliedEvent = {
			...base,
			type: "CONTEXT_ACTION_APPLIED",
			action: e.action,
			trigger: e.trigger === "manual" ? "manual" : "auto",
			phase: str(e.phase),
			subtaskId: nullableStr(e.subtaskId),
			provider: str(e.provider),
			native: e.native === true,
			beforePct: Math.min(100, Math.max(0, num(e.beforePct, 0))),
			afterPct:
				typeof e.afterPct === "number" && Number.isFinite(e.afterPct)
					? Math.min(100, Math.max(0, e.afterPct))
					: null,
		};
		return applied;
	}

	return null;
}

/** The one-shot marker written to every spec dir copy (CONTEXT_ACTION.json). */
export function buildContextActionMarker(
	action: ContextAction,
	now: Date = new Date(),
): {
	action: ContextAction;
	phase: null;
	subtaskId: null;
	requestedAt: string;
} {
	return { action, phase: null, subtaskId: null, requestedAt: now.toISOString() };
}
