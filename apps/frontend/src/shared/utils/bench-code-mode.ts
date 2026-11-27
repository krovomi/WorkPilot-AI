/**
 * Code mode measured on the repo bench.
 *
 * Code mode (`run_script`) is meant to save model turns and tokens without
 * resolving fewer cards. The bench can replay finished cards twice per
 * engine, without code mode and with it (`codeMode: "on"` on the copy,
 * `bench/lifecycle.Engine`), and say what changed: cards resolved, cost and
 * duration. Nothing changes a default from this score; a person reads it.
 */

import type { BenchEngine, BenchManifest } from "../types/bench";

/** Each engine without code mode, then with it. */
export function codeModeArms(engines: BenchEngine[], measure: boolean): BenchEngine[] {
	const plain = engines.map(({ provider, model, effort }) => ({ provider, model, effort }));
	return measure ? [...plain, ...plain.map((e) => ({ ...e, codeMode: "on" as const }))] : plain;
}

export interface CodeModeVerdict {
	/** Cards judged in both arms of the same engine. */
	pairs: number;
	withoutResolved: number;
	withResolved: number;
	/** Resolved without code mode, not with it. */
	regressions: number;
	/** Mean cost and duration of the paired builds, when both arms measured them. */
	withoutCostUsd: number | null;
	withCostUsd: number | null;
	withoutDurationS: number | null;
	withDurationS: number | null;
	/** `better`: as many resolved or more, no regression, and cheaper. */
	verdict: "better" | "worse" | "same" | "unmeasured";
}

const mean = (values: number[]) =>
	values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const measured = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** What code mode changed in this run, comparing each card's two arms. */
export function codeModeVerdict(run: BenchManifest): CodeModeVerdict | null {
	const arms = run.engines.filter((e) => e.codeMode === "on");
	if (arms.length === 0) return null;
	let pairs = 0;
	let withoutResolved = 0;
	let withResolved = 0;
	let regressions = 0;
	const cost: [number[], number[]] = [[], []];
	const duration: [number[], number[]] = [[], []];
	for (const arm of arms) {
		const base = run.engines.find(
			(e) =>
				!e.codeMode &&
				!e.rule &&
				e.provider === arm.provider &&
				e.model === arm.model &&
				e.effort === arm.effort,
		);
		if (!base) continue;
		for (const build of run.builds) {
			if (build.engineId !== arm.id || build.state !== "judged") continue;
			const other = run.builds.find(
				(b) => b.engineId === base.id && b.caseId === build.caseId && b.state === "judged",
			);
			if (!other) continue;
			pairs += 1;
			if (other.resolved) withoutResolved += 1;
			if (build.resolved) withResolved += 1;
			if (other.resolved && !build.resolved) regressions += 1;
			if (measured(other.costUsd) && measured(build.costUsd)) {
				cost[0].push(other.costUsd);
				cost[1].push(build.costUsd);
			}
			if (measured(other.durationS) && measured(build.durationS)) {
				duration[0].push(other.durationS);
				duration[1].push(build.durationS);
			}
		}
	}
	const withoutCostUsd = mean(cost[0]);
	const withCostUsd = mean(cost[1]);
	let verdict: CodeModeVerdict["verdict"] = "unmeasured";
	if (pairs > 0) {
		if (regressions > 0 || withResolved < withoutResolved) verdict = "worse";
		else if (
			withResolved > withoutResolved ||
			(withoutCostUsd !== null && withCostUsd !== null && withCostUsd < withoutCostUsd)
		)
			verdict = "better";
		else verdict = "same";
	}
	return {
		pairs,
		withoutResolved,
		withResolved,
		regressions,
		withoutCostUsd,
		withCostUsd,
		withoutDurationS: mean(duration[0]),
		withDurationS: mean(duration[1]),
		verdict,
	};
}
