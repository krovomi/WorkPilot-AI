import { DEFAULT_SWARM_SETTINGS, type SwarmSettings } from "../types/swarm";

/** The bounds the Swarm Mode panel offers; the backend reads the same ones. */
export const SWARM_PARALLEL_RANGE = [2, 8] as const;
export const SWARM_RETRIES_RANGE = [0, 5] as const;

function integerIn(
	value: unknown,
	fallback: number,
	[min, max]: readonly [number, number],
): number {
	const n = value ?? fallback;
	if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
		throw new Error("swarm-invalid-settings");
	return n;
}

function flag(value: unknown, fallback: boolean): boolean {
	const b = value ?? fallback;
	if (typeof b !== "boolean") throw new Error("swarm-invalid-settings");
	return b;
}

/**
 * The swarm setting as the renderer sent it, checked before it is saved:
 * the renderer is not trusted (S6), and the build reads these numbers.
 * Throws `swarm-invalid-settings` on anything else.
 */
export function parseSwarmSettings(value: unknown): SwarmSettings {
	if (value === undefined) return { ...DEFAULT_SWARM_SETTINGS };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("swarm-invalid-settings");
	const v = value as Record<string, unknown>;
	const d = DEFAULT_SWARM_SETTINGS;
	return {
		enabled: flag(v.enabled, d.enabled),
		maxParallelAgents: integerIn(
			v.maxParallelAgents,
			d.maxParallelAgents,
			SWARM_PARALLEL_RANGE,
		),
		failFast: flag(v.failFast, d.failFast),
		maxRetriesPerSubtask: integerIn(
			v.maxRetriesPerSubtask,
			d.maxRetriesPerSubtask,
			SWARM_RETRIES_RANGE,
		),
	};
}

/**
 * The saved swarm setting as the variables a task's build reads
 * (`agents/swarm/build_phase.py`). Nothing when it is off, or when the
 * settings file holds something it cannot read: the build then runs its
 * subtasks one after the other, as without the swarm.
 */
export function swarmEnv(saved: unknown): Record<string, string> {
	let settings: SwarmSettings;
	try {
		settings = parseSwarmSettings(saved);
	} catch {
		return {};
	}
	if (!settings.enabled) return {};
	return {
		WORKPILOT_SWARM_MAX_PARALLEL: String(settings.maxParallelAgents),
		WORKPILOT_SWARM_MAX_RETRIES: String(settings.maxRetriesPerSubtask),
		...(settings.failFast && { WORKPILOT_SWARM_FAIL_FAST: "1" }),
	};
}
