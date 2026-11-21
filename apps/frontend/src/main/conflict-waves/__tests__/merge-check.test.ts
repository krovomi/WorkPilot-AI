/**
 * The preventive merge check (#358, lot 2): a test merge of two worktrees'
 * commits in a real git repository, nothing written to a worktree or a
 * branch, and the loop that splits a pair and plans again, bounded in pairs
 * and in time.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import {
	gitTestMerge,
	MAX_MERGE_CHECKS,
	MERGE_CHECK_BUDGET_MS,
	type MergeCheckDeps,
	planWithMergeChecks,
	readWorktreeHead,
} from "../merge-check";
import { type MergeOutcome, type PlannerTask, pairKey, planExecutionWaves } from "../planner";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

let root: string;
let project: string;
const worktree = (spec: string) => path.join(project, ".workpilot", "worktrees", "tasks", spec);

function commitIn(dir: string, file: string, content: string): void {
	writeFileSync(path.join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", file);
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "merge-check-"));
	project = path.join(root, "project");
	mkdirSync(project);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "user.name", "Test");
	git(project, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(project, ".gitignore"), ".workpilot/\n");
	git(project, "add", ".gitignore");
	commitIn(project, "config.yaml", "a: 1\nb: 2\nc: 3\n");
	for (const spec of ["001-left", "002-right", "003-apart"]) {
		git(project, "worktree", "add", "-q", "-b", `workpilot/${spec}`, worktree(spec));
	}
	commitIn(worktree("001-left"), "config.yaml", "a: 1\nb: left\nc: 3\n");
	commitIn(worktree("002-right"), "config.yaml", "a: 1\nb: right\nc: 3\n");
	commitIn(worktree("003-apart"), "other.yaml", "x: 1\n");

	const orphan = worktree("004-orphan");
	git(project, "worktree", "add", "-q", "--detach", orphan);
	git(orphan, "checkout", "-q", "--orphan", "workpilot/004-orphan");
	git(orphan, "rm", "-q", "-rf", ".");
	commitIn(orphan, "alone.txt", "x\n");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readWorktreeHead", () => {
	it("gives the commit a task's worktree is on", async () => {
		expect(await readWorktreeHead(project, "001-left")).toBe(git(worktree("001-left"), "rev-parse", "HEAD"));
	});

	it("answers null for a task without a worktree or a spec id that leaves the project", async () => {
		expect(await readWorktreeHead(project, "009-none")).toBeNull();
		expect(await readWorktreeHead(project, "../../../..")).toBeNull();
	});

	it("answers null when git cannot read the worktree", async () => {
		const broken = worktree("005-broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(path.join(broken, ".git"), "gitdir: /nowhere\n");
		expect(await readWorktreeHead(project, "005-broken")).toBeNull();
	});
});

describe("gitTestMerge", () => {
	const head = (spec: string) => git(worktree(spec), "rev-parse", "HEAD");
	const refs = () => git(project, "for-each-ref", "--format=%(refname) %(objectname)");

	it("finds a real textual conflict and names its files, touching no branch or worktree", async () => {
		const before = refs();
		const outcome = await gitTestMerge(project, head("001-left"), head("002-right"), 10_000);
		expect(outcome).toEqual({ verdict: "conflict", files: ["config.yaml"] });
		expect(refs()).toBe(before);
		expect(git(worktree("001-left"), "status", "--porcelain")).toBe("");
		expect(git(project, "status", "--porcelain")).toBe("");
	});

	it("says clean when the two merge without conflict", async () => {
		expect(await gitTestMerge(project, head("001-left"), head("003-apart"), 10_000)).toEqual({
			verdict: "clean",
			files: [],
		});
	});

	it("gives no answer for unrelated histories", async () => {
		expect(await gitTestMerge(project, head("001-left"), head("004-orphan"), 10_000)).toBeNull();
	});

	it("gives no answer for an unknown commit", async () => {
		expect(await gitTestMerge(project, head("001-left"), "f".repeat(40), 10_000)).toBeNull();
	});

	it.each([
		["a branch name", "main"],
		["an option", "--output=/tmp/x"],
		["a short id", "abc123"],
	])("never hands git %s", async (_name, value) => {
		expect(await gitTestMerge(project, value, head("001-left"), 10_000)).toBeNull();
		expect(await gitTestMerge(project, head("001-left"), value, 10_000)).toBeNull();
	});
});

let clock = 0;
function plannerTask(id: string, files: string[]): PlannerTask {
	clock += 1;
	return {
		id,
		title: id,
		status: "backlog",
		priorityWeight: 0,
		createdAtMs: clock,
		blockedBy: [],
		plannedFiles: files,
		actualFiles: [],
	};
}

/** Every task shares `shared.ts`: with tolerance 1, all of them fit in one wave. */
function planner(ids: string[], maxParallel = 8) {
	const tasks = ids.map((id) => plannerTask(id, ["shared.ts", `${id}.ts`]));
	const plans: Array<ReadonlyMap<string, MergeOutcome>> = [];
	const plan = (checks: ReadonlyMap<string, MergeOutcome>) => {
		plans.push(new Map(checks));
		return planExecutionWaves(tasks, [], {
			maxParallel,
			tolerance: 1,
			unplannedPolicy: "isolate",
			driftThreshold: 3,
			mergeChecks: checks,
		});
	};
	return { plan, plans };
}

const withWorktrees = (ids: string[]) => new Map(ids.map((id) => [id, `spec-${id}`]));

