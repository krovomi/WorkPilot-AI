/**
 * Context-window telemetry — Zustand store
 *
 * The last CONTEXT_USAGE of each running task (how full its agent session is)
 * and a short history of the compactions / new threads applied to it
 * (CONTEXT_ACTION_APPLIED). Fed by one listener registered for the life of the
 * window in `global-listeners.ts`: the gauge in the task modal and the mini
 * ring on the card only read it.
 */

import i18n from "i18next";
import { create } from "zustand";
import type {
	ContextAction,
	TaskContextActionAppliedEvent,
	TaskContextEvent,
	TaskContextUsageEvent,
	TaskStatus,
} from "../../shared/types";
import { parseContextEvent } from "../../shared/utils/context-policy";
import { toast } from "../hooks/use-toast";
import { useTaskStore } from "./task-store";

/** How many applied actions the popover keeps per task. */
export const CONTEXT_HISTORY_LIMIT = 10;

/** Statuses in which an agent session is alive and can report usage. */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"in_progress",
	"ai_review",
]);

export function isContextActiveStatus(status: TaskStatus | undefined): boolean {
	return !!status && ACTIVE_STATUSES.has(status);
}

interface ContextUsageState {
	usage: Record<string, TaskContextUsageEvent>;
	history: Record<string, TaskContextActionAppliedEvent[]>;
	/** A manual action requested and not yet confirmed by the backend. */
	pending: Record<string, ContextAction>;
	applyEvent: (taskId: string, event: TaskContextEvent) => void;
	setPending: (taskId: string, action: ContextAction | null) => void;
	clearUsage: (taskId: string) => void;
	reset: () => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
	usage: {},
	history: {},
	pending: {},

	applyEvent: (taskId, event) =>
		set((state) => {
			if (event.type === "CONTEXT_USAGE") {
				return { usage: { ...state.usage, [taskId]: event } };
			}
			const previous = state.history[taskId] ?? [];
			// The same event can arrive twice (worktree + main log replay).
			if (event.eventId && previous.some((e) => e.eventId === event.eventId)) {
				return state;
			}
			const history = [event, ...previous].slice(0, CONTEXT_HISTORY_LIMIT);
			const current = state.usage[taskId];
			return {
				history: { ...state.history, [taskId]: history },
				pending: without(state.pending, taskId),
				// Reflect the drop right away instead of waiting for the next
				// throttled CONTEXT_USAGE.
				usage:
					current && event.afterPct !== null
						? {
								...state.usage,
								[taskId]: {
									...current,
									percent: event.afterPct,
									usedTokens: Math.round(
										(current.windowTokens * event.afterPct) / 100,
									),
									handoffState: "idle",
								},
							}
						: state.usage,
			};
		}),

	setPending: (taskId, action) =>
		set((state) => ({
			pending:
				action === null
					? without(state.pending, taskId)
					: { ...state.pending, [taskId]: action },
		})),

	clearUsage: (taskId) =>
		set((state) => ({
			usage: without(state.usage, taskId),
			pending: without(state.pending, taskId),
		})),

	reset: () => set({ usage: {}, history: {}, pending: {} }),
}));

/** The toast shown when the backend applied a compaction or a new thread. */
export function describeAppliedAction(event: TaskContextActionAppliedEvent): {
	title: string;
	description?: string;
} {
	const before = Math.round(event.beforePct);
	if (event.action === "compact") {
		return {
			title:
				event.afterPct === null
					? i18n.t("tasks:contextManagement.toast.compactedNoAfter", { before })
					: i18n.t("tasks:contextManagement.toast.compacted", {
							before,
							after: Math.round(event.afterPct),
						}),
		};
	}
	return {
		title: i18n.t("tasks:contextManagement.toast.cleared", { before }),
	};
}

/** Route one raw event into the store; toast the applied actions. */
export function handleContextEvent(taskId: string, raw: unknown): void {
	const event = parseContextEvent(raw);
	if (!event || !taskId) return;
	const before = useContextUsageStore.getState().history[taskId];
	useContextUsageStore.getState().applyEvent(taskId, event);
	// A duplicate leaves the history untouched: no second toast for it.
	const recorded = useContextUsageStore.getState().history[taskId] !== before;
	if (event.type === "CONTEXT_ACTION_APPLIED" && recorded) {
		const { title } = describeAppliedAction(event);
		const task = useTaskStore
			.getState()
			.tasks.find((t) => t.id === taskId || t.specId === taskId);
		toast({ title, description: task?.title || undefined });
	}
}

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupContextUsageListeners(): () => void {
	if (teardown) return teardown;
	const api = globalThis.electronAPI;
	const unsubscribers: Array<() => void> = [];
	if (typeof api?.onTaskContextUsage === "function") {
		unsubscribers.push(
			api.onTaskContextUsage((taskId, event) => handleContextEvent(taskId, event)),
		);
	}
	if (typeof api?.onTaskStatusChange === "function") {
		// A session that ended has no usage any more: drop the stale gauge so a
		// restart does not show the previous run's figure.
		unsubscribers.push(
			api.onTaskStatusChange((taskId, status) => {
				if (!isContextActiveStatus(status)) {
					useContextUsageStore.getState().clearUsage(taskId);
				}
			}),
		);
	}
	teardown = () => {
		teardown = null;
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	return teardown;
}
