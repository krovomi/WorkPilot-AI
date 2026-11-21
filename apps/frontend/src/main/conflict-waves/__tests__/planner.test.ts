/**
 * The wave planner (#358), table-tested: pure, deterministic, any language.
 */
import { describe, expect, it } from "vitest";
import { type PlannerOptions, type PlannerTask, pairKey, planExecutionWaves } from "../planner";
import { buildFootprint, fileWeight, riskLevel } from "../scorer";

const OPTIONS: PlannerOptions = {
	maxParallel: 3,
	tolerance: 0,
	unplannedPolicy: "isolate",
	driftThreshold: 3,
};

let clock = 0;
function task(id: string, files: string[], extra: Partial<PlannerTask> = {}): PlannerTask {
	clock += 1;
	return {
		id,
		title: id.toUpperCase(),
		status: "backlog",
		priorityWeight: 0,
		createdAtMs: clock,
		blockedBy: [],
		plannedFiles: files,
		actualFiles: null,
		...extra,
	};
}

function waves(result: ReturnType<typeof planExecutionWaves>): string[][] {
	return result.waves.map((w) => [...w.taskIds].sort());
}

describe("fileWeight", () => {
	it.each([
		["src/app/main.ts", 1],
		["services/Billing/Invoice.cs", 1],
		["lib/billing.ex", 1],
		["package.json", 3],
		["apps/web/pnpm-lock.yaml", 3],
		["go.mod", 3],
		["cargo.toml", 3],
		["src/shop.api/shop.api.csproj", 3],
		["requirements-dev.txt", 3],
		["pubspec.yaml", 3],
		["gemfile.lock", 3],
		["vite.config.ts", 2],
		[".github/workflows/ci.yml", 2],
		["config/app.yaml", 2],
		["appsettings.development.json", 2],
	])("%s weighs %d", (file, weight) => {
		expect(fileWeight(file)).toBe(weight);
	});

	it.each([
		[0, "none"],
		[1, "low"],
		[3, "medium"],
		[5, "high"],
		[9, "critical"],
	] as const)("score %d is %s", (score, level) => {
		expect(riskLevel(score)).toBe(level);
	});
});

describe("buildFootprint", () => {
	it("skips blanks and keeps the first spelling of a path", () => {
		const footprint = buildFootprint(["", "  ", "Src\\A.cs"], ["src/a.cs", "./src/b.cs"]);
		expect([...footprint]).toEqual([
			["src/a.cs", "Src/A.cs"],
			["src/b.cs", "./src/b.cs"],
		]);
	});
});

