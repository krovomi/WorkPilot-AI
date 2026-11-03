import type { TaskLogPhase, TaskLogs } from "../../../shared/types";

/** The three phases the progress bar splits into, in pipeline order. */
export const SPLIT_PHASES: readonly TaskLogPhase[] = [
	"planning",
	"coding",
	"validation",
];

/**
 * Where each phase sits on the overall 0-100 scale when no timing is known.
 * Same bands as EXECUTION_PHASE_WEIGHTS (planning 0-20, coding 20-80, QA
 * 80-100), so the split never contradicts the percentage it decorates.
 */
const FALLBACK_BANDS: Record<TaskLogPhase, { start: number; end: number }> = {
	planning: { start: 0, end: 20 },
	coding: { start: 20, end: 80 },
	validation: { start: 80, end: 100 },
};

export interface PhaseSegment {
	phase: TaskLogPhase;
	/** Width of the coloured segment, in % of the whole bar (sums to `progress`). */
	width: number;
	/** Share of the work done so far that this phase took, in whole % (sums to 100). */
	share: number;
	/** Time spent in the phase, when the logs carry its timestamps. */
	durationMs: number | null;
	/** The phase is the one running right now. */
	active: boolean;
}

export interface PhaseSplit {
	/** `time`: shares come from how long each phase ran; `bands`: from the fixed weights. */
	basis: "time" | "bands";
	segments: PhaseSegment[];
}

function toMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/** How long a phase ran: started → completed, or started → now while it runs. */
function phaseDuration(
	logs: TaskLogs,
	phase: TaskLogPhase,
	now: number,
): number | null {
	const log = logs.phases[phase];
	if (!log) return null;
	const start = toMs(log.started_at);
	if (start === null) return null;
	const end =
		toMs(log.completed_at) ??
		(log.status === "active" ? now : toMs(logs.updated_at));
	if (end === null) return null;
	return Math.max(0, end - start);
}

/**
 * Whole percentages that add up to exactly 100 (largest remainder), so the
 * legend never reads "33 % · 33 % · 33 %".
 */
function roundShares(values: number[]): number[] {
	const total = values.reduce((a, b) => a + b, 0);
	if (total <= 0) return values.map(() => 0);
	const raw = values.map((v) => (v / total) * 100);
	const floored = raw.map(Math.floor);
	let missing = 100 - floored.reduce((a, b) => a + b, 0);
	const order = raw
		.map((v, i) => ({ i, rest: v - Math.floor(v) }))
		.sort((a, b) => b.rest - a.rest);
	for (const { i } of order) {
		if (missing <= 0) break;
		if (values[i] > 0) {
			floored[i] += 1;
			missing -= 1;
		}
	}
	return floored;
}

/**
 * Splits the filled part of the task progress bar into one segment per phase.
 *
 * The bar's length stays the task's overall percentage; what changes is its
 * colour: each phase owns a slice proportional to the time it took, so a
 * finished task reads e.g. 30 % planning, 40 % coding, 30 % validation at a
 * glance. Without timestamps (old logs, logs not loaded yet) the slices follow
 * the fixed phase bands instead.
 */
export function computePhaseSplit(
	progress: number,
	logs: TaskLogs | null | undefined,
	now: number = Date.now(),
): PhaseSplit {
	const filled = Math.min(100, Math.max(0, progress));
	const active = new Set(
		SPLIT_PHASES.filter((p) => logs?.phases[p]?.status === "active"),
	);

	const durations = SPLIT_PHASES.map((p) =>
		logs ? phaseDuration(logs, p, now) : null,
	);
	const timed = durations.map((d) => d ?? 0);
	const totalTime = timed.reduce((a, b) => a + b, 0);

	if (totalTime > 0) {
		const shares = roundShares(timed);
		return {
			basis: "time",
			segments: SPLIT_PHASES.map((phase, i) => ({
				phase,
				width: (filled * timed[i]) / totalTime,
				share: shares[i],
				durationMs: durations[i],
				active: active.has(phase),
			})),
		};
	}

	const widths = SPLIT_PHASES.map((p) => {
		const band = FALLBACK_BANDS[p];
		return Math.min(band.end - band.start, Math.max(0, filled - band.start));
	});
	const shares = roundShares(widths);
	return {
		basis: "bands",
		segments: SPLIT_PHASES.map((phase, i) => ({
			phase,
			width: widths[i],
			share: shares[i],
			durationMs: null,
			active: active.has(phase),
		})),
	};
}
