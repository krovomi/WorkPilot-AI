/**
 * Bridges the task-event stream onto the hooks bus.
 *
 * The backend has two event systems that never met. `TaskEventEmitter` writes
 * the real lifecycle — planning started, QA passed, subtasks done — to stdout,
 * where this process parses it and renders it in the task feed. Separately,
 * `services/hooks/` can run an agent, create a spec or trigger a pipeline in
 * response to an event, and exposes twenty trigger types to say when.
 *
 * Nothing connected them. `HookService.emit_event` had exactly one caller —
 * the HTTP endpoint — and nothing in the product ever called it, so every
 * automation a user configured sat waiting for an event that could not arrive.
 *
 * This module is that connection, and deliberately nothing more: it maps the
 * lifecycle events that correspond to a declared trigger, and drops the rest.
 * Forwarding everything would turn a feed built for humans into a firehose
 * pointed at an execution engine.
 */

import { backendFetch } from "../ipc-handlers/_backend-fetch";
import { appLog } from "../app-logger";
import type { TaskEvent } from "./task-event-parser";

/**
 * Task event type -> hook trigger type.
 *
 * Only lifecycle events appear here. The per-feature `*_RESULT` / `*_EVENT` /
 * `*_ERROR` families are progress reporting for one runner's UI panel; they
 * describe a step inside a feature, not a state the project reached, and no
 * trigger type claims to match them.
 */
const TRIGGER_BY_EVENT: Readonly<Record<string, string>> = Object.assign(
	// Null prototype: a plain literal would answer `constructor` and
	// `toString` with inherited Object members, and `?? null` does not catch a
	// function. That would forward a bogus trigger name to the execution
	// engine on any task event named after an Object property.
	Object.create(null) as Record<string, string>,
	{
		// Build lifecycle.
		PLANNING_STARTED: "build_started",
		ALL_SUBTASKS_DONE: "build_completed",

		// QA verdicts. These are the project's own test signal, which is what
		// `test_passed` / `test_failed` mean to someone configuring a hook.
		QA_PASSED: "test_passed",
		QA_FAILED: "test_failed",
		QA_MAX_ITERATIONS: "build_failed",

		// Agent outcomes.
		QA_FIXING_COMPLETE: "agent_completed",
		AUTO_FIX_SUCCESS: "agent_completed",
		QA_AGENT_ERROR: "agent_failed",
		AUTO_FIX_FAILED: "agent_failed",
		AUTO_FIX_ESCALATED: "agent_failed",
	},
);

/** Emitting a hook event must never slow the build that produced it. */
const EMIT_TIMEOUT_MS = 5_000;

/**
 * Whether a hook trigger exists for this task event.
 *
 * Exported for the tests, which assert the mapping does not silently grow to
 * cover the per-feature event families.
 */
export function triggerForTaskEvent(eventType: string | undefined): string | null {
	if (!eventType) {
		return null;
	}
	return TRIGGER_BY_EVENT[eventType] ?? null;
}

/**
 * Forward one task event to the hooks bus, if a trigger matches it.
 *
 * Fire-and-forget by design. The caller is on the hot path of stdout parsing,
 * and a hook that fails to fire must not stall — or fail — the build that
 * emitted the event. Every error is logged at debug and swallowed.
 */
export function forwardTaskEventToHooks(
	event: TaskEvent,
	projectId?: string,
): void {
	const trigger = triggerForTaskEvent(event.type);
	if (!trigger) {
		return;
	}

	const body = {
		type: trigger,
		project_id: projectId || event.projectId || undefined,
		source: "task-event",
		data: {
			task_event: event.type,
			task_id: event.taskId,
			spec_id: event.specId,
			project_id: projectId || event.projectId,
			timestamp: event.timestamp,
		},
	};

	void backendFetch(
		"/api/hooks/emit",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		EMIT_TIMEOUT_MS,
	)
		.then((result) => {
			if (!result.success) {
				appLog.debug(
					`[HookBridge] ${event.type} -> ${trigger} not delivered:`,
					result.error,
				);
				return;
			}
			const fired = (result as { hooks_triggered?: number }).hooks_triggered ?? 0;
			if (fired > 0) {
				appLog.info(
					`[HookBridge] ${event.type} -> ${trigger} fired ${fired} hook(s)`,
				);
			}
		})
		.catch((error: unknown) => {
			appLog.debug(`[HookBridge] ${event.type} -> ${trigger} failed:`, error);
		});
}
