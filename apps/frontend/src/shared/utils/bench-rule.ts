/**
 * A candidate rule measured on the repo bench (prospective P6).
 *
 * A rule learned from reviews waits for a person to adopt it. Before that, the
 * bench can replay finished cards twice per engine, without the rule and with
 * it (the copy is built with the rule adopted, `bench/lifecycle.write_rule`),
 * and say what the rule changed. Nothing is ever adopted from this score.
 */

import type { BenchEngine, BenchManifest } from "../types/bench";

/** As long as an adopted rule (`learning_loop/review_lessons.MAX_RULE_CHARS`). */
export const MAX_RULE_CHARS = 500;

export function normalizeRule(rule: string): string {
	return rule.split(/\s+/).filter(Boolean).join(" ");
}

/** Each engine without the rule, then with it. */
export function armsFor(engines: BenchEngine[], rule: string): BenchEngine[] {
	const text = normalizeRule(rule);
	const plain = engines.map(({ provider, model, effort }) => ({ provider, model, effort }));
	return text ? [...plain, ...plain.map((e) => ({ ...e, rule: text }))] : plain;
}

export interface RuleVerdict {
	rule: string;
	/** Cards judged in both arms of the same engine. */
	pairs: number;
	withoutResolved: number;
	withResolved: number;
	/** Resolved without the rule, not with it: what users feel as a breakage. */
	regressions: number;
	/** `better` only with more resolved and no regression; never an adoption. */
	verdict: "better" | "worse" | "same" | "unmeasured";
}

/** What the rule changed in this run, comparing each card's two arms. */
export function ruleVerdict(run: BenchManifest): RuleVerdict | null {
	const ruled = run.engines.filter((e) => e.rule);
	if (ruled.length === 0) return null;
	const out: RuleVerdict = {
		rule: ruled[0].rule ?? "",
		pairs: 0,
		withoutResolved: 0,
		withResolved: 0,
		regressions: 0,
		verdict: "unmeasured",
	};
	for (const arm of ruled) {
		const base = run.engines.find(
			(e) =>
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
			out.pairs += 1;
			if (other.resolved) out.withoutResolved += 1;
			if (build.resolved) out.withResolved += 1;
			if (other.resolved && !build.resolved) out.regressions += 1;
		}
	}
	if (out.pairs > 0) {
		out.verdict =
			out.regressions > 0
				? "worse"
				: out.withResolved > out.withoutResolved
					? "better"
					: "same";
	}
	return out;
}