describe("planExecutionWaves", () => {
	const cases: Array<{
		name: string;
		tasks: PlannerTask[];
		options?: Partial<PlannerOptions>;
		expected: string[][];
	}> = [
		{
			name: "independent specs share one wave",
			tasks: [task("a", ["src/a.py"]), task("b", ["web/b.tsx"]), task("c", ["svc/C.cs"])],
			expected: [["a", "b", "c"]],
		},
		{
			name: "a shared file splits two specs",
			tasks: [task("a", ["src/x.go"]), task("b", ["src/x.go"]), task("c", ["src/y.go"])],
			expected: [["a", "c"], ["b"]],
		},
		{
			name: "paths compare without case, slashes or ./",
			tasks: [task("a", ["Src\\Shop\\Cart.java"]), task("b", ["./src/shop/cart.java"])],
			expected: [["a"], ["b"]],
		},
		{
			name: "a wave never exceeds the max parallelism",
			tasks: [task("a", ["1"]), task("b", ["2"]), task("c", ["3"]), task("d", ["4"])],
			options: { maxParallel: 2 },
			expected: [
				["a", "b"],
				["c", "d"],
			],
		},
		{
			name: "a pair at or under the tolerance shares a wave",
			tasks: [task("a", ["src/x.rb"]), task("b", ["src/x.rb"])],
			options: { tolerance: 1 },
			expected: [["a", "b"]],
		},
		{
			name: "a lockfile is above a tolerance of one file",
			tasks: [task("a", ["Cargo.lock"]), task("b", ["cargo.lock"])],
			options: { tolerance: 1 },
			expected: [["a"], ["b"]],
		},
		{
			name: "a blocker runs in an earlier wave",
			tasks: [task("b", ["2"], { blockedBy: ["a"] }), task("a", ["1"])],
			expected: [["a"], ["b"]],
		},
		{
			name: "an unplanned spec runs alone by default",
			tasks: [task("a", ["1"]), task("b", []), task("c", ["3"])],
			expected: [["a", "c"], ["b"]],
		},
		{
			name: "an unplanned spec may be assumed independent",
			tasks: [task("a", ["1"]), task("b", []), task("c", ["3"])],
			options: { unplannedPolicy: "independent" },
			expected: [["a", "b", "c"]],
		},
		{
			name: "worktree changes count as much as the plan",
			tasks: [task("a", ["src/a.kt"], { actualFiles: ["src/shared.kt"] }), task("b", ["src/shared.kt"])],
			expected: [["a"], ["b"]],
		},
		{
			name: "a triangle of conflicts takes three waves",
			tasks: [task("a", ["x", "y"]), task("b", ["y", "z"]), task("c", ["z", "x"])],
			expected: [["a"], ["b"], ["c"]],
		},
	];

	it.each(cases)("$name", ({ tasks, options, expected }) => {
		const result = planExecutionWaves(tasks, [], { ...OPTIONS, ...options });
		expect(waves(result)).toEqual(expected.map((w) => [...w].sort()));
		expect(result.order.sort()).toEqual(expected.flat().sort());
	});

	it("is deterministic whatever the input order", () => {
		const tasks = [
			task("a", ["src/x.php", "composer.json"]),
			task("b", ["src/x.php"]),
			task("c", ["composer.json"]),
			task("d", ["src/z.php"]),
			task("e", []),
		];
		const first = planExecutionWaves(tasks, [], OPTIONS);
		const second = planExecutionWaves([...tasks].reverse(), [], OPTIONS);
		expect(second.waves).toEqual(first.waves);
		expect(second.pairs).toEqual(first.pairs);
	});

	it("places the most constrained spec first and reports the risk avoided", () => {
		const hub = task("hub", ["package.json", "src/a.ts", "src/b.ts"]);
		const result = planExecutionWaves(
			[task("a", ["src/a.ts"]), task("b", ["src/b.ts"]), hub],
			[],
			OPTIONS,
		);
		expect(result.waves[0].taskIds).toEqual(["hub"]);
		expect(waves(result)[1]).toEqual(["a", "b"]);
		expect(result.totalRisk).toBe(2);
		expect(result.residualRisk).toBe(0);
	});

	it("merges first the spec that shares most with the next waves", () => {
		const result = planExecutionWaves(
			[
				task("light", ["src/l.swift"]),
				task("heavy", ["Package.swift", "src/h.swift"]),
				task("next", ["package.swift"]),
			],
			[],
			{ ...OPTIONS, tolerance: 0 },
		);
		expect(result.waves[0].taskIds).toEqual(["heavy", "light"]);
		expect(result.waves[1].taskIds).toEqual(["next"]);
	});

	it("keeps sub-tolerance pairs apart when another wave costs nothing", () => {
		const result = planExecutionWaves(
			[task("a", ["x", "y"]), task("b", ["x", "y"]), task("c", ["x"])],
			[],
			{ ...OPTIONS, tolerance: 1 },
		);
		// a–b scores 2 (blocking); c shares 1 with each: it goes with one of
		// them, and the residual risk is that single shared file.
		expect(result.waves).toHaveLength(2);
		expect(result.residualRisk).toBe(1);
	});

	it("reports a dependency cycle and leaves it, and what waits on it, unplanned", () => {
		const result = planExecutionWaves(
			[
				task("a", ["1"], { blockedBy: ["b"] }),
				task("b", ["2"], { blockedBy: ["a"] }),
				task("c", ["3"], { blockedBy: ["a"] }),
				task("d", ["4"]),
			],
			[],
			OPTIONS,
		);
		expect(result.cycles).toEqual([["a", "b"]]);
		expect(result.excluded).toEqual([
			{ taskId: "a", reason: "cycle" },
			{ taskId: "b", reason: "cycle" },
			{ taskId: "c", reason: "blocked_by_cycle" },
		]);
		expect(result.order).toEqual(["d"]);
	});

	it("reports every cycle, sorted, and every spec behind one", () => {
		const result = planExecutionWaves(
			[
				task("z", ["1"], { blockedBy: ["y"] }),
				task("y", ["2"], { blockedBy: ["z"] }),
				task("b", ["3"], { blockedBy: ["a"] }),
				task("a", ["4"], { blockedBy: ["b"] }),
				task("m", ["5"], { blockedBy: ["z"] }),
				task("c", ["6"], { blockedBy: ["a"] }),
				task("q", ["7"], { blockedBy: ["p"] }),
				task("p", ["8"], { blockedBy: ["q"] }),
			],
			[],
			OPTIONS,
		);
		expect(result.cycles).toEqual([
			["a", "b"],
			["p", "q"],
			["y", "z"],
		]);
		expect(result.excluded.map((e) => e.taskId)).toEqual(["a", "b", "c", "m", "p", "q", "y", "z"]);
		expect(result.waves).toEqual([]);
	});

	it("lists running conflicts by score, then by spec", () => {
		const running = task("run", ["package.json", "src/a.go", "src/b.go"], { status: "in_progress" });
		const result = planExecutionWaves(
			[task("q2", ["src/b.go"]), task("q1", ["src/a.go"]), task("q0", ["package.json"])],
			[running],
			OPTIONS,
		);
		expect(result.runningConflicts.map((c) => [c.taskId, c.score])).toEqual([
			["q0", 3],
			["q1", 1],
			["q2", 1],
		]);
	});

	it("ignores a blocker outside the plan and a task blocking itself", () => {
		const result = planExecutionWaves(
			[task("a", ["1"], { blockedBy: ["a", "gone"] }), task("b", ["2"])],
			[],
			OPTIONS,
		);
		expect(result.cycles).toEqual([]);
		expect(waves(result)).toEqual([["a", "b"]]);
	});

	it("reports a spec whose worktree drifted from its plan", () => {
		const running = task("run", ["src/a.dart"], {
			status: "in_progress",
			actualFiles: ["src/a.dart", "lib/b.dart", "lib/c.dart", "lib/d.dart"],
		});
		const small = task("small", ["src/x.dart"], { actualFiles: ["src/x.dart", "src/y.dart"] });
		const result = planExecutionWaves([small, task("q", ["lib/c.dart"])], [running], OPTIONS);
		expect(result.drift).toEqual([
			{ taskId: "run", extraCount: 3, extraFiles: ["lib/b.dart", "lib/c.dart", "lib/d.dart"] },
		]);
		// The running spec's real changes conflict with a queued one.
		expect(result.runningConflicts).toEqual([{ taskId: "q", runningTaskId: "run", score: 1 }]);
	});

	it("caps the listed files of a pair", () => {
		const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.c`);
		const result = planExecutionWaves([task("a", files), task("b", files)], [], OPTIONS);
		expect(result.pairs[0].score).toBe(30);
		expect(result.pairs[0].level).toBe("critical");
		expect(result.pairs[0].sharedFiles).toHaveLength(20);
	});

	it("handles an empty project", () => {
		const result = planExecutionWaves([], [], OPTIONS);
		expect(result.waves).toEqual([]);
		expect(result.totalRisk).toBe(0);
	});

	it("splits a pair whose test merge conflicted, even with no shared file in the plans", () => {
		const checks = new Map([
			[pairKey("b", "a"), { verdict: "conflict" as const, files: Array.from({ length: 25 }, (_, i) => `f${i}`) }],
		]);
		const result = planExecutionWaves([task("a", ["x.kt"]), task("b", ["y.kt"])], [], {
			...OPTIONS,
			mergeChecks: checks,
		});
		expect(waves(result)).toEqual([["a"], ["b"]]);
		expect(result.pairs).toEqual([
			expect.objectContaining({ score: 0, blocking: true, mergeCheck: "conflict" }),
		]);
		expect(result.pairs[0].conflictFiles).toHaveLength(20);
	});
});
