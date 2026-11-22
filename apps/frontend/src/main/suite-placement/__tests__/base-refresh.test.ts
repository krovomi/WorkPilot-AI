/**
 * Lot F on real git repositories: after a merge, a green card takes the new
 * base (local or the remote's), then its suite runs on the CI or its QA here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { type BaseRefreshDeps, baseRef, greenCards, refreshCard, refreshGreenCards } from "../base-refresh";
import type { GitRun } from "../ci-suite";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.test",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.test",
	GIT_CONFIG_NOSYSTEM: "1",
	HOME: tmpdir(),
};

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

const git: GitRun = async (cwd, args) => run(cwd, ...args);

let root: string;
let origin: string;
let repo: string;
let worktree: string;
const task = {
	id: "t1",
	specId: "001-x",
	status: "human_review",
	qaSignoff: { status: "approved", session: 1 },
} as unknown as Task;
let project: Project;

function commit(cwd: string, file: string, text: string): void {
	writeFileSync(path.join(cwd, file), text, "utf-8");
	run(cwd, "add", file);
	run(cwd, "commit", "-q", "-m", `edit ${file}`);
}

function planPath(): string {
	return path.join(repo, ".workpilot", "specs", task.specId, "implementation_plan.json");
}

function plan(): Record<string, unknown> {
	return JSON.parse(readFileSync(planPath(), "utf-8"));
}

function deps(over: Partial<BaseRefreshDeps> = {}): BaseRefreshDeps {
	return {
		ciFollowed: () => false,
		rerunQa: vi.fn(async () => true),
		baseOf: () => "main",
		git,
		now: () => new Date("2026-11-22T10:00:00Z"),
		...over,
	};
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	root = mkdtempSync(path.join(tmpdir(), "base-refresh-"));
	origin = path.join(root, "origin.git");
	repo = path.join(root, "project");
	run(root, "init", "-q", "--bare", "-b", "main", origin);
	run(root, "clone", "-q", origin, repo);
	run(repo, "checkout", "-q", "-b", "main");
	writeFileSync(path.join(repo, ".gitignore"), ".workpilot/\n", "utf-8");
	commit(repo, "a.txt", "one\n");
	run(repo, "push", "-q", "-u", "origin", "main");
	worktree = path.join(repo, ".workpilot", "worktrees", "tasks", task.specId);
	run(repo, "worktree", "add", "-q", "-b", "workpilot/001-x", worktree, "main");
	commit(worktree, "task.txt", "task\n");
	mkdirSync(path.dirname(planPath()), { recursive: true });
	writeFileSync(
		planPath(),
		JSON.stringify({ qa_signoff: { status: "approved", timestamp: "2026-11-22T09:00:00Z" } }),
		"utf-8",
	);
	project = { id: "p1", name: "p", path: repo, autoBuildPath: ".workpilot", settings: {} } as unknown as Project;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("green cards", () => {
	it("are the approved cards in review, the merged one aside", () => {
		const tasks = [
			task,
			{ ...task, id: "t2", status: "pr_created" },
			{ ...task, id: "t3", status: "in_progress" },
			{ ...task, id: "t4", qaSignoff: { status: "rejected", session: 1 } },
			{ ...task, id: "t5", metadata: { prMergedAt: "x" } },
			{ ...task, id: "t6", stagedInMainProject: true },
		] as Task[];
		expect(greenCards(tasks, "t1").map((t) => t.id)).toEqual(["t2"]);
	});
});

describe("refreshing a card", () => {
	it("leaves a card already on the base alone", async () => {
		const d = deps();
		expect(await refreshCard(project, task, d)).toBe("up_to_date");
		expect(d.rerunQa).not.toHaveBeenCalled();
	});

	it("takes a merge made in the app and runs QA again here without a CI", async () => {
		commit(repo, "b.txt", "merged in the app\n");
		const d = deps();
		expect(await refreshCard(project, task, d)).toBe("qa");
		expect(existsSync(path.join(worktree, "b.txt"))).toBe(true);
		expect(d.rerunQa).toHaveBeenCalledOnce();
		const after = plan();
		expect(after.qa_signoff).toBeUndefined();
		expect(after.baseRefresh).toMatchObject({ state: "merged", base: "main", rerun: "qa" });
	});

	it("pushes to the CI when the project's CI is followed, without a model call", async () => {
		commit(repo, "b.txt", "merged\n");
		const d = deps({ ciFollowed: () => true });
		expect(await refreshCard(project, task, d)).toBe("ci");
		expect(d.rerunQa).not.toHaveBeenCalled();
		const head = run(worktree, "rev-parse", "HEAD").trim();
		expect(run(origin, "rev-parse", "refs/heads/workpilot/001-x").trim()).toBe(head);
		const after = plan();
		expect(after.ciSuite).toMatchObject({
			state: "pending",
			branch: "workpilot/001-x",
			sha: head,
			signoffAt: "2026-11-22T09:00:00Z",
		});
		expect(after.qa_signoff).toBeDefined();
	});

	it("takes the remote's base when a pull request was merged on the forge", async () => {
		const other = path.join(root, "other");
		run(root, "clone", "-q", origin, other);
		commit(other, "c.txt", "merged on the forge\n");
		run(other, "push", "-q", "origin", "main");
		expect(await baseRef(git, worktree, "main")).toBe("origin/main");
		expect(await refreshCard(project, task, deps())).toBe("qa");
		expect(existsSync(path.join(worktree, "c.txt"))).toBe(true);
	});

	it("aborts a conflicting base and records it", async () => {
		commit(worktree, "a.txt", "task side\n");
		commit(repo, "a.txt", "base side\n");
		const d = deps();
		expect(await refreshCard(project, task, d)).toBe("conflict");
		expect(run(worktree, "status", "--porcelain").trim()).toBe("");
		expect(plan().baseRefresh).toMatchObject({ state: "conflict", base: "main" });
		expect(plan().qa_signoff).toBeDefined();
		expect(d.rerunQa).not.toHaveBeenCalled();
	});

	it("never touches a worktree with uncommitted changes", async () => {
		commit(repo, "b.txt", "merged\n");
		writeFileSync(path.join(worktree, "wip.txt"), "wip\n", "utf-8");
		expect(await refreshCard(project, task, deps())).toBe("dirty");
		expect(existsSync(path.join(worktree, "b.txt"))).toBe(false);
	});

	it("skips a card without a worktree or with a base that is not a branch name", async () => {
		expect(await refreshCard(project, { ...task, specId: "002-none" } as Task, deps())).toBe("skipped");
		expect(await refreshCard(project, task, deps({ baseOf: () => "-x" }))).toBe("skipped");
		expect(await refreshCard(project, task, deps({ baseOf: () => "a..b" }))).toBe("skipped");
	});

	it("goes on with the other cards when one fails", async () => {
		commit(repo, "b.txt", "merged\n");
		const failing = deps({
			rerunQa: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		expect(await refreshGreenCards(project, [task], null, failing)).toEqual({ "001-x": "skipped" });
	});
});
