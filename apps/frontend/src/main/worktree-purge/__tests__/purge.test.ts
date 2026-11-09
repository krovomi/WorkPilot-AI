/**
 * Purging frees the worktrees whose work is over and nothing else: never a
 * card still in progress, never uncommitted changes, never the branch a
 * stacked card still sits on.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../utils/worktree-cleanup", () => ({ cleanupWorktree: vi.fn() }));
vi.mock("../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import {
	directorySize,
	listPurgeCandidates,
	mergedSpecIds,
	type PurgeDeps,
	purgeReason,
	purgeWorktrees,
} from "../purge";

let root: string;
let project: Project;
let deps: PurgeDeps & {
	isDirty: Mock<PurgeDeps["isDirty"]>;
	remove: Mock<PurgeDeps["remove"]>;
};

const task = (specId: string, extra: Partial<Task> = {}): Task =>
	({ id: specId, specId, title: `Card ${specId}`, status: "done", metadata: {}, ...extra }) as unknown as Task;
const worktree = (specId: string) => path.join(root, ".workpilot", "worktrees", "tasks", specId);
const makeWorktree = (specId: string) => {
	mkdirSync(worktree(specId), { recursive: true });
	writeFileSync(path.join(worktree(specId), "file.txt"), "x".repeat(100));
};

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "purge-"));
	project = { id: "p1", path: root } as unknown as Project;
	deps = {
		isDirty: vi.fn<PurgeDeps["isDirty"]>(async () => false),
		sizeOf: directorySize,
		remove: vi.fn<PurgeDeps["remove"]>(async (_p, _t, dir) => {
			rmSync(dir, { recursive: true, force: true });
			return { success: true };
		}),
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("purgeReason", () => {
	it("names why a card's work is over, and nothing while it goes on", () => {
		expect(purgeReason(task("a", { metadata: { prMergedAt: "x" } } as Partial<Task>))).toBe("merged");
		expect(purgeReason(task("a", { status: "human_review", metadata: { archivedAt: "x" } } as Partial<Task>))).toBe("archived");
		expect(purgeReason(task("a", { status: "backlog", metadata: { abandoned: true } } as Partial<Task>))).toBe("abandoned");
		expect(purgeReason(task("a"))).toBe("done");
		for (const status of ["human_review", "pr_created", "in_progress", "backlog", "error"]) {
			expect(purgeReason(task("a", { status } as Partial<Task>))).toBeNull();
		}
	});
});

describe("listPurgeCandidates", () => {
	it("lists the finished cards' worktrees with their size, and marks uncommitted ones", async () => {
		makeWorktree("001-done");
		makeWorktree("002-review");
		makeWorktree("003-dirty");
		deps.isDirty.mockImplementation(async (dir: string) => dir.endsWith("003-dirty"));
		const tasks = [task("001-done"), task("002-review", { status: "human_review" } as Partial<Task>), task("003-dirty"), task("004-no-worktree")];

		const candidates = await listPurgeCandidates(project, tasks, deps);

		expect(candidates.map((c) => [c.specId, c.reason, c.bytes, c.dirty])).toEqual([
			["001-done", "done", 100, false],
			["003-dirty", "done", 100, true],
		]);
	});

	it("keeps a card another card is still stacked on", async () => {
		makeWorktree("001-base");
		const tasks = [
			task("001-base"),
			task("002-child", { status: "human_review", metadata: { stackParent: "001-base" } } as Partial<Task>),
		];
		expect(await listPurgeCandidates(project, tasks, deps)).toEqual([]);
	});

	it("leaves server cards and a link in place of a worktree alone", async () => {
		mkdirSync(path.join(root, ".workpilot", "worktrees", "tasks"), { recursive: true });
		const elsewhere = mkdtempSync(path.join(tmpdir(), "purge-elsewhere-"));
		symlinkSync(elsewhere, worktree("001-link"), "dir");
		const tasks = [task("001-link"), task("server:abc")];
		expect(await listPurgeCandidates(project, tasks, deps)).toEqual([]);
		rmSync(elsewhere, { recursive: true, force: true });
	});
});

describe("purgeWorktrees", () => {
	it("removes the chosen worktrees and reports the room freed", async () => {
		makeWorktree("001-done");
		const outcomes = await purgeWorktrees(project, [task("001-done")], ["001-done"], deps);
		expect(outcomes).toEqual([{ specId: "001-done", purged: true, bytes: 100 }]);
		expect(deps.remove).toHaveBeenCalledWith(project, expect.objectContaining({ specId: "001-done" }), worktree("001-done"));
	});

	it("checks each one again: dirty, in progress or unknown ones stay", async () => {
		makeWorktree("001-dirty");
		makeWorktree("002-review");
		deps.isDirty.mockImplementation(async (dir: string) => dir.endsWith("001-dirty"));
		const tasks = [task("001-dirty"), task("002-review", { status: "human_review" } as Partial<Task>)];

		const outcomes = await purgeWorktrees(project, tasks, ["001-dirty", "002-review", "../../etc"], deps);

		expect(outcomes.map((o) => [o.specId, o.purged, o.error])).toEqual([
			["001-dirty", false, "dirty"],
			["002-review", false, "not_purgeable"],
			["../../etc", false, "not_purgeable"],
		]);
		expect(deps.remove).not.toHaveBeenCalled();
	});

	it("says when the removal failed", async () => {
		makeWorktree("001-done");
		deps.remove.mockResolvedValueOnce({ success: false, error: "locked" });
		const [outcome] = await purgeWorktrees(project, [task("001-done")], ["001-done"], deps);
		expect(outcome).toMatchObject({ purged: false, error: "failed", message: "locked" });
	});
});

describe("mergedSpecIds", () => {
	it("names only the merged cards that still have a worktree", () => {
		makeWorktree("001-merged");
		makeWorktree("002-done");
		const tasks = [
			task("001-merged", { metadata: { prMergedAt: "2026-11-09" } } as Partial<Task>),
			task("002-done"),
			task("003-merged-gone", { metadata: { prMergedAt: "2026-11-09" } } as Partial<Task>),
		];
		expect(mergedSpecIds(project, tasks)).toEqual(["001-merged"]);
	});
});
