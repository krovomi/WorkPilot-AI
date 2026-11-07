import { describe, expect, it } from "vitest";
import type { TaskLogs, TaskPhaseLog } from "../../../shared/types";
import { computePhaseSplit } from "./phase-split";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const at = (minutesAgo: number) =>
	new Date(NOW - minutesAgo * 60_000).toISOString();

function phase(
	name: TaskPhaseLog["phase"],
	status: TaskPhaseLog["status"],
	started: number | null,
	completed: number | null,
): TaskPhaseLog {
	return {
		phase: name,
		status,
		started_at: started === null ? null : at(started),
		completed_at: completed === null ? null : at(completed),
		entries: [],
	};
}

function logs(
	planning: TaskPhaseLog,
	coding: TaskPhaseLog,
	validation: TaskPhaseLog,
): TaskLogs {
	return {
		spec_id: "001",
		created_at: at(60),
		updated_at: at(0),
		phases: { planning, coding, validation },
	};
}

describe("computePhaseSplit", () => {
	it("splits a finished task by the time each phase took", () => {
		const split = computePhaseSplit(
			100,
			logs(
				phase("planning", "completed", 100, 70),
				phase("coding", "completed", 70, 30),
				phase("validation", "completed", 30, 0),
			),
			NOW,
		);
		expect(split.basis).toBe("time");
		expect(split.segments.map((s) => s.share)).toEqual([30, 40, 30]);
		expect(split.segments.map((s) => Math.round(s.width))).toEqual([30, 40, 30]);
		expect(split.segments[1].durationMs).toBe(40 * 60_000);
	});

	it("keeps the filled length at the task percentage", () => {
		const split = computePhaseSplit(
			50,
			logs(
				phase("planning", "completed", 20, 10),
				phase("coding", "active", 10, null),
				phase("validation", "pending", null, null),
			),
			NOW,
		);
		const widths = split.segments.map((s) => s.width);
		expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(50);
		expect(widths[0]).toBeCloseTo(25);
		expect(widths[2]).toBe(0);
		// The running phase counts up to now and is flagged.
		expect(split.segments[1].active).toBe(true);
		expect(split.segments[1].durationMs).toBe(10 * 60_000);
	});

	it("rounds shares so they always add up to 100", () => {
		const split = computePhaseSplit(
			100,
			logs(
				phase("planning", "completed", 30, 20),
				phase("coding", "completed", 20, 10),
				phase("validation", "completed", 10, 0),
			),
			NOW,
		);
		const shares = split.segments.map((s) => s.share);
		expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
		expect(shares).toEqual([34, 33, 33]);
	});

	it("falls back to the phase bands when the logs carry no timestamps", () => {
		const split = computePhaseSplit(50, null, NOW);
		expect(split.basis).toBe("bands");
		expect(split.segments.map((s) => s.width)).toEqual([20, 30, 0]);
		expect(split.segments.map((s) => s.share)).toEqual([40, 60, 0]);
		expect(split.segments.every((s) => s.durationMs === null)).toBe(true);
	});

	it("uses the full bands at 100% without timing", () => {
		const split = computePhaseSplit(100, undefined, NOW);
		expect(split.segments.map((s) => s.width)).toEqual([20, 60, 20]);
	});

	it("clamps out-of-range progress and ignores invalid dates", () => {
		const broken = logs(
			{ ...phase("planning", "completed", null, null), started_at: "nope" },
			phase("coding", "pending", null, null),
			phase("validation", "pending", null, null),
		);
		expect(
			computePhaseSplit(140, broken, NOW).segments.map((s) => s.width),
		).toEqual([20, 60, 20]);
		expect(
			computePhaseSplit(-5, broken, NOW).segments.every((s) => s.width === 0),
		).toBe(true);
	});

	it("ends a stopped phase at the last log update", () => {
		const split = computePhaseSplit(
			40,
			logs(
				phase("planning", "failed", 10, null),
				phase("coding", "pending", null, null),
				phase("validation", "pending", null, null),
			),
			NOW,
		);
		expect(split.basis).toBe("time");
		expect(split.segments[0].durationMs).toBe(10 * 60_000);
		expect(split.segments[0].width).toBeCloseTo(40);
	});
});
