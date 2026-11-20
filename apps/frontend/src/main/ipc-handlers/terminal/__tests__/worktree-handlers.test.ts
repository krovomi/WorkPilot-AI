/**
 * @vitest-environment node
 *
 * Terminal worktrees on real repositories: creation from a local or a remote
 * base, with or without a branch, the dependency links, the metadata and its
 * older place, the other worktrees of a project, removal; and what the
 * renderer may send at all. Only failures the file system or git would not
 * give on demand (a refused delete, a timeout) are injected.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	projects: [] as { path: string; settings?: { mainBranch?: string } }[],
	windows: undefined as boolean | undefined,
}));

/** Which calls fail: a file-system call on a path the predicate accepts, a git call after it ran. */
const faults = vi.hoisted(() => ({
	rm: undefined as ((target: string) => boolean) | undefined,
	readdir: undefined as ((target: string) => boolean) | undefined,
	symlink: undefined as ((target: string) => boolean) | undefined,
	git: undefined as ((args: string[]) => unknown) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const failing = <F extends (...args: never[]) => unknown>(fault: "rm" | "readdir" | "symlink", call: F) =>
		((...args: Parameters<F>) => {
			if (faults[fault]?.(String(args[fault === "symlink" ? 1 : 0]))) {
				throw Object.assign(new Error(`${fault} refused`), { code: "EACCES" });
			}
			return call(...args);
		}) as unknown as F;
	return {
		...real,
		rmSync: failing("rm", real.rmSync),
		readdirSync: failing("readdir", real.readdirSync),
		symlinkSync: failing("symlink", real.symlinkSync),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	const { promisify } = await import("node:util");
	const run = promisify(real.execFile);
	const execFile = Object.assign((...args: unknown[]) => (real.execFile as (...a: unknown[]) => unknown)(...args), {
		[promisify.custom]: async (file: string, args: string[], options: object) => {
			const result = await run(file, args, options);
			const fault = faults.git?.(args);
			if (fault !== undefined) throw fault;
			return result;
		},
	});
	return { ...real, execFile };
});

vi.mock("../../../project-store", () => ({ projectStore: { getProjects: () => state.projects } }));
vi.mock("../../../project-env-file", () => ({ readProjectEnvFile: () => ({}) }));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));
vi.mock("../../../platform", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../../platform")>();
	return { ...real, isWindows: () => state.windows ?? real.isWindows() };
});

import { registerTerminalWorktreeHandlers } from "../worktree-handlers";

type Config = {
	name: string;
	worktreePath: string;
	branchName: string;
	baseBranch: string;
	hasGitBranch: boolean;
	taskId?: string;
	terminalId: string;
	remoteTrackingSetUp: boolean;
};
type CreateResult = { success: boolean; error?: string; warning?: string; config?: Config };
type Other = { path: string; branch: string | null; commitSha: string; displayName: string };

const invoke = <T>(channel: string, ...args: unknown[]) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<T> }).invokeHandler(
		channel,
		{},
		...args,
	);

let root = "";
let repo = "";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository on `main` (or `branch`) with one commit of `files`, registered as a project. */
function makeRepo(dir: string, files: Record<string, string> = { "README.md": "hello\n" }, branch = "main"): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", branch);
	git(dir, "config", "user.email", "test@example.test");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "commit.gpgsign", "false");
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), content);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "first");
	state.projects.push({ path: dir });
	return dir;
}

function commit(dir: string, file: string): string {
	writeFileSync(path.join(dir, file), file);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", file);
	return git(dir, "rev-parse", "HEAD");
}

const request = (name: string, extra: Record<string, unknown> = {}) => ({
	terminalId: "t-1",
	name,
	createGitBranch: false,
	projectPath: repo,
	...extra,
});
const create = (name: string, extra: Record<string, unknown> = {}) =>
	invoke<CreateResult>(IPC_CHANNELS.TERMINAL_WORKTREE_CREATE, request(name, extra));
const list = (projectPath = repo) =>
	invoke<{ success: boolean; data: Config[] }>(IPC_CHANNELS.TERMINAL_WORKTREE_LIST, projectPath).then((r) => r.data);
