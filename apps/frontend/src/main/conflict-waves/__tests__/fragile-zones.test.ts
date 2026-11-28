/**
 * Fragile zones (#358, lot 2): files a real git history changes together,
 * read by argument list and bounded, and how they reach a pair's score.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import {
	buildCoChangeIndex,
	MAX_FILES_PER_COMMIT,
	MIN_CO_CHANGES,
	parseLog,
	readCoChanges,
} from "../fragile-zones";
import { type PlannerTask, planExecutionWaves } from "../planner";
import { buildFootprint, fragileLinks, MAX_FRAGILE_WEIGHT } from "../scorer";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

let root: string;
let project: string;

function commit(files: string[], message: string): void {
	for (const file of files) {
		mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
		writeFileSync(path.join(project, file), `${message}\n`);
	}
	git(project, "add", ...files);
	git(project, "commit", "-q", "-m", message);
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "fragile-"));
	project = path.join(root, "project");
	mkdirSync(project);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "user.name", "Test");
	git(project, "config", "commit.gpgsign", "false");
	for (let i = 0; i < MIN_CO_CHANGES; i++) {
		commit(["db/schema.sql", "db/Migrations/0001.cs"], `schema ${i}`);
	}
	commit(["db/schema.sql", "lib/once.ex"], "once");
	// A sweeping commit says nothing about coupling.
	commit(
		Array.from({ length: MAX_FILES_PER_COMMIT + 1 }, (_, i) => `sweep/f${i}.txt`),
		"reformat",
	);
	commit(["odd name with spaces.md", "db/schema.sql"], "spaces");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readCoChanges", () => {
	it("couples files changed together often enough, from the history", async () => {
		const result = await readCoChanges(project);
		expect(result?.commits).toBe(MIN_CO_CHANGES + 3);
		expect(result?.index.get("db/schema.sql")).toEqual(new Set(["db/migrations/0001.cs"]));
		expect(result?.index.get("db/migrations/0001.cs")).toEqual(new Set(["db/schema.sql"]));
		expect(result?.index.has("lib/once.ex")).toBe(false);
		expect(result?.index.has("sweep/f0.txt")).toBe(false);
	});

	it("answers null outside a repository", async () => {
		const plain = path.join(root, "plain");
		mkdirSync(plain);
		expect(await readCoChanges(plain)).toBeNull();
	});
});

describe("parseLog / buildCoChangeIndex", () => {
	it("parses commits and paths, whatever they contain", () => {
		expect(parseLog("\u001e\0\na b.md\0c\\d.cs\0\u001e\0\nx\0")).toEqual([["a b.md", "c\\d.cs"], ["x"]]);
		expect(parseLog("")).toEqual([]);
	});

	it("ignores a commit with one file and paths that normalize to nothing", () => {
		const commits = Array.from({ length: MIN_CO_CHANGES }, () => ["./A.txt", "a.txt", " "]);
		expect(buildCoChangeIndex(commits).size).toBe(0);
	});
});

describe("fragileLinks", () => {
	const index = buildCoChangeIndex(
		Array.from({ length: MIN_CO_CHANGES }, () => ["api/Orders.proto", "server/orders.go", "web/orders.ts"]),
	);

	it("links a file of each spec the history changes together, not a shared one", () => {
		const a = buildFootprint(["api/Orders.proto", "shared.yaml", "lonely.txt"]);
		const b = buildFootprint(["server/orders.go", "shared.yaml", "unrelated.rb"]);
		expect(fragileLinks(a, b, index)).toEqual(["api/Orders.proto ↔ server/orders.go"]);
		// The other spec has one of them: it is shared, already scored.
		const both = buildFootprint(["api/orders.proto", "server/orders.go"]);
		expect(fragileLinks(both, buildFootprint(["server/orders.go"]), index)).toEqual([]);
		expect(fragileLinks(both, buildFootprint(["web/orders.ts"]), index)).toEqual([
			"api/orders.proto ↔ web/orders.ts",
			"server/orders.go ↔ web/orders.ts",
		]);
	});

	it("adds the links to the score, capped, and to the running conflicts", () => {
		const many = buildCoChangeIndex(
			Array.from({ length: MIN_CO_CHANGES }, () => ["a1", "a2", "a3", "a4", "b1"]),
		);
		const task = (id: string, files: string[], extra: Partial<PlannerTask> = {}): PlannerTask => ({
			id,
			title: id,
			status: "backlog",
			priorityWeight: 0,
			createdAtMs: 0,
			blockedBy: [],
			plannedFiles: files,
			actualFiles: null,
			...extra,
		});
		const result = planExecutionWaves(
			[task("a", ["a1", "a2", "a3", "a4"]), task("b", ["b1"])],
			[task("r", ["a1"], { status: "in_progress" })],
			{ maxParallel: 3, tolerance: 0, unplannedPolicy: "isolate", driftThreshold: 3, coChanges: many },
		);
		expect(result.pairs[0]).toMatchObject({ score: MAX_FRAGILE_WEIGHT, blocking: true });
		expect(result.pairs[0].fragileLinks).toHaveLength(4);
		expect(result.waves).toHaveLength(2);
		// `a` shares a1 with the running spec; `b` edits what the history changes with a1.
		expect(result.runningConflicts).toEqual([
			{ taskId: "a", runningTaskId: "r", score: 1 },
			{ taskId: "b", runningTaskId: "r", score: 1 },
		]);
	});
});
