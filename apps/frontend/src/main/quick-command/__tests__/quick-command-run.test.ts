/**
 * A quick command runs on a review card, never in the project folder (F182).
 *
 * What matters: the renderer names a project of this computer by its id (not
 * a folder) and a command by its name (not a path); the agent works in the
 * card's worktree; what it wrote is committed there whether it finished or
 * failed; a command that wrote nothing leaves no card. The review card and
 * the Python runner are replaced by fakes (both tested on their own:
 * review-card.test.ts, tests/test_slash_command_runner.py).
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedReview } from "../../../shared/types/generated-review";

const { projects } = vi.hoisted(() => ({
	projects: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProject: (id: string) => projects.get(id) },
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("../../updater/path-resolver", () => ({ getEffectiveSourcePath: () => "" }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: vi.fn() }));

import {
	isValidCommandName,
	parseRunnerOutput,
	type QuickCommandDeps,
	runQuickCommand,
} from "../quick-command-run";

const local = path.join(path.sep, "work", "demo");
const worktree = path.join(local, ".workpilot", "worktrees", "tasks", "001-commande-rapide");

function review(committed: boolean): GeneratedReview {
	return {
		taskId: "001-commande-rapide",
		specId: "001-commande-rapide",
		title: "Commande rapide : /create-prd",
		branch: "workpilot/001-commande-rapide",
		baseBranch: "develop",
		files: committed ? ["docs/prd.md"] : [],
		committed,
		reused: false,
	};
}

function deps(over: Partial<QuickCommandDeps> & { finish?: ReturnType<typeof vi.fn> } = {}) {
	const finish = over.finish ?? vi.fn().mockResolvedValue(review(true));
	const open = vi.fn().mockResolvedValue({
		root: worktree,
		finish,
		abandon: vi.fn(),
		map: (t: string | undefined) => t,
		workspace: {},
	});
	const run = over.run ?? vi.fn().mockResolvedValue({ ok: true, text: "PRD écrit." });
	return { open: over.open ?? open, run, finish };
}

beforeEach(() => {
	projects.clear();
	projects.set("local", { id: "local", path: local });
	projects.set("server", {
		id: "server",
		path: path.join(path.sep, "mirror"),
		remote: { serverUrl: "https://x" },
	});
});

describe("runQuickCommand", () => {
	it("runs the command in the card's worktree and commits what it wrote", async () => {
		const d = deps();
		const res = await runQuickCommand(
			{ projectId: "local", command: "create-prd", args: " a mobile app " },
			d,
		);

		expect(d.open).toHaveBeenCalledWith(
			local,
			"quick-command",
			"/create-prd a mobile app",
			undefined,
			expect.any(String),
		);
		expect(d.run).toHaveBeenCalledWith({
			projectPath: local,
			workdir: worktree,
			command: "create-prd",
			args: "a mobile app",
		});
		expect(d.finish).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringMatching(/^chore: run \/create-prd/) }),
		);
		expect(res.success).toBe(true);
		expect(res.data).toEqual({ ok: true, output: "PRD écrit.", review: review(true) });
	});

	it("gives no card back when the command wrote nothing", async () => {
		const d = deps({ finish: vi.fn().mockResolvedValue(review(false)) });
		const res = await runQuickCommand({ projectId: "local", command: "idea-discovery" }, d);

		expect(res.data?.review).toBeNull();
		expect(res.data?.output).toBe("PRD écrit.");
	});

	it("still commits what a failed command wrote, and says it failed", async () => {
		const d = deps({ run: vi.fn().mockResolvedValue({ ok: false, text: "workflow run failed: x" }) });
		const res = await runQuickCommand({ projectId: "local", command: "create-prd" }, d);

		expect(d.finish).toHaveBeenCalled();
		expect(res.success).toBe(true);
		expect(res.data?.ok).toBe(false);
		expect(res.data?.output).toBe("workflow run failed: x");
		expect(res.data?.review?.committed).toBe(true);
	});

	it("says where the files are when they cannot be committed", async () => {
		const d = deps({ finish: vi.fn().mockRejectedValue(new Error("Author identity unknown")) });
		const res = await runQuickCommand({ projectId: "local", command: "create-prd" }, d);

		expect(res.data?.review).toBeNull();
		expect(res.data?.uncommittedIn).toBe(worktree);
		expect(res.data?.output).toContain("Author identity unknown");
	});

	it("refuses an unknown project, a server project and a missing id before any card", async () => {
		for (const projectId of ["nope", "server", ""]) {
			const d = deps();
			const res = await runQuickCommand({ projectId, command: "create-prd" }, d);
			expect(res.success).toBe(false);
			expect(d.open).not.toHaveBeenCalled();
		}
	});

	it("refuses a path as a command name, and arguments that are too long", async () => {
		for (const command of ["../x", "/etc/passwd", "a b", "", "x".repeat(129)]) {
			const d = deps();
			const res = await runQuickCommand({ projectId: "local", command }, d);
			expect(res.success).toBe(false);
			expect(d.open).not.toHaveBeenCalled();
		}
		const d = deps();
		const res = await runQuickCommand(
			{ projectId: "local", command: "create-prd", args: "x".repeat(4001) },
			d,
		);
		expect(res.success).toBe(false);
		expect(d.open).not.toHaveBeenCalled();
	});

	it("reports a card that cannot be opened, and runs nothing", async () => {
		const failing = Object.assign(new Error("The review branch could not be prepared"), {
			details: "not a git repository",
		});
		const d = deps({ open: vi.fn().mockRejectedValue(failing) });
		const res = await runQuickCommand({ projectId: "local", command: "create-prd" }, d);

		expect(res.success).toBe(false);
		expect(res.error).toContain("not a git repository");
		expect(d.run).not.toHaveBeenCalled();
	});

	it("runs one command at a time per project", async () => {
		let release: (v: { ok: boolean; text: string }) => void = () => undefined;
		const slow = vi.fn(
			() => new Promise<{ ok: boolean; text: string }>((resolve) => (release = resolve)),
		);
		const first = runQuickCommand({ projectId: "local", command: "create-prd" }, deps({ run: slow }));
		await vi.waitFor(() => expect(slow).toHaveBeenCalled());

		const second = await runQuickCommand({ projectId: "local", command: "review" }, deps());
		expect(second.success).toBe(false);

		release({ ok: true, text: "" });
		expect((await first).success).toBe(true);
		const third = await runQuickCommand({ projectId: "local", command: "review" }, deps());
		expect(third.success).toBe(true);
	});
});

describe("isValidCommandName", () => {
	it("accepts command names, namespaced ones included", () => {
		for (const name of ["create-command", "bmad-bmm-create-prd", "ns:cmd", "ns/cmd", "v1.2"]) {
			expect(isValidCommandName(name)).toBe(true);
		}
	});

	it("refuses paths and anything that is not a string", () => {
		for (const name of ["../x", "a/../b", "/x", "a b", "", 3, null]) {
			expect(isValidCommandName(name)).toBe(false);
		}
	});
});

describe("parseRunnerOutput", () => {
	it("reads the last result line and ignores the agent's log", () => {
		const out = 'log line\n__SLASH_COMMAND__:{"success": true, "result": "done"}\n';
		expect(parseRunnerOutput(out, "")).toEqual({ ok: true, text: "done" });
	});

	it("reads a failure, and falls back to stderr when there is no result", () => {
		expect(
			parseRunnerOutput('__SLASH_COMMAND__:{"success": false, "error": "command not found: /x"}', ""),
		).toEqual({ ok: false, text: "command not found: /x" });
		expect(parseRunnerOutput("", "Traceback…\nModuleNotFoundError: core\n")).toEqual({
			ok: false,
			text: "ModuleNotFoundError: core",
		});
		expect(parseRunnerOutput("__SLASH_COMMAND__:{oops", "")).toEqual({
			ok: false,
			text: "The command runner answered something unreadable",
		});
	});
});