const listOther = (projectPath = repo) =>
	invoke<{ success: boolean; data: Other[] }>(IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER, projectPath).then(
		(r) => r.data,
	);
const remove = (name: string, deleteBranch?: boolean, projectPath = repo) =>
	invoke<{ success: boolean; error?: string }>(IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE, projectPath, name, deleteBranch);

const worktreeOf = (name: string) => path.join(repo, ".workpilot", "worktrees", "terminal", name);
const metadataOf = (name: string) => path.join(repo, ".workpilot", "terminal", "metadata", `${name}.json`);
const gitFails = (cmd: string, sub: string, error: unknown) => {
	faults.git = (args) => (args[0] === cmd && args[1] === sub ? error : undefined);
};

beforeAll(() => {
	registerTerminalWorktreeHandlers();
});

beforeEach(() => {
	// The native call: on Windows the temp folder can be a short 8.3 name
	// (RUNNER~1) that git, and the handlers after it, give in its long form.
	root = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "terminal-worktrees-")),
	);
	state.projects = [];
	state.windows = undefined;
	faults.rm = faults.readdir = faults.symlink = faults.git = undefined;
	repo = makeRepo(path.join(root, "project"));
});

afterEach(() => {
	faults.rm = faults.readdir = faults.symlink = faults.git = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("what the renderer may send", () => {
	it.each([
		["a request with an unknown field", [{ ...request("x"), env: { A: "1" } }]],
		["a name that is not text", [{ ...request("x"), name: ["x"] }]],
		["no request", [null]],
		["a branch flag that is not a boolean", [{ ...request("x"), createGitBranch: "yes" }]],
	])("refuses %s to create a worktree", async (_label, args) => {
		await expect(async () => invoke(IPC_CHANNELS.TERMINAL_WORKTREE_CREATE, ...args)).rejects.toThrow(
			"Invalid terminal arguments",
		);
	});

	it.each([
		[IPC_CHANNELS.TERMINAL_WORKTREE_LIST, [42]],
		[IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER, [undefined]],
		[IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE, ["/p", "x", "yes"]],
		[IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE, ["/p", "", true]],
	])("refuses %s with %j", async (channel, args) => {
		await expect(async () => invoke(channel, ...args)).rejects.toThrow("Invalid terminal arguments");
	});
});

describe("creating a worktree", { timeout: 30_000 }, () => {
	it("refuses a folder that is not a registered project", async () => {
		expect(await create("x", { projectPath: path.join(root, "elsewhere") })).toEqual({
			success: false,
			error: "Invalid project path",
		});
	});

	it.each([["Upper"], ["-lead"], ["trail-"], ["a/b"]])("refuses the name %j", async (name) => {
		const result = await create(name);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Invalid worktree name/);
	});

	it("refuses a base branch that is not a branch name", async () => {
		expect(await create("x", { baseBranch: "-b" })).toEqual({ success: false, error: "Invalid base branch name" });
	});

	it("makes a detached worktree from the default branch and records it", async () => {
		const result = await create("detached", { taskId: "001-task" });
		expect(result).toMatchObject({
			success: true,
			config: {
				name: "detached",
				worktreePath: worktreeOf("detached"),
				branchName: "",
				baseBranch: "main",
				hasGitBranch: false,
				taskId: "001-task",
				terminalId: "t-1",
				remoteTrackingSetUp: false,
			},
		});
		expect(result.warning).toBeUndefined();
		expect(git(worktreeOf("detached"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
		expect(() => git(worktreeOf("detached"), "symbolic-ref", "-q", "HEAD")).toThrow();
		expect(JSON.parse(readFileSync(metadataOf("detached"), "utf-8"))).toEqual(result.config);
	});

	it("refuses a name already taken", async () => {
		await create("twice");
		expect(await create("twice")).toEqual({ success: false, error: "Worktree 'twice' already exists." });
	});

	it("makes a terminal/<name> branch without tracking when there is no origin", async () => {
		const result = await create("branch", { createGitBranch: true });
		expect(result).toMatchObject({ success: true, config: { branchName: "terminal/branch", hasGitBranch: true } });
		expect(result.config?.remoteTrackingSetUp).toBe(false);
		expect(result.warning).toBeUndefined();
		expect(git(worktreeOf("branch"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("terminal/branch");
	});

	it.each([
		["master", "master"],
		["trunk", "trunk"],
	])("falls back to %j when it is the only branch", async (branch, expected) => {
		state.projects = [];
		repo = makeRepo(path.join(root, branch), { "README.md": "x" }, branch);
		expect(await create("fallback")).toMatchObject({ success: true, config: { baseBranch: expected } });
	});

	it("says what git said when the folder is not a repository", async () => {
		const plain = path.join(root, "plain");
		mkdirSync(plain);
		state.projects.push({ path: plain });
		const result = await create("x", { projectPath: plain });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not a git repository|fatal/i);
		expect(existsSync(path.join(plain, ".workpilot", "worktrees", "terminal", "x"))).toBe(false);
	});

	it("removes what a failed creation left, and git's record of it", async () => {
		gitFails("worktree", "add", new Error("add broke"));
		expect(await create("broken")).toEqual({ success: false, error: "add broke" });
		expect(existsSync(worktreeOf("broken"))).toBe(false);
		expect(git(repo, "worktree", "list")).not.toContain("broken");
		expect(existsSync(metadataOf("broken"))).toBe(false);
	});

	it("says a timeout in words, and still answers when the leftovers cannot be removed", async () => {
		gitFails("worktree", "add", Object.assign(new Error("killed"), { killed: true }));
		faults.rm = (target) => target === worktreeOf("slow");
		const result = await create("slow");
		expect(result).toEqual({ success: false, error: expect.stringMatching(/^Git operation timed out/) });
	});
});

describe("a worktree from a remote", { timeout: 30_000 }, () => {
	let origin = "";
	let ahead = "";

	beforeEach(() => {
		origin = path.join(root, "origin.git");
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		git(repo, "remote", "add", "origin", origin);
		git(repo, "checkout", "-q", "-b", "develop");
		ahead = commit(repo, "ahead.txt");
		git(repo, "push", "-q", "origin", "main", "develop");
		git(repo, "checkout", "-q", "main");
		git(repo, "branch", "-f", "develop", "main"); // the local develop is behind origin's
	});

	it("starts from origin/<base> when the remote has it, fetched first", async () => {
		const clone = path.join(root, "clone");
		git(root, "clone", "-q", "-b", "develop", origin, clone);
		git(clone, "config", "user.email", "test@example.test");
		git(clone, "config", "user.name", "Test");
		git(clone, "config", "commit.gpgsign", "false");
		const pushed = commit(clone, "later.txt");
		git(clone, "push", "-q", "origin", "develop");

		const result = await create("remote", { baseBranch: "develop" });
		expect(result).toMatchObject({ success: true, config: { baseBranch: "develop" } });
		expect(git(worktreeOf("remote"), "rev-parse", "HEAD")).toBe(pushed);
	});

	it("starts from the local branch when the dialog asks for it", async () => {
		await create("local", { baseBranch: "develop", useLocalBranch: true });
		expect(git(worktreeOf("local"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
	});

	it("takes a remote ref as named", async () => {
		const result = await create("named", { baseBranch: "origin/develop", useLocalBranch: true });
		expect(result).toMatchObject({ success: true, config: { baseBranch: "origin/develop" } });
		expect(git(worktreeOf("named"), "rev-parse", "HEAD")).toBe(ahead);
	});

	it("pushes a new branch and tracks it", async () => {
		const result = await create("pushed", { createGitBranch: true });
		expect(result.config?.remoteTrackingSetUp).toBe(true);
		expect(git(origin, "rev-parse", "terminal/pushed")).toBe(git(repo, "rev-parse", "main"));
		expect(git(worktreeOf("pushed"), "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/terminal/pushed");
	});

	it("keeps the worktree and warns when the push fails", async () => {
		git(repo, "remote", "set-url", "origin", path.join(root, "gone.git"));
		const result = await create("unpushed", { createGitBranch: true });
		expect(result).toMatchObject({ success: true, config: { remoteTrackingSetUp: false } });
		expect(result.warning).toBeTruthy();
		expect(existsSync(worktreeOf("unpushed"))).toBe(true);
	});
});

describe("the dependency folders of a worktree", { timeout: 30_000 }, () => {
	const nodeModules = (base: string) => [
		path.join(base, "node_modules"),
		path.join(base, "apps", "frontend", "node_modules"),
	];

	beforeEach(() => {
		for (const folder of nodeModules(repo)) mkdirSync(folder, { recursive: true });
	});

	it("are linked relatively, so that the folder can move", async () => {
		state.windows = false;
		await create("linked");
		for (const [source, target] of nodeModules(repo).map((s, i) => [s, nodeModules(worktreeOf("linked"))[i]])) {
			expect(lstatSync(target).isSymbolicLink()).toBe(true);
			expect(path.isAbsolute(readlinkSync(target))).toBe(false);
			expect(realpathSync(target)).toBe(realpathSync(source));
		}
	});

	it("are junctions to the absolute folder on Windows", async () => {
		state.windows = true;
		await create("junction");
		const target = nodeModules(worktreeOf("junction"))[0];
		expect(realpathSync(target)).toBe(realpathSync(nodeModules(repo)[0]));
		expect(path.isAbsolute(readlinkSync(target))).toBe(true);
	});

	it("are left out when the link cannot be made, the worktree still made", async () => {
		faults.symlink = () => true;
		const result = await create("unlinked");
		expect(result.success).toBe(true);
		expect(existsSync(nodeModules(worktreeOf("unlinked"))[0])).toBe(false);
	});

	it("are not linked over what the worktree already has, nor when the project lacks them", async () => {
		state.projects = [];
		repo = makeRepo(path.join(root, "tracked"), { "node_modules/.keep": "" });
		const result = await create("own");
		expect(result.success).toBe(true);
		expect(lstatSync(path.join(worktreeOf("own"), "node_modules")).isSymbolicLink()).toBe(false);
		expect(existsSync(path.join(worktreeOf("own"), "apps"))).toBe(false);
	});

	it("are not linked over a link that points nowhere", async () => {
		state.projects = [];
		repo = makeRepo(path.join(root, "dangling"));
		mkdirSync(path.join(repo, "node_modules"));
		mkdirSync(path.join(worktreeOf("dangling")), { recursive: true });
		rmSync(worktreeOf("dangling"), { recursive: true });
		faults.git = (args) => {
			if (args[0] === "worktree" && args[1] === "add") {
				symlinkSync(path.join(root, "nowhere"), path.join(worktreeOf("dangling"), "node_modules"));
			}
			return undefined;
		};
		await create("dangling");
		expect(readlinkSync(path.join(worktreeOf("dangling"), "node_modules"))).toBe(path.join(root, "nowhere"));
	});
});

describe("a repository marked bare by mistake", { timeout: 30_000 }, () => {
	const bare = () => {
		try {
			return git(repo, "config", "--get", "core.bare");
		} catch {
			return "unset";
		}
	};

	it.each([
		["README.md", { "README.md": "x" }],
		["a .NET project file", { "App.CSPROJ": "<Project />" }],
	])("is fixed when it holds sources (%s)", async (_label, files) => {
		state.projects = [];
		repo = makeRepo(path.join(root, "sources"), files);
		git(repo, "config", "core.bare", "true");
		await create("fixed");
		expect(bare()).toBe("unset");
	});

	it("is left alone when nothing says it holds sources", async () => {
		state.projects = [];
		repo = makeRepo(path.join(root, "notes"), { "notes.txt": "x" });
		git(repo, "config", "core.bare", "true");
		await remove("anything");
		expect(bare()).toBe("true");
	});

	it("is left alone when its folder cannot be read", async () => {
		state.projects = [];
		repo = makeRepo(path.join(root, "unreadable"), { "App.csproj": "x" });
		git(repo, "config", "core.bare", "true");
		faults.readdir = (target) => target === repo;
		await remove("anything");
		expect(bare()).toBe("true");
	});
});

describe("listing the terminal worktrees", { timeout: 30_000 }, () => {
	it("is empty for a folder that is not a registered project", async () => {
		expect(await list(path.join(root, "elsewhere"))).toEqual([]);
	});

	it("is empty before any worktree", async () => {
		expect(await list()).toEqual([]);
	});

	it("gives the recorded worktrees, and drops the record of a deleted one", async () => {
		const kept = (await create("kept")).config;
		await create("deleted");
		rmSync(worktreeOf("deleted"), { recursive: true });
		expect(await list()).toEqual([kept]);
		expect(existsSync(metadataOf("deleted"))).toBe(false);
	});

	it("still answers when the record of a deleted one cannot be removed", async () => {
		await create("stuck");
		rmSync(worktreeOf("stuck"), { recursive: true });
		faults.rm = (target) => target === metadataOf("stuck");
		expect(await list()).toEqual([]);
		expect(existsSync(metadataOf("stuck"))).toBe(true);
	});

	it("skips records that are not a config, and what is not a record", async () => {
		const kept = (await create("kept")).config;
		const metadata = path.dirname(metadataOf("kept"));
		writeFileSync(path.join(metadata, "broken.json"), "{");
		writeFileSync(path.join(metadata, "list.json"), "[1]");
		writeFileSync(path.join(metadata, "notes.txt"), "x");
		mkdirSync(path.join(metadata, "folder.json"));
		expect(await list()).toEqual([kept]);
	});

	it("moves a config kept inside an older worktree to the metadata folder", async () => {
		const legacy = { name: "old", worktreePath: worktreeOf("old"), hasGitBranch: false };
		mkdirSync(worktreeOf("old"), { recursive: true });
		writeFileSync(path.join(worktreeOf("old"), "config.json"), JSON.stringify(legacy));
		mkdirSync(worktreeOf("empty"));
		writeFileSync(path.join(path.dirname(worktreeOf("old")), "stray.txt"), "x");
		expect(await list()).toEqual([legacy]);
		expect(JSON.parse(readFileSync(metadataOf("old"), "utf-8"))).toEqual(legacy);
		expect(existsSync(path.join(worktreeOf("old"), "config.json"))).toBe(false);
	});

	it("keeps an older config it could not remove, and skips one it cannot read", async () => {
		mkdirSync(worktreeOf("old"), { recursive: true });
		mkdirSync(worktreeOf("unreadable"), { recursive: true });
		writeFileSync(path.join(worktreeOf("old"), "config.json"), JSON.stringify({ name: "old" }));
		writeFileSync(path.join(worktreeOf("unreadable"), "config.json"), "not json");
		faults.rm = (target) => target.endsWith("config.json");
		expect(await list()).toEqual([{ name: "old" }]);
		expect(existsSync(path.join(worktreeOf("old"), "config.json"))).toBe(true);
	});

	it("gives nothing from a folder it cannot read", async () => {
		await create("hidden");
		faults.readdir = (target) => target.includes(`${path.sep}.workpilot${path.sep}`);
		expect(await list()).toEqual([]);
	});
});

describe("listing the other worktrees", { timeout: 30_000 }, () => {
	it("is empty for a folder that is not a registered project", async () => {
		expect(await listOther(path.join(root, "elsewhere"))).toEqual([]);
	});

	it("gives those WorkPilot does not manage, with their branch or none", async () => {
		await create("mine");
		const workpilot = path.join(repo, ".workpilot", "worktrees");
		git(repo, "worktree", "add", "-q", "--detach", path.join(workpilot, "tasks", "001-task"));
		git(repo, "worktree", "add", "-q", "--detach", path.join(workpilot, "pr"));
		git(repo, "worktree", "add", "-q", "-b", "feature", path.join(root, "feature-wt"));
		git(repo, "worktree", "add", "-q", "--detach", path.join(root, "detached-wt"));
		const head = git(repo, "rev-parse", "HEAD");

		const others = await listOther();
		expect(others).toEqual(
			expect.arrayContaining([
				{
					path: path.join(root, "feature-wt"),
					branch: "feature",
					commitSha: head.slice(0, 8),
					displayName: "feature-wt",
				},
				{ path: path.join(root, "detached-wt"), branch: null, commitSha: head.slice(0, 8), displayName: "detached-wt" },
			]),
		);
		expect(others).toHaveLength(2);
	});

	it("recognises the project when it is opened through a link", async () => {
		const link = path.join(root, "link");
		symlinkSync(repo, link, "junction");
		state.projects.push({ path: link });
		git(repo, "worktree", "add", "-q", "--detach", path.join(repo, ".workpilot", "worktrees", "tasks", "t"));
		expect(await listOther(link)).toEqual([]);
	});

	it("gives a worktree whose folder is gone as git recorded it", async () => {
		const gone = path.join(root, "gone-wt");
		git(repo, "worktree", "add", "-q", "--detach", gone);
		rmSync(gone, { recursive: true });
		expect((await listOther()).map((other) => other.path)).toEqual([gone]);
	});

	it("skips a bare repository's own entry", async () => {
		const bare = path.join(root, "bare.git");
		git(root, "init", "-q", "--bare", bare);
		state.projects.push({ path: bare });
		expect(await listOther(bare)).toEqual([]);
	});

	it("is empty when git cannot list them", async () => {
		git(repo, "worktree", "add", "-q", "--detach", path.join(root, "other"));
		gitFails("worktree", "list", new Error("list broke"));
		expect(await listOther()).toEqual([]);
	});
});

describe("removing a worktree", { timeout: 30_000 }, () => {
	it("refuses a folder that is not a registered project, a bad name, an unknown worktree", async () => {
		expect(await remove("x", false, path.join(root, "elsewhere"))).toEqual({
			success: false,
			error: "Invalid project path",
		});
		expect(await remove("../x")).toEqual({ success: false, error: "Invalid worktree name" });
		expect(await remove("unknown")).toEqual({ success: false, error: "Worktree not found" });
	});

	it("removes the worktree, its record and, when asked, its branch", async () => {
		await create("done", { createGitBranch: true });
		expect(await remove("done", true)).toEqual({ success: true });
		expect(existsSync(worktreeOf("done"))).toBe(false);
		expect(existsSync(metadataOf("done"))).toBe(false);
		expect(git(repo, "branch", "--list", "terminal/done")).toBe("");
	});

	it("keeps the branch when not asked", async () => {
		await create("kept", { createGitBranch: true });
		await remove("kept", false);
		expect(git(repo, "branch", "--list", "terminal/kept")).toContain("terminal/kept");
	});

	it("deletes no branch for a detached worktree", async () => {
		await create("detached");
		expect(await remove("detached", true)).toEqual({ success: true });
	});

	const editRecord = (name: string, change: Record<string, unknown>) => {
		const config = JSON.parse(readFileSync(metadataOf(name), "utf-8"));
		writeFileSync(metadataOf(name), JSON.stringify({ ...config, ...change }));
	};

	it("passes over a recorded branch that is not a branch name", async () => {
		await create("edited", { createGitBranch: true });
		editRecord("edited", { branchName: "-D" });
		expect(await remove("edited", true)).toEqual({ success: true });
		expect(git(repo, "branch", "--list", "terminal/edited")).toContain("terminal/edited");
	});

	it("succeeds when the branch is already gone", async () => {
		await create("gone", { createGitBranch: true });
		editRecord("gone", { branchName: "terminal/never-made" });
		expect(await remove("gone", true)).toEqual({ success: true });
	});

	it("drops the record of a worktree whose folder is already gone", async () => {
		await create("vanished");
		rmSync(worktreeOf("vanished"), { recursive: true });
		expect(await remove("vanished")).toEqual({ success: true });
		expect(existsSync(metadataOf("vanished"))).toBe(false);
	});

	it("says what git said, or a timeout in words", async () => {
		await create("stuck");
		gitFails("worktree", "remove", new Error("remove broke"));
		expect(await remove("stuck")).toEqual({ success: false, error: "remove broke" });

		await create("slow");
		gitFails("worktree", "remove", Object.assign(new Error("killed"), { killed: true }));
		expect(await remove("slow")).toEqual({
			success: false,
			error: expect.stringMatching(/^Git operation timed out/),
		});
	});
});
