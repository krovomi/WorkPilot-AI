import { describe, expect, it } from "vitest";
import type { BenchBuild, BenchManifest } from "../../types/bench";
import { armsFor, normalizeRule, ruleVerdict } from "../bench-rule";

const A = { provider: "anthropic", model: "m", effort: "high" };
const B = { provider: "openai", model: "g", effort: "low" };

function run(builds: Array<[string, string, boolean | null]>): BenchManifest {
	return {
		runId: "r",
		createdAt: "",
		phase: "done",
		engines: [
			{ ...A, id: "v1" },
			{ ...B, id: "v2" },
			{ ...A, id: "v3", rule: "Test first." },
			{ ...B, id: "v4", rule: "Test first." },
		],
		cases: [],
		builds: builds.map(
			([caseId, engineId, resolved], i): BenchBuild => ({
				id: `b${i}`,
				caseId,
				engineId,
				taskId: `t${i}`,
				copy: "",
				state: resolved === null ? "skipped" : "judged",
				resolved: resolved ?? undefined,
			}),
		),
	};
}

describe("bench rule", () => {
	it("replays each engine without the rule, then with it", () => {
		expect(armsFor([A, B], "  Test\n first. ")).toEqual([
			A,
			B,
			{ ...A, rule: "Test first." },
			{ ...B, rule: "Test first." },
		]);
		expect(armsFor([A], "   ")).toEqual([A]);
		expect(normalizeRule(" a \t b\n")).toBe("a b");
	});

	it("compares each card's two arms of the same engine", () => {
		const verdict = ruleVerdict(
			run([
				["c1", "v1", false],
				["c1", "v3", true],
				["c2", "v2", true],
				["c2", "v4", true],
				["c3", "v1", true],
				["c3", "v3", null], // not counted: never judged with the rule
			]),
		);
		expect(verdict).toMatchObject({
			pairs: 2,
			withoutResolved: 1,
			withResolved: 2,
			regressions: 0,
			verdict: "better",
		});
	});

	it("calls a single regression worse, whatever it fixes elsewhere", () => {
		const verdict = ruleVerdict(
			run([
				["c1", "v1", false],
				["c1", "v3", true],
				["c2", "v1", false],
				["c2", "v3", true],
				["c3", "v2", true],
				["c3", "v4", false],
			]),
		);
		expect(verdict?.verdict).toBe("worse");
		expect(verdict?.regressions).toBe(1);
	});

	it("has nothing to say about a run without a rule, or before any pair", () => {
		const plain = run([["c1", "v1", true]]);
		plain.engines = plain.engines.filter((e) => !e.rule);
		expect(ruleVerdict(plain)).toBeNull();
		expect(ruleVerdict(run([["c1", "v3", true]]))?.verdict).toBe("unmeasured");
	});
});
