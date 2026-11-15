/**
 * @vitest-environment node
 *
 * What the execution handlers share, on real files and real repositories:
 * whether a start needs Claude, the learning loop fed from a review verdict,
 * a legacy task migrated once to its own engine in every copy of its
 * metadata, the atomic write and the safe read, the event a start sends for
 * each state, and the checks before a build (profile manager, git, auth).
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	settings: undefined as Record<string, unknown> | undefined,
	xstate: undefined as string | undefined,
	found: {} as { task?: unknown; project?: unknown },
	hasValidAuth: true,
	initError: null as unknown,
	recordOutcome: vi.fn(),
	clearTask: vi.fn(),
	watch: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => state.settings }));
vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: () => "git",
	getToolPathAsync: async () => "git",
}));
vi.mock("../../../learning-loop-service", () => ({
	learningLoopService: { recordTaskOutcome: state.recordOutcome },
}));
vi.mock("../../../claude-profile-manager", () => ({
	initializeClaudeProfileManager: async () => {
		if (state.initError !== null) throw state.initError;
		return { hasValidAuth: () => state.hasValidAuth };
	},
}));
vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: state.watch } }));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		getCurrentState: () => state.xstate,
		clearTask: state.clearTask,
	},
}));
vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: state.logError },
}));

import type { Project, Task } from "../../../../shared/types";
import {
	atomicWriteFileSync,
	checkSubtasksCompletion,
	determineStartEvent,
	ensureProfileManagerInitialized,
	ensureTaskEngine,
	getPlanPaths,
	recordReviewVerdictForLearning,
	requiresClaudeAuth,
	safeReadFileSync,
	setupTaskExecution,
	validateTaskPrerequisites,
} from "../execution-utils";

let base = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-utils-"));
	state.settings = undefined;
	state.xstate = undefined;
	state.found = {};
	state.hasValidAuth = true;
	state.initError = null;
	vi.clearAllMocks();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const task = (over: Partial<Task> = {}): Task =>
	({
		id: "t1",
		specId: "001-x",
		status: "backlog",
		subtasks: [],
		...over,
	}) as Task;

const project = (over: Partial<Project> = {}): Project =>
	({ id: "p1", path: path.join(base, "project"), ...over }) as Project;

const silenceWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

describe("requiresClaudeAuth", () => {
	it("answers from the task's own engine when it has metadata", () => {
		expect(requiresClaudeAuth(task({ metadata: { provider: "anthropic" } }))).toBe(true);
		expect(requiresClaudeAuth(task({ metadata: { provider: "ollama" } }))).toBe(false);
		// One phase on Claude is enough.
		expect(
			requiresClaudeAuth(
				task({
					metadata: { provider: "ollama", phaseProviders: { qa: "claude" } } as Task["metadata"],
				}),
			),
		).toBe(true);
		// Without a provider of its own, the task takes the project's.
		expect(requiresClaudeAuth(task({ metadata: {} }), project({ settings: { provider: "openai" } } as never))).toBe(false);
	});

	it("falls back to the default provider in Settings without a task", () => {
		expect(requiresClaudeAuth()).toBe(true);
		state.settings = { selectedProvider: "Anthropic" };
		expect(requiresClaudeAuth()).toBe(true);
		state.settings = { selectedProvider: "claude" };
		expect(requiresClaudeAuth()).toBe(true);
		state.settings = { selectedProvider: "windsurf" };
		expect(requiresClaudeAuth()).toBe(false);
	});
});

describe("recordReviewVerdictForLearning", () => {
	const p = project();
	const t = task();

	it("records an approval when a reviewed task moves to done or to a PR", () => {
		recordReviewVerdictForLearning("human_review", "done", p, t);
		recordReviewVerdictForLearning("ai_review", "pr_created", p, t);
		expect(state.recordOutcome.mock.calls).toEqual([
			[p.path, "001-x", "approved"],
			[p.path, "001-x", "approved"],
		]);
	});

	it("records a rejection when the reviewer sends the task back", () => {
		for (const back of ["backlog", "queue", "in_progress"] as const) {
			recordReviewVerdictForLearning("human_review", back, p, t);
		}
		expect(state.recordOutcome).toHaveBeenCalledTimes(3);
		expect(state.recordOutcome).toHaveBeenLastCalledWith(
			p.path,
			"001-x",
			"rejected",
			"Human reviewer sent the task back for rework.",
		);
	});

	it("records nothing for any other move, and never throws", () => {
		recordReviewVerdictForLearning("in_progress", "done", p, t);
		recordReviewVerdictForLearning("ai_review", "backlog", p, t);
		expect(state.recordOutcome).not.toHaveBeenCalled();

		state.recordOutcome.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const warn = silenceWarn();
		expect(() => recordReviewVerdictForLearning("human_review", "done", p, t)).not.toThrow();
		expect(warn).toHaveBeenCalledWith(
			"[TASK_UPDATE_STATUS] Learning outcome recording failed:",
			expect.any(Error),
		);
		warn.mockRestore();
	});
});

describe("ensureTaskEngine", () => {
	const specDir = () => path.join(base, "project", ".workpilot", "specs", "001-x");

	it("leaves a task without metadata or with a locked engine alone", () => {
		expect(ensureTaskEngine(task(), project(), specDir())).toBe(false);
		const locked = task({ metadata: { engineLocked: true, provider: "ollama" } });
		expect(ensureTaskEngine(locked, project(), specDir())).toBe(false);
		expect(locked.metadata).toEqual({ engineLocked: true, provider: "ollama" });
	});

	it("locks a legacy task's engine in memory and in every copy of its metadata", () => {
		const dir = specDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "task_metadata.json"),
			JSON.stringify({ provider: "ollama", model: "claude-sonnet-4-5-20250929", note: "kept" }),
			"utf-8",
		);
		// A worktree copy of the spec, found by the task's own specsPath.
		const other = path.join(base, "elsewhere");
		mkdirSync(other);
		writeFileSync(path.join(other, "task_metadata.json"), "{}", "utf-8");
		// A copy whose file is empty is skipped, a broken one is reported.
		const empty = path.join(base, "project", ".workpilot", "specs", "001-x-empty");
		mkdirSync(empty);
		writeFileSync(path.join(empty, "task_metadata.json"), "", "utf-8");

		const t = task({
			specsPath: other,
			metadata: { provider: "ollama", model: "claude-sonnet-4-5-20250929" },
		} as Partial<Task>);
		const warn = silenceWarn();
		expect(ensureTaskEngine(t, project(), dir)).toBe(true);

		expect(t.metadata?.engineLocked).toBe(true);
		expect(t.metadata?.phaseProviders).toEqual({
			spec: "ollama",
			planning: "ollama",
			coding: "ollama",
			qa: "ollama",
		});
		// The dash-versioned Anthropic model does not survive on Ollama.
		expect(t.metadata?.model).not.toBe("claude-sonnet-4-5-20250929");

		const onDisk = JSON.parse(readFileSync(path.join(dir, "task_metadata.json"), "utf-8"));
		expect(onDisk).toMatchObject({ note: "kept", engineLocked: true, provider: "ollama" });
		expect(onDisk.model).toBe(t.metadata?.model);
		const copy = JSON.parse(readFileSync(path.join(other, "task_metadata.json"), "utf-8"));
		expect(copy.engineLocked).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"[TaskEngine] Task t1 now owns its engine:",
			"spec=ollama planning=ollama coding=ollama qa=ollama",
		);
		// No temporary file is left behind.
		expect(readdirSync(dir)).toEqual(["task_metadata.json"]);
		warn.mockRestore();
	});

	it("keeps a Claude model on a Claude phase, and survives a broken copy", () => {
		const dir = specDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "task_metadata.json"), "{ broken", "utf-8");
		const t = task({ metadata: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" } });
		const warn = silenceWarn();
		expect(ensureTaskEngine(t, project(), dir)).toBe(true);
		expect(t.metadata?.model).toBe("claude-sonnet-4-5-20250929");
		expect(warn).toHaveBeenCalledWith(`[TaskEngine] Failed to migrate ${dir}:`, expect.any(SyntaxError));
		expect(readFileSync(path.join(dir, "task_metadata.json"), "utf-8")).toBe("{ broken");
		warn.mockRestore();
	});
});

describe("atomicWriteFileSync and safeReadFileSync", () => {
	it("writes through a temporary file and reads it back", () => {
		const file = path.join(base, "plan.json");
		atomicWriteFileSync(file, '{"a":1}');
		expect(safeReadFileSync(file)).toBe('{"a":1}');
		expect(readdirSync(base)).toEqual(["plan.json"]);
	});

	it("removes the temporary file and rethrows when the rename fails", () => {
		// Renaming a file onto a folder fails on every platform.
		const target = path.join(base, "taken");
		mkdirSync(target);
		writeFileSync(path.join(target, "inside"), "x");
		expect(() => atomicWriteFileSync(target, "x")).toThrow();
		expect(readdirSync(base)).toEqual(["taken"]);
	});

	it("rethrows when even the temporary file cannot be written", () => {
		expect(() => atomicWriteFileSync(path.join(base, "no", "such", "dir.json"), "x")).toThrow();
	});

	it("answers null for a missing file quietly, and logs any other error", () => {
		expect(safeReadFileSync(path.join(base, "missing.json"))).toBeNull();
		expect(state.logError).not.toHaveBeenCalled();
		// Reading a folder is EISDIR, not ENOENT.
		expect(safeReadFileSync(base)).toBeNull();
		expect(state.logError).toHaveBeenCalledWith(
			`[safeReadFileSync] Error reading ${base}:`,
			expect.objectContaining({ code: "EISDIR" }),
		);
	});
});

describe("checkSubtasksCompletion", () => {
	it("counts the subtasks of every phase", () => {
		const plan = {
			phases: [
				{ subtasks: [{ status: "completed" }, { status: "pending" }] },
				{},
				{ subtasks: [{ status: "completed" }] },
			],
		};
		expect(checkSubtasksCompletion(plan)).toMatchObject({
			completedCount: 2,
			totalCount: 3,
			allCompleted: false,
		});
		expect(
			checkSubtasksCompletion({ phases: [{ subtasks: [{ status: "completed" }] }] }).allCompleted,
		).toBe(true);
	});

	it("never calls an empty plan complete", () => {
		expect(checkSubtasksCompletion(null)).toEqual({
			allSubtasks: [],
			completedCount: 0,
			totalCount: 0,
			allCompleted: false,
		});
		expect(checkSubtasksCompletion({ phases: [] }).allCompleted).toBe(false);
	});
});

describe("ensureProfileManagerInitialized", () => {
	it("passes the manager on, or explains a failure with its cause", async () => {
		const ok = await ensureProfileManagerInitialized();
		expect(ok.success).toBe(true);

		state.initError = new Error("EACCES");
		expect(await ensureProfileManagerInitialized()).toEqual({
			success: false,
			error:
				"Failed to initialize profile manager. Please check file permissions and disk space. (EACCES)",
		});
		state.initError = "plain";
		const plain = await ensureProfileManagerInitialized();
		expect(plain.success === false && plain.error.endsWith("(plain)")).toBe(true);
	});
});

describe("determineStartEvent", () => {
	it("restarts a done task from the backlog and forgets its machine", () => {
		state.xstate = "done";
		const t = task({ status: "done", reviewReason: "completed" } as Partial<Task>);
		const event = determineStartEvent("t1", t);
		expect(event.type).toBe("PLANNING_STARTED");
		expect(event.resetTask).toMatchObject({
			status: "backlog",
			reviewReason: undefined,
			executionProgress: undefined,
		});
		expect(state.clearTask).toHaveBeenCalledWith("t1");
	});

	it("follows the live machine state", () => {
		state.xstate = "plan_review";
		expect(determineStartEvent("t1", task()).type).toBe("PLAN_APPROVED");
		state.xstate = "human_review";
		expect(determineStartEvent("t1", task()).type).toBe("USER_RESUMED");
		state.xstate = "error";
		// Failed while planning: there is no plan to resume, plan again.
		expect(determineStartEvent("t1", task()).type).toBe("PLANNING_STARTED");
		expect(
			determineStartEvent("t1", task({ subtasks: [{ id: "s" }] as Task["subtasks"] })).type,
		).toBe("USER_RESUMED");
		state.xstate = "backlog";
		expect(determineStartEvent("t1", task())).toEqual({ type: "PLANNING_STARTED" });
		expect(state.clearTask).not.toHaveBeenCalled();
	});

	it("resets a task caught in any other state", () => {
		state.xstate = "coding";
		const event = determineStartEvent("t1", task({ status: "in_progress" }));
		expect(event.type).toBe("PLANNING_STARTED");
		expect(event.resetTask?.status).toBe("backlog");
		expect(state.clearTask).toHaveBeenCalledWith("t1");
	});

	it("reads the task itself when no machine exists", () => {
		expect(
			determineStartEvent("t1", task({ status: "human_review", reviewReason: "plan_review" } as Partial<Task>))
				.type,
		).toBe("PLAN_APPROVED");
		const planned = { subtasks: [{ id: "s" }] as Task["subtasks"] };
		for (const status of ["human_review", "error", "build_failed"] as const) {
			expect(determineStartEvent("t1", task({ status, ...planned })).type).toBe("USER_RESUMED");
		}
		expect(determineStartEvent("t1", task({ status: "error" })).type).toBe("PLANNING_STARTED");
		expect(determineStartEvent("t1", task({ status: "backlog" })).type).toBe("PLANNING_STARTED");
	});
});

describe("validateTaskPrerequisites", () => {
	const window = {} as never;

	function repo(withCommit: boolean): string {
		const dir = path.join(base, "project");
		mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q");
		if (withCommit) {
			git(dir, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
		}
		return dir;
	}

	it("stops when the profile manager cannot start", async () => {
		state.initError = new Error("boom");
		const result = await validateTaskPrerequisites("t1", window);
		expect(result.success).toBe(false);
	});

	it("stops for an unknown task", async () => {
		expect(await validateTaskPrerequisites("t1", window)).toEqual({
			success: false,
			error: "Task or project not found",
		});
	});

	it("wants a git repository with a commit", async () => {
		mkdirSync(path.join(base, "project"));
		state.found = { task: task({ metadata: { provider: "ollama" } }), project: project() };
		const noRepo = await validateTaskPrerequisites("t1", window);
		expect(noRepo.success === false && noRepo.error).toMatch(/^Git repository required/);

		rmSync(path.join(base, "project"), { recursive: true });
		repo(false);
		const noCommit = await validateTaskPrerequisites("t1", window);
		expect(noCommit.success === false && noCommit.error).toMatch(/^Git repository has no commits/);
	});

	it("asks for Claude authentication only for a task that runs on Claude", async () => {
		repo(true);
		state.hasValidAuth = false;
		state.found = { task: task({ metadata: { provider: "anthropic" } }), project: project() };
		const claude = await validateTaskPrerequisites("t1", window);
		expect(claude.success === false && claude.error).toMatch(/^Claude authentication required/);

		state.found = { task: task({ metadata: { provider: "ollama" } }), project: project() };
		const ollama = await validateTaskPrerequisites("t1", window);
		expect(ollama.success).toBe(true);
		expect(ollama.success && ollama.project.id).toBe("p1");
	});
});

describe("setupTaskExecution", () => {
	const specDir = () => path.join(base, "project", ".workpilot", "specs", "001-x");

	it("watches the spec folder and needs a spec when there is none", () => {
		const result = setupTaskExecution("t1", task(), project());
		expect(result).toEqual({
			specDir: specDir(),
			hasSpec: false,
			needsSpecCreation: true,
			needsImplementation: false,
		});
		expect(state.watch).toHaveBeenCalledWith("t1", specDir());
	});

	it("needs an implementation for a spec without subtasks, and nothing once planned", () => {
		mkdirSync(specDir(), { recursive: true });
		writeFileSync(path.join(specDir(), "spec.md"), "# Spec", "utf-8");
		expect(setupTaskExecution("t1", task(), project()).needsImplementation).toBe(true);
		const planned = task({ subtasks: [{ id: "s" }] as Task["subtasks"] });
		expect(setupTaskExecution("t1", planned, project())).toMatchObject({
			hasSpec: true,
			needsSpecCreation: false,
			needsImplementation: false,
		});
	});

	it("writes the spec again when the description changed before planning", () => {
		const dir = specDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "spec.md"), "# Old spec", "utf-8");
		writeFileSync(path.join(dir, "spec_source.json"), JSON.stringify({ task_description: "old" }));
		writeFileSync(path.join(dir, "requirements.json"), JSON.stringify({ task_description: "new" }));
		const warn = silenceWarn();
		expect(setupTaskExecution("t1", task(), project({ autoBuildPath: ".workpilot" }))).toMatchObject({
			hasSpec: false,
			needsSpecCreation: true,
		});
		expect(existsSync(path.join(dir, "spec.md"))).toBe(false);
		warn.mockRestore();
	});
});

describe("getPlanPaths", () => {
	it("lists the main and worktree copies of the plan that exist, besides the primary", () => {
		const main = path.join(base, "main");
		const worktree = path.join(base, "wt");
		const spec = path.join(base, "spec");
		for (const dir of [main, worktree, spec]) mkdirSync(dir);
		const paths = { specDir: spec, mainSpecDir: main, worktreeSpecDir: worktree, specsBaseDir: "" };
		const primary = path.join(spec, "implementation_plan.json");

		expect(getPlanPaths(paths, project())).toEqual({ primary, all: [primary] });

		writeFileSync(path.join(main, "implementation_plan.json"), "{}");
		writeFileSync(path.join(worktree, "implementation_plan.json"), "{}");
		expect(getPlanPaths(paths, project()).all).toEqual([
			primary,
			path.join(main, "implementation_plan.json"),
			path.join(worktree, "implementation_plan.json"),
		]);

		// The same folder is never listed twice, and no worktree means no copy.
		const same = { specDir: main, mainSpecDir: main, worktreeSpecDir: null, specsBaseDir: "" };
		expect(getPlanPaths(same, project()).all).toEqual([path.join(main, "implementation_plan.json")]);
	});
});
