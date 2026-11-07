import { describe, expect, it } from "vitest";
import type { WorktreeDiffFile } from "../../types/task";
import {
	buildCommitRecords,
	finalizeGroups,
	findMovedBlocks,
	isViewed,
	latestQaNotes,
	patchHash,
	planRanges,
	planSubtasks,
	pruneViewed,
	setViewed,
} from "../review-groups";

const commits = ["c1", "c2", "c3", "c4"].map((hash) => ({ hash, subject: `subject ${hash}` }));

function file(path: string, patch: string): WorktreeDiffFile {
	return { path, status: "modified", additions: 1, deletions: 1, patch };
}

const BLOCK = ["const total = items.reduce(", "  (sum, item) => sum + item.price,", "  0,", ");"];

function patchOf(path: string, lines: string[]): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,4 @@\n${lines.join("\n")}`;
}

describe("planRanges", () => {
	it("gives each recorded subtask its own range", () => {
		const { ranges, approximate } = planRanges("base", commits, [
			{ hash: "c2", subtaskId: "s1", commitBefore: "base" },
			{ hash: "c4", subtaskId: "s2", commitBefore: "c3" },
		]);
		expect(approximate).toBe(false);
		expect(ranges).toEqual([
			{ kind: "subtask", from: "base", to: "c2", subtaskId: "s1" },
			// A commit between two sessions (QA fixer, a person) is its own group.
			{ kind: "commit", from: "c2", to: "c3", subject: "subject c3" },
			{ kind: "subtask", from: "c3", to: "c4", subtaskId: "s2" },
		]);
	});

	it("falls back on the previous record for builds that did not record the start", () => {
		const { ranges, approximate } = planRanges("base", commits, [
			{ hash: "c1", subtaskId: "s1" },
			{ hash: "c3", subtaskId: "s2" },
		]);
		expect(approximate).toBe(true);
		expect(ranges.map((r) => [r.kind, r.from, r.to, r.subtaskId])).toEqual([
			["subtask", "base", "c1", "s1"],
			["subtask", "c1", "c3", "s2"],
			["commit", "c3", "c4", undefined],
		]);
	});

	it("ignores a record whose commit is not on the branch any more", () => {
		const { ranges } = planRanges("base", commits.slice(0, 1), [
			{ hash: "gone", subtaskId: "s1", commitBefore: "base" },
		]);
		expect(ranges).toEqual([{ kind: "commit", from: "base", to: "c1", subject: "subject c1" }]);
	});
});

describe("plan and records parsing", () => {
	it("reads subtasks in plan order with their announced files", () => {
		const subtasks = planSubtasks({
			phases: [
				{ subtasks: [{ id: "s1", description: "Add route", files_to_modify: ["./src\\a.ts"] }] },
				{ subtasks: [{ id: "s2", title: "Tests", description: "Cover it", files_to_create: ["b.ts"] }, { nope: 1 }] },
			],
		});
		expect(subtasks).toEqual([
			{ id: "s1", title: "Add route", description: "Add route", files: ["src/a.ts"] },
			{ id: "s2", title: "Tests", description: "Cover it", files: ["b.ts"] },
		]);
		expect(planSubtasks(null)).toEqual([]);
	});

	it("reads old and new build_commits.json records", () => {
		expect(
			buildCommitRecords({
				commits: [{ hash: "a", subtask_id: "s1" }, { hash: "b", subtask_id: "s2", commit_before: "a" }, { hash: 3 }],
			}),
		).toEqual([
			{ hash: "a", subtaskId: "s1", commitBefore: undefined },
			{ hash: "b", subtaskId: "s2", commitBefore: "a" },
		]);
	});

	it("keeps the latest QA iteration's issues that name a file", () => {
		const notes = latestQaNotes({
			qa_iteration_history: [
				{ issues: [{ file: "old.ts", title: "old" }] },
				{ issues: [{ file: "./a.ts", line: "12", title: "Null deref", severity: "critical" }, { title: "no file" }] },
			],
		});
		expect(notes).toEqual([{ file: "a.ts", line: 12, title: "Null deref", severity: "critical" }]);
	});
});

describe("findMovedBlocks", () => {
	it("pairs a block moved from one file to another", () => {
		const moved = findMovedBlocks([
			file("a.ts", patchOf("a.ts", BLOCK.map((l) => `-${l}`))),
			file("b.ts", patchOf("b.ts", BLOCK.map((l) => `+    ${l}`))),
		]);
		expect(moved.get("b.ts")).toEqual([{ direction: "in", otherPath: "a.ts", lines: 4, preview: BLOCK[0] }]);
		expect(moved.get("a.ts")?.[0].direction).toBe("out");
	});

	it("does not pair a block changed while it moved", () => {
		const changed = [...BLOCK];
		changed[1] = "  (sum, item) => sum + item.price * item.quantity,";
		const moved = findMovedBlocks([
			file("a.ts", patchOf("a.ts", BLOCK.map((l) => `-${l}`))),
			file("b.ts", patchOf("b.ts", changed.map((l) => `+${l}`))),
		]);
		expect(moved.size).toBe(0);
	});

	it("does not call a re-indent in place a move", () => {
		const moved = findMovedBlocks([
			file("a.ts", patchOf("a.ts", [...BLOCK.map((l) => `-${l}`), ...BLOCK.map((l) => `+  ${l}`)])),
		]);
		expect(moved.size).toBe(0);
	});
});

describe("finalizeGroups", () => {
	const subtasks = [
		{ id: "s1", title: "Add the route", description: "GET /orders", files: ["api.ts"] },
		{ id: "s2", title: "Test it", description: "Cover the route", files: ["api.test.ts"] },
	];

	it("orders groups by plan, flags out-of-plan files and later changes, anchors QA notes", () => {
		const result = finalizeGroups(
			[
				{ range: { kind: "subtask", from: "base", to: "c1", subtaskId: "s1" }, files: [file("api.ts", "p1")] },
				{ range: { kind: "commit", from: "c1", to: "c2", subject: "fix lint" }, files: [file("api.ts", "p2")] },
				{ range: { kind: "subtask", from: "c2", to: "c3", subtaskId: "s2" }, files: [file("api.test.ts", "p3"), file("util.ts", "p4")] },
				{ files: [file("notes.md", "p5")] },
				{ range: { kind: "commit", from: "c3", to: "c4" }, files: [] },
			],
			subtasks,
			[
				{ file: "api.ts", line: 3, title: "Missing auth", severity: "major" },
				{ file: "elsewhere.ts", line: null, title: "Unrelated", severity: "minor" },
			],
			false,
		);
		expect(result.groups.map((g) => g.key)).toEqual(["subtask:s1:c1", "subtask:s2:c3", "commit:c2", "uncommitted"]);
		const [s1, s2, fix, uncommitted] = result.groups;
		expect(s1.title).toBe("Add the route");
		expect(s1.description).toBe("GET /orders");
		expect(s1.files[0].touchedLater).toEqual(["commit:c2"]);
		// The QA note goes to the last group that changed the file.
		expect(s1.files[0].qaNotes).toEqual([]);
		expect(fix.files[0].qaNotes.map((n) => n.title)).toEqual(["Missing auth"]);
		expect(fix.title).toBe("fix lint");
		expect(s2.files.find((f) => f.path === "util.ts")?.outOfPlan).toBe(true);
		expect(s2.files.find((f) => f.path === "api.test.ts")?.outOfPlan).toBe(false);
		expect(uncommitted.kind).toBe("uncommitted");
		expect(result.outOfPlan).toEqual(["notes.md", "util.ts"]);
		expect(result.unanchoredQa.map((n) => n.title)).toEqual(["Unrelated"]);
	});

	it("numbers the parts of a subtask recorded in separate ranges", () => {
		const result = finalizeGroups(
			[
				{ range: { kind: "subtask", from: "base", to: "c1", subtaskId: "s1" }, files: [file("api.ts", "p1")] },
				{ range: { kind: "commit", from: "c1", to: "c2" }, files: [file("x.ts", "p2")] },
				{ range: { kind: "subtask", from: "c2", to: "c3", subtaskId: "s1" }, files: [file("api.ts", "p3")] },
			],
			subtasks,
			[],
			true,
		);
		expect(result.approximate).toBe(true);
		expect(result.groups.filter((g) => g.subtaskId === "s1").map((g) => [g.part, g.parts])).toEqual([
			[1, 2],
			[2, 2],
		]);
	});
});

describe("viewed state", () => {
	const group = { key: "subtask:s1:c1" };
	const viewed = { path: "api.ts", hash: patchHash("patch one") };

	it("is lost when the patch changes", () => {
		const state = setViewed({}, group, viewed, true);
		expect(isViewed(state, group, viewed)).toBe(true);
		expect(isViewed(state, group, { path: "api.ts", hash: patchHash("patch two") })).toBe(false);
		expect(isViewed(setViewed(state, group, viewed, false), group, viewed)).toBe(false);
	});

	it("prunes entries that no longer match a file", () => {
		const state = { ...setViewed({}, group, viewed, true), "gone|x.ts": "1234" };
		const groups = [{ ...group, kind: "subtask" as const, title: "", description: "", files: [{ ...file("api.ts", "patch one"), ...viewed, outOfPlan: false, touchedLater: [], moved: [], qaNotes: [] }] }];
		expect(pruneViewed(state, groups)).toEqual({ "subtask:s1:c1|api.ts": viewed.hash });
	});
});
