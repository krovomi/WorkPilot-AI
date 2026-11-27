import { describe, expect, it } from "vitest";
import type { BenchBuild, BenchManifest } from "../../types/bench";
import { codeModeArms, codeModeVerdict } from "../bench-code-mode";

const A = { provider: "openai", model: "g", effort: "high" };
const B = { provider: "ollama", model: "q", effort: "low" };

type Row = [caseId: string, engineId: string, resolved: boolean | null, cost?: number];

function run(builds: Row[]): BenchManifest {
	return {
		runId: "r",
		createdAt: "",
		phase: "done",
		engines: [
			{ ...A, id: "v1" },
			{ ...B, id: "v2" },
			{ ...A, id: "v3", codeMode: "on" },
			{ ...B, id: "v4", codeMode: "on" },
		],
		cases: [],
		builds: builds.map(
			([caseId, engineId, resolved, cost], i): BenchBuild => ({
				id: `b${i}`,
				caseId,
				engineId,
				taskId: `t${i}`,
				copy: "",
				state: resolved === null ? "skipped" : "judged",
				resolved: resolved ?? undefined,
				costUsd: cost ?? null,
				durationS: cost === undefined ? null : 600,
			}),
		),
	};
}

describe("bench code mode", () => {
	it("replays each engine without code mode, then with it", () => {
		expect(codeModeArms([A, { ...B, rule: "x" }], true)).toEqual([
			A,
			B,
			{ ...A, codeMode: "on" },
			{ ...B, codeMode: "on" },
		]);
		expect(codeModeArms([A], false)).toEqual([A]);
	});

	it("has nothing to say about a run without a code mode arm", () => {
		const plain = { ...run([]), engines: [{ ...A, id: "v1" }] };
		expect(codeModeVerdict(plain)).toBeNull();
	});

	it("is better when it resolves as much for less", () => {
		const verdict = codeModeVerdict(
			run([
				["c1", "v1", true, 1.0],
				["c1", "v3", true, 0.5],
				["c2", "v2", false],
				["c2", "v4", false],
			]),
		);
		expect(verdict).toMatchObject({
			pairs: 2,
			withoutResolved: 1,
			withResolved: 1,
			regressions: 0,
			withoutCostUsd: 1,
			withCostUsd: 0.5,
			verdict: "better",
		});
	});

	it("is worse on a single regression, whatever it saves", () => {
		const verdict = codeModeVerdict(
			run([
				["c1", "v1", true, 1.0],
				["c1", "v3", false, 0.1],
			]),
		);
		expect(verdict?.verdict).toBe("worse");
		expect(verdict?.regressions).toBe(1);
	});

	it("says same, or unmeasured when no card was judged in both arms", () => {
		expect(
			codeModeVerdict(
				run([
					["c1", "v1", true],
					["c1", "v3", true],
				]),
			)?.verdict,
		).toBe("same");
		expect(codeModeVerdict(run([["c1", "v3", true], ["c1", "v1", null]]))?.verdict).toBe(
			"unmeasured",
		);
	});
});