function deps(conflicting: string[][] = [], extra: Partial<MergeCheckDeps> = {}): MergeCheckDeps {
	const bad = new Set(conflicting.map(([a, b]) => pairKey(`head-${a}`, `head-${b}`)));
	return {
		worktreeHead: vi.fn(async (_project: string, spec: string) => `head-${spec.slice(5)}`),
		testMerge: vi.fn(async (_project: string, a: string, b: string) =>
			bad.has(pairKey(a, b)) ? { verdict: "conflict" as const, files: ["shared.ts"] } : { verdict: "clean" as const, files: [] },
		),
		clock: () => 0,
		...extra,
	};
}

const waves = (result: { waves: Array<{ taskIds: string[] }> }) => result.waves.map((w) => [...w.taskIds].sort());

describe("planWithMergeChecks", () => {
	it("splits a pair whose test merge conflicts and says why", async () => {
		const { plan } = planner(["a", "b", "c"]);
		const d = deps([["a", "b"]]);
		const { result, mergeChecks } = await planWithMergeChecks(plan, "/projects/shop", withWorktrees(["a", "b", "c"]), d);
		const waveOf = (id: string) => result.waves.findIndex((w) => w.taskIds.includes(id));
		expect(waveOf("a")).not.toBe(waveOf("b"));
		const pair = result.pairs.find((p) => pairKey(p.a, p.b) === pairKey("a", "b"));
		expect(pair).toMatchObject({ blocking: true, mergeCheck: "conflict", conflictFiles: ["shared.ts"] });
		expect(mergeChecks).toMatchObject({ conflicts: 1, unchecked: 0, failed: 0 });
		expect(mergeChecks.checked).toBeGreaterThanOrEqual(2);
		// Heads are read once per task and passed with the project path.
		expect(d.worktreeHead).toHaveBeenCalledTimes(3);
		expect(d.testMerge).toHaveBeenCalledWith("/projects/shop", expect.any(String), expect.any(String), 8_000);
	});

	it("keeps a wave whose pairs all merge cleanly", async () => {
		const { plan, plans } = planner(["a", "b"]);
		const { result, mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(["a", "b"]), deps());
		expect(waves(result)).toEqual([["a", "b"]]);
		expect(result.pairs[0]).toMatchObject({ mergeCheck: "clean", conflictFiles: [], blocking: false });
		expect(mergeChecks).toEqual({ checked: 1, conflicts: 0, unchecked: 0, failed: 0 });
		// Planned once, then once more to carry the verdict: same waves.
		expect(plans.map((p) => p.size)).toEqual([0, 1]);
	});

	it("checks only pairs where both specs have a worktree", async () => {
		const { plan } = planner(["a", "b", "c"]);
		const d = deps();
		const { mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(["a", "b"]), d);
		expect(mergeChecks.checked).toBe(1);
		expect(d.worktreeHead).not.toHaveBeenCalledWith("/p", "spec-c");
	});

	it("counts pairs git cannot answer for, and a worktree without a head", async () => {
		const { plan } = planner(["a", "b", "c"]);
		const d = deps([], {
			worktreeHead: vi.fn(async (_p: string, spec: string) => (spec === "spec-c" ? null : `head-${spec}`)),
			testMerge: vi.fn(async () => null),
		});
		const { result, mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(["a", "b", "c"]), d);
		expect(mergeChecks).toEqual({ checked: 0, conflicts: 0, unchecked: 0, failed: 3 });
		expect(waves(result)).toEqual([["a", "b", "c"]]);
		// No commit for c: git is never asked about its pairs.
		expect(d.testMerge).toHaveBeenCalledTimes(1);
	});

	it("stops at the pair limit and reports what is left", async () => {
		const ids = Array.from({ length: 9 }, (_, i) => `t${i}`);
		const { plan } = planner(ids, 9);
		const { mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(ids), deps());
		expect(mergeChecks.checked).toBe(MAX_MERGE_CHECKS);
		expect(mergeChecks.unchecked).toBe((9 * 8) / 2 - MAX_MERGE_CHECKS);
	});

	it("stops when the time budget is spent, and bounds each git call by what is left", async () => {
		let now = 0;
		const { plan } = planner(["a", "b", "c"]);
		const d = deps([], {
			clock: () => now,
			testMerge: vi.fn(async () => {
				now += MERGE_CHECK_BUDGET_MS - 1_000;
				return { verdict: "clean" as const, files: [] };
			}),
		});
		const { mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(["a", "b", "c"]), d);
		expect(mergeChecks).toEqual({ checked: 2, conflicts: 0, unchecked: 1, failed: 0 });
		expect(d.testMerge).toHaveBeenLastCalledWith("/p", expect.any(String), expect.any(String), 1_000);
	});

	it("does not check again after the limit even when a conflict calls for a new plan", async () => {
		const ids = Array.from({ length: 8 }, (_, i) => `t${i}`);
		const { plan } = planner(ids, 8);
		// The very last allowed check conflicts: the plan is redone, nothing more is checked.
		let calls = 0;
		const d = deps([], {
			testMerge: vi.fn(async () => {
				calls++;
				return calls === MAX_MERGE_CHECKS
					? { verdict: "conflict" as const, files: ["shared.ts"] }
					: { verdict: "clean" as const, files: [] };
			}),
		});
		const { mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(ids), d);
		expect(d.testMerge).toHaveBeenCalledTimes(MAX_MERGE_CHECKS);
		expect(mergeChecks.conflicts).toBe(1);
	});

	it("uses the system clock by default", async () => {
		const { plan } = planner(["a", "b"]);
		const { clock: _unused, ...rest } = deps();
		const { mergeChecks } = await planWithMergeChecks(plan, "/p", withWorktrees(["a", "b"]), rest);
		expect(mergeChecks.checked).toBe(1);
	});
});
