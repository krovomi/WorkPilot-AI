/**
 * @vitest-environment node
 *
 * The branch a terminal worktree starts from when the dialog names none: the
 * project's main branch, else the `.workpilot/.env` default, else `main` or
 * `master`. A configured name that is not a branch name is passed over, on a
 * real repository.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	repo: "",
	mainBranch: undefined as string | undefined,
	env: {} as Record<string, string>,
}));

vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => [{ id: "p-1", path: state.repo, settings: { mainBranch: state.mainBranch } }],
	},
}));
vi.mock("../../../project-env-file", () => ({ readProjectEnvFile: () => state.env }));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));

import { registerTerminalWorktreeHandlers } from "../worktree-handlers";

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: state.repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const create = (name: string) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown> }).invokeHandler(
		IPC_CHANNELS.TERMINAL_WORKTREE_CREATE,
		{},
		{ terminalId: "t-1", name, createGitBranch: false, projectPath: state.repo },
	) as Promise<{ success: boolean; error?: string; config?: { baseBranch: string; worktreePath: string } }>;

beforeAll(() => {
	registerTerminalWorktreeHandlers();
});

beforeEach(() => {
	state.repo = mkdtempSync(path.join(tmpdir(), "terminal-worktree-"));
	state.mainBranch = undefined;
	state.env = {};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.test");
	git("config", "user.name", "Test");
	writeFileSync(path.join(state.repo, "README.md"), "hello\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "first");
	git("branch", "develop");
});

afterEach(() => {
	rmSync(state.repo, { recursive: true, force: true });
});

describe("the base branch of a terminal worktree", () => {
	it("is the project's main branch when it names one", async () => {
		state.mainBranch = "develop";
		const result = await create("from-settings");
		expect(result).toMatchObject({ success: true, config: { baseBranch: "develop" } });
	});

	it("is the .workpilot/.env default when the settings name none", async () => {
		state.env = { DEFAULT_BRANCH: "develop" };
		const result = await create("from-env");
		expect(result).toMatchObject({ success: true, config: { baseBranch: "develop" } });
	});

	it.each([["--no-such-option"], ["-b"], ["develop "]])(
		"passes over a configured %j, which is not a branch name, for the branch it finds",
		async (configured) => {
			state.mainBranch = configured;
			state.env = { DEFAULT_BRANCH: configured };
			const result = await create("passed-over");
			expect(result).toMatchObject({ success: true, config: { baseBranch: "main" } });
			expect(git("-C", result.config?.worktreePath ?? "", "rev-parse", "HEAD")).toBe(git("rev-parse", "main"));
		},
	);
});

describe("a base branch chosen in the dialog", () => {
	const createFrom = (name: string, baseBranch: string) =>
		(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown> }).invokeHandler(
			IPC_CHANNELS.TERMINAL_WORKTREE_CREATE,
			{},
			{ terminalId: "t-1", name, createGitBranch: false, projectPath: state.repo, baseBranch },
		) as Promise<{ success: boolean; error?: string; config?: { baseBranch: string } }>;

	it.each([["origin/develop"], ["feature/a.b"], ["release/1.2"]])("is taken when it is a branch name, as %j", async (base) => {
		git("update-ref", "refs/remotes/origin/develop", "main");
		git("branch", "feature/a.b");
		git("branch", "release/1.2");
		const result = await createFrom("chosen", base);
		expect(result).toMatchObject({ success: true, config: { baseBranch: base } });
	});

	it.each([["origin/-x"], ["origin/.hidden"], ["a/../b"], ["feature/-y"]])("is refused when a part is not, as %j", async (base) => {
		const result = await createFrom("refused", base);
		expect(result).toEqual({ success: false, error: "Invalid base branch name" });
	});

	it("is passed over in the settings the same way", async () => {
		state.mainBranch = "origin/-x";
		const result = await create("settings-passed-over");
		expect(result).toMatchObject({ success: true, config: { baseBranch: "main" } });
	});
});
