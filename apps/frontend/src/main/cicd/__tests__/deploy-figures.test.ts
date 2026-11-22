/**
 * @vitest-environment node
 *
 * The watch figures, computed on this machine from the watch states and the
 * person's word on each bad verdict (#366, lot 4).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeployWatch } from "../../../shared/types/deploy-watch";
import {
	computeFigures,
	isVerdictReview,
	listDeployWatches,
	MAX_WATCHES,
	readReviews,
	writeReview,
} from "../deploy-figures";

function watch(over: Partial<DeployWatch>): DeployWatch {
	return {
		runId: "1",
		phase: "done",
		verdict: "ok",
		startedAt: "2026-11-15T10:00:00+00:00",
		notConfigured: false,
		autoRollback: false,
		lastMetrics: [],
		healthOk: null,
		samples: 1,
		problems: [],
		rollbackByPerson: false,
		linkedCause: "",
		linkedOnly: false,
		...over,
	};
}

const NOW = new Date("2026-11-22T12:00:00Z");

describe("computeFigures", () => {
	it("counts verdicts, rollbacks, delays and false alarms by month", () => {
		const figures = computeFigures(
			[
				watch({ runId: "1" }),
				watch({ runId: "2", notConfigured: true }),
				watch({
					runId: "3",
					verdict: "critical",
					rollback: "started",
					degradedAt: "2026-11-15T10:10:00+00:00",
					rollbackAt: "2026-11-15T10:12:00+00:00",
				}),
				watch({
					runId: "4",
					verdict: "critical",
					rollback: "started",
					rollbackByPerson: true,
					startedAt: "2026-09-02T10:00:00Z",
					degradedAt: "2026-09-02T10:10:00Z",
					rollbackAt: "2026-09-02T10:30:00Z",
				}),
				watch({ runId: "5", verdict: "critical", rollback: "started", degradedAt: "2026-11-15T10:10:00Z" }),
				watch({ runId: "6", verdict: "warning" }),
				watch({ runId: "7", verdict: "critical", rollback: "proposed" }),
				watch({
					runId: "8",
					linkedOnly: true,
					linkedCause: "API",
					rollback: "started",
					verdict: "unknown",
					startedAt: "2025-01-01T00:00:00Z",
				}),
				watch({
					runId: "9",
					verdict: "critical",
					rollback: "started",
					startedAt: "not a date",
					degradedAt: "2026-11-15T10:10:00Z",
					rollbackAt: "2026-11-15T10:00:00Z",
				}),
			],
			{ "4": "false_positive", "6": "confirmed", "1": "false_positive" },
			NOW,
		);
		expect(figures).toMatchObject({
			watches: 7,
			criticalVerdicts: 5,
			warningVerdicts: 1,
			automaticRollbacks: 4,
			personRollbacks: 1,
			incidentsAvoided: 3,
			falsePositiveRollbacks: 1,
			reviewedVerdicts: 2,
			falsePositives: 1,
			timedRollbacks: 2,
			meanSecondsToRollback: 660,
			medianSecondsToRollback: 660,
		});
		expect(figures.months.map((m) => m.month)).toEqual([
			"2026-06",
			"2026-07",
			"2026-08",
			"2026-09",
			"2026-10",
			"2026-11",
		]);
		expect(figures.months[3]).toEqual({ month: "2026-09", automatic: 0, person: 1, critical: 1 });
		expect(figures.months[5]).toEqual({ month: "2026-11", automatic: 2, person: 0, critical: 3 });
	});

	it("has no delay without a timed rollback, and an odd count's median is its middle", () => {
		const empty = computeFigures([], {}, NOW);
		expect([empty.meanSecondsToRollback, empty.medianSecondsToRollback]).toEqual([null, null]);
		const timed = (runId: string, seconds: number) =>
			watch({
				runId,
				verdict: "critical",
				rollback: "started",
				degradedAt: "2026-11-15T10:00:00Z",
				rollbackAt: new Date(Date.parse("2026-11-15T10:00:00Z") + seconds * 1000).toISOString(),
			});
		const odd = computeFigures([timed("1", 60), timed("2", 600), timed("3", 120)], {});
		expect([odd.meanSecondsToRollback, odd.medianSecondsToRollback]).toEqual([260, 120]);
	});
});

describe("reviews and watch files", () => {
	let dir: string;
	const watches = () => path.join(dir, ".workpilot", "deploy_watches");
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "deploy-figures-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("records and forgets a person's word, and keeps known words only", () => {
		expect(readReviews(dir)).toEqual({});
		writeReview(dir, "10", "false_positive");
		writeReview(dir, "11", "confirmed");
		expect(readReviews(dir)).toEqual({ "10": "false_positive", "11": "confirmed" });
		writeReview(dir, "10", null);
		expect(readReviews(dir)).toEqual({ "11": "confirmed" });
		writeFileSync(path.join(watches(), "reviews.json"), JSON.stringify({ "12": "maybe", "../x": "confirmed" }));
		expect(readReviews(dir)).toEqual({});
		writeFileSync(path.join(watches(), "reviews.json"), "[]");
		expect(readReviews(dir)).toEqual({});
		expect(isVerdictReview("confirmed")).toBe(true);
		expect(isVerdictReview("nope")).toBe(false);
	});

	it("lists the newest watches, and nothing that is not one", () => {
		expect(listDeployWatches(dir)).toEqual([]);
		mkdirSync(watches(), { recursive: true });
		for (const id of ["5", "40", "7"]) {
			writeFileSync(path.join(watches(), `${id}.json`), JSON.stringify({ run_id: id, phase: "done" }));
		}
		writeFileSync(path.join(watches(), "9.json"), "{bad");
		writeFileSync(path.join(watches(), "7.linked.json"), "[]");
		writeFileSync(path.join(watches(), "reviews.json"), "{}");
		expect(listDeployWatches(dir).map((w) => w.runId)).toEqual(["40", "7", "5"]);
		expect(MAX_WATCHES).toBe(500);
	});
});
