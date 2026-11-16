/**
 * Terminal worktrees: one git worktree per terminal under
 * `.workpilot/worktrees/terminal/<name>`, its settings in
 * `.workpilot/terminal/metadata/<name>.json`. The renderer names a registered
 * project, a worktree name and at most a base branch; `terminalIpcMain`
 * checks the shape of what it sends, these handlers what it means. Every git
 * call is a list of arguments.
 */

import { execFile, execFileSync } from "node:child_process";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	CreateTerminalWorktreeRequest,
	IPCResult,
	OtherWorktreeInfo,
	TerminalWorktreeConfig,
	TerminalWorktreeResult,
} from "../../../shared/types";
import { debugError, debugLog } from "../../../shared/utils/debug-logger";
import { getToolPath } from "../../cli-tool-manager";
import { isWindows } from "../../platform";
import { readProjectEnvFile } from "../../project-env-file";
import { projectStore } from "../../project-store";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import {
	getTerminalWorktreeDir,
	getTerminalWorktreeMetadataDir,
	getTerminalWorktreeMetadataPath,
	getTerminalWorktreePath,
} from "../../worktree-paths";
import { terminalIpcMain } from "./terminal-ipc-guard";

const execFileAsync = promisify(execFile);

// Shared validation regex for worktree names - lowercase alphanumeric with dashes/underscores
// Must start and end with alphanumeric character
const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;

// Validation regex for git branch names - allows alphanumeric, dots, slashes, dashes, underscores.
// As git wants a branch name: no part after a slash starts with a dash or a dot, no "..".
const GIT_BRANCH_REGEX =
	/^(?!.*\.\.)(?!.*\/[-.])[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

/** Files and folders that say a folder holds sources, whatever the stack. */
const SOURCE_MARKERS = [
	"package.json",
	"apps",
	"src",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"Pipfile",
	"Cargo.toml",
	"go.mod",
	"go.sum",
	"cmd",
	"main.go",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"Rakefile",
	"composer.json",
	"Makefile",
	"CMakeLists.txt",
	"README.md",
	"LICENSE",
];
/** Project files whose name varies (.NET). */
const SOURCE_PATTERNS = ["*.csproj", "*.sln", "*.fsproj"];
/** How many entries of the project folder the patterns are matched against. */
const MAX_ENTRIES_CHECKED = 500;

/**
 * The dependency folders a worktree shares with the project, the ones
 * `apps/backend/core/workspace/workspace_setup.py` links for a task: one
 * that the project lacks or the worktree already has is left alone.
 */
const LINKED_DEPENDENCIES = ["node_modules", path.join("apps", "frontend", "node_modules")];

const CREATE_TIMEOUT =
	"Git operation timed out. The repository may be too large or the network connection is slow. Please try again.";
const REMOVE_TIMEOUT = "Git operation timed out. The repository may be too large. Please try again.";

/** Runs git in `cwd` and gives its output; a call that runs past `timeout` ms is killed. */
async function git(cwd: string, args: string[], timeout: number): Promise<string> {
	const { stdout } = await execFileAsync(getToolPath("git"), args, {
		cwd,
		encoding: "utf-8",
		timeout,
		env: getIsolatedGitEnv(),
	});
	return stdout;
}

function gitSync(cwd: string, args: string[]): string {
	return execFileSync(getToolPath("git"), args, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: getIsolatedGitEnv(),
	}).trim();
}

/** What the renderer is told of a failed operation: a timeout in words, otherwise the error's message. */
function failure(error: unknown, timeoutMessage: string): string {
	return (error as { killed?: boolean }).killed === true ? timeoutMessage : (error as Error).message;
}

function looksLikeSources(projectPath: string): boolean {
	if (SOURCE_MARKERS.some((marker) => existsSync(path.join(projectPath, marker)))) return true;
	let entries: string[];
	try {
		entries = readdirSync(projectPath).slice(0, MAX_ENTRIES_CHECKED);
	} catch (error) {
		debugError("[TerminalWorktree] Failed to read directory:", error);
		return false;
	}
	return entries.some((entry) => SOURCE_PATTERNS.some((pattern) => minimatch(entry, pattern, { nocase: true })));
}

/**
 * A worktree operation can leave `core.bare=true` on a repository that has a
 * working tree, after which every git call in it fails: unset it when the
 * folder holds sources, leave a repository that is bare for real.
 */
function fixMisconfiguredBareRepo(projectPath: string): void {
	try {
		if (gitSync(projectPath, ["config", "--get", "core.bare"]).toLowerCase() !== "true") return;
		if (!looksLikeSources(projectPath)) return;
		gitSync(projectPath, ["config", "--unset", "core.bare"]);
		debugLog("[TerminalWorktree] Unset core.bare on a repository with sources:", projectPath);
	} catch {
		// core.bare is not set (git exits 1), or the folder is not a repository: nothing to fix.
	}
}

function isValidProjectPath(projectPath: string): boolean {
	return projectStore.getProjects().some((p) => p.path === projectPath);
}

/**
 * Get the default branch from project settings OR env config. A configured
 * name that is not a branch name is passed over, as a base branch typed in
 * the dialog is: it becomes an argument of git.
 */
function getDefaultBranch(projectPath: string): string {
	const configured = [
		projectStore.getProjects().find((p) => p.path === projectPath)?.settings?.mainBranch,
		readProjectEnvFile(path.join(projectPath, ".workpilot", ".env")).DEFAULT_BRANCH,
	].find((name): name is string => !!name && GIT_BRANCH_REGEX.test(name));
	if (configured) return configured;

	for (const branch of ["main", "master"]) {
		try {
			gitSync(projectPath, ["rev-parse", "--verify", branch]);
			return branch;
		} catch {
			// Branch doesn't exist, try next
		}
	}
	try {
		return gitSync(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
	} catch (error) {
		debugError("[TerminalWorktree] Error detecting current branch:", error);
		return "main";
	}
}

/**
 * The ref a worktree starts from: `origin/<branch>` when the remote has it
 * (fetched first), the local branch when the dialog asked for it (it keeps
 * gitignored files the remote lacks), a remote ref as named.
 */
async function resolveBaseRef(projectPath: string, baseBranch: string, useLocalBranch: boolean): Promise<string> {
	const isRemoteRef = baseBranch.startsWith("origin/");
	try {
		await git(projectPath, ["fetch", "origin", isRemoteRef ? baseBranch.slice("origin/".length) : baseBranch], 30_000);
	} catch {
		debugLog("[TerminalWorktree] Could not fetch from remote, continuing with local branch");
	}
	if (isRemoteRef || useLocalBranch) return baseBranch;
	try {
		await git(projectPath, ["rev-parse", "--verify", `origin/${baseBranch}`], 10_000);
		return `origin/${baseBranch}`;
	} catch {
		return baseBranch;
	}
}

type Published = { remoteTrackingSetUp: boolean; warning?: string };

/**
 * Pushes a new branch with `-u` so that push and pull work from the
 * worktree; a repository without `origin` has nothing to push to, and a
 * push that fails leaves a usable worktree and a warning.
 */
async function publishBranch(projectPath: string, worktreePath: string, branchName: string): Promise<Published> {
	try {
		await git(projectPath, ["remote", "get-url", "origin"], 5_000);
	} catch {
		return { remoteTrackingSetUp: false };
	}
	try {
		await git(worktreePath, ["push", "-u", "origin", branchName], 30_000);
		return { remoteTrackingSetUp: true };
	} catch (error) {
		return { remoteTrackingSetUp: false, warning: (error as Error).message };
	}
}

function isPresent(target: string): boolean {
	try {
		lstatSync(target); // a link counts, even a broken one
		return true;
	} catch {
		return false;
	}
}

/**
 * Links the project's dependency folders into the worktree, so that its
 * hooks and the IDE work without an install. A link that cannot be made
 * (FAT32, permissions) leaves a usable worktree.
 */
function linkDependencies(projectPath: string, worktreePath: string): void {
	for (const relative of LINKED_DEPENDENCIES) {
		const source = path.join(projectPath, relative);
		const target = path.join(worktreePath, relative);
		if (!existsSync(source) || isPresent(target)) continue;
		try {
			mkdirSync(path.dirname(target), { recursive: true });
			if (isWindows()) {
				symlinkSync(source, target, "junction"); // no admin rights needed, but an absolute path
			} else {
				symlinkSync(path.relative(path.dirname(target), source), target); // relative: the folder can move
			}
		} catch (error) {
			debugError("[TerminalWorktree] Could not link", relative, error);
		}
	}
}

function saveWorktreeConfig(projectPath: string, name: string, config: TerminalWorktreeConfig): void {
	mkdirSync(getTerminalWorktreeMetadataDir(projectPath), { recursive: true });
	writeFileSync(getTerminalWorktreeMetadataPath(projectPath, name), JSON.stringify(config, null, 2), "utf-8");
}

/** A config file of the project: an object, or nothing. */
function readConfig(file: string): TerminalWorktreeConfig | null {
	try {
		const config: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof config === "object" && config !== null && !Array.isArray(config)) {
			return config as TerminalWorktreeConfig;
		}
	} catch (error) {
		debugError("[TerminalWorktree] Unreadable config at:", file, error);
	}
	return null;
}

function loadWorktreeConfig(projectPath: string, name: string): TerminalWorktreeConfig | null {
	const metadataPath = getTerminalWorktreeMetadataPath(projectPath, name);
	if (existsSync(metadataPath)) return readConfig(metadataPath);

	// Worktrees made before the metadata folder kept their config inside: it moves on first read.
	const legacyPath = path.join(getTerminalWorktreePath(projectPath, name), "config.json");
	if (!existsSync(legacyPath)) return null;
	const config = readConfig(legacyPath);
	if (config) {
		saveWorktreeConfig(projectPath, name, config);
		try {
			rmSync(legacyPath);
		} catch {
			debugLog("[TerminalWorktree] Could not remove legacy config:", legacyPath);
		}
	}
	return config;
}

/** Removes what a failed creation left behind, and the registration git may have kept. */
function removeFailedWorktree(projectPath: string, worktreePath: string): void {
	if (!existsSync(worktreePath)) return;
	try {
		rmSync(worktreePath, { recursive: true, force: true });
		gitSync(projectPath, ["worktree", "prune"]);
	} catch (error) {
		debugError("[TerminalWorktree] Failed to cleanup worktree directory:", error);
	}
}

async function createTerminalWorktree(request: CreateTerminalWorktreeRequest): Promise<TerminalWorktreeResult> {
	const { terminalId, name, taskId, createGitBranch, projectPath, baseBranch: chosenBase, useLocalBranch } = request;

	if (!isValidProjectPath(projectPath)) return { success: false, error: "Invalid project path" };
	if (!WORKTREE_NAME_REGEX.test(name)) {
		return {
			success: false,
			error:
				"Invalid worktree name. Use lowercase letters, numbers, dashes, and underscores. Must start and end with alphanumeric.",
		};
	}
	if (chosenBase && !GIT_BRANCH_REGEX.test(chosenBase)) return { success: false, error: "Invalid base branch name" };

	fixMisconfiguredBareRepo(projectPath);

	const worktreePath = getTerminalWorktreePath(projectPath, name);
	if (existsSync(worktreePath)) return { success: false, error: `Worktree '${name}' already exists.` };
	const branchName = `terminal/${name}`;
	const baseBranch = chosenBase || getDefaultBranch(projectPath);

	try {
		mkdirSync(getTerminalWorktreeDir(projectPath), { recursive: true });
		const baseRef = await resolveBaseRef(projectPath, baseBranch, useLocalBranch === true);
		let published: Published = { remoteTrackingSetUp: false };
		if (createGitBranch) {
			// --no-track: the branch must not take origin/<base> as its upstream; the push sets its own.
			await git(projectPath, ["worktree", "add", "-b", branchName, "--no-track", worktreePath, baseRef], 60_000);
			published = await publishBranch(projectPath, worktreePath, branchName);
		} else {
			await git(projectPath, ["worktree", "add", "--detach", worktreePath, baseRef], 60_000);
		}
		linkDependencies(projectPath, worktreePath);

		const config: TerminalWorktreeConfig = {
			name,
			worktreePath,
			branchName: createGitBranch ? branchName : "",
			baseBranch,
			hasGitBranch: createGitBranch,
			taskId,
			createdAt: new Date().toISOString(),
			terminalId,
			remoteTrackingSetUp: published.remoteTrackingSetUp,
		};
		saveWorktreeConfig(projectPath, name, config);
		return { success: true, config, warning: published.warning };
	} catch (error) {
		debugError("[TerminalWorktree] Error creating worktree:", error);
		removeFailedWorktree(projectPath, worktreePath);
		return { success: false, error: failure(error, CREATE_TIMEOUT) };
	}
}

function listEntries(folder: string): Dirent[] {
	if (!existsSync(folder)) return [];
	try {
		return readdirSync(folder, { withFileTypes: true });
	} catch (error) {
		debugError("[TerminalWorktree] Error scanning:", folder, error);
		return [];
	}
}

/**
 * The project's terminal worktrees: those with metadata whose folder is still
 * there (the metadata of a deleted one is removed), then older ones whose
 * config is inside the folder.
 */
function listTerminalWorktrees(projectPath: string): TerminalWorktreeConfig[] {
	if (!isValidProjectPath(projectPath)) return [];

	const configs: TerminalWorktreeConfig[] = [];
	const seen = new Set<string>();
	const metadataDir = getTerminalWorktreeMetadataDir(projectPath);
	for (const file of listEntries(metadataDir)) {
		if (!file.isFile() || !file.name.endsWith(".json")) continue;
		const name = file.name.slice(0, -".json".length);
		const config = loadWorktreeConfig(projectPath, name);
		if (!config) continue;
		if (existsSync(config.worktreePath)) {
			configs.push(config);
			seen.add(name);
			continue;
		}
		try {
			rmSync(path.join(metadataDir, file.name));
		} catch (error) {
			debugError("[TerminalWorktree] Failed to cleanup stale metadata:", file.name, error);
		}
	}
	for (const dir of listEntries(getTerminalWorktreeDir(projectPath))) {
		if (!dir.isDirectory() || seen.has(dir.name)) continue;
		const config = loadWorktreeConfig(projectPath, dir.name);
		if (config) configs.push(config);
	}
	return configs;
}

/** A path as the file system names it (links resolved, and the case on Windows), so that git's paths compare. */
function canonical(target: string): string {
	try {
		return realpathSync.native(target);
	} catch {
		return path.resolve(target);
	}
}

/** The value of the porcelain line that starts with `key `, if any. */
function porcelainValue(lines: string[], key: string): string | undefined {
	return lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
}

/**
 * The worktrees WorkPilot does not manage, from `git worktree list`: neither
 * the project itself nor anything under `.workpilot/worktrees/{terminal,tasks,pr}`.
 */
async function listOtherWorktrees(projectPath: string): Promise<OtherWorktreeInfo[]> {
	if (!isValidProjectPath(projectPath)) return [];

	const root = canonical(projectPath);
	const managed = ["terminal", "tasks", "pr"].map((kind) => path.join(root, ".workpilot", "worktrees", kind));
	let output: string;
	try {
		output = await git(projectPath, ["worktree", "list", "--porcelain"], 30_000);
	} catch (error) {
		debugError("[TerminalWorktree] Error listing other worktrees:", error);
		return [];
	}

	const results: OtherWorktreeInfo[] = [];
	for (const block of output.split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const listed = porcelainValue(lines, "worktree");
		const head = porcelainValue(lines, "HEAD");
		if (!listed || !head) continue; // a bare entry has no HEAD
		const worktreePath = canonical(listed);
		if (worktreePath === root) continue;
		if (managed.some((dir) => worktreePath === dir || worktreePath.startsWith(dir + path.sep))) continue;
		results.push({
			path: worktreePath,
			branch: porcelainValue(lines, "branch")?.replace("refs/heads/", "") ?? null, // null: detached HEAD
			commitSha: head.substring(0, 8),
			displayName: path.basename(worktreePath),
		});
	}
	return results;
}

async function removeTerminalWorktree(projectPath: string, name: string, deleteBranch = false): Promise<IPCResult> {
	if (!isValidProjectPath(projectPath)) return { success: false, error: "Invalid project path" };
	if (!WORKTREE_NAME_REGEX.test(name)) return { success: false, error: "Invalid worktree name" };

	fixMisconfiguredBareRepo(projectPath);

	const worktreePath = getTerminalWorktreePath(projectPath, name);
	const config = loadWorktreeConfig(projectPath, name);
	if (!config) return { success: false, error: "Worktree not found" };

	try {
		if (existsSync(worktreePath)) {
			await git(projectPath, ["worktree", "remove", "--force", worktreePath], 60_000);
		}
		// The branch name comes from a file in the project: checked again before it reaches git.
		const branch = config.hasGitBranch ? config.branchName : "";
		if (deleteBranch && branch && GIT_BRANCH_REGEX.test(branch)) {
			try {
				await git(projectPath, ["branch", "-D", branch], 30_000);
			} catch {
				debugLog("[TerminalWorktree] Branch not found or already deleted:", branch);
			}
		}
		rmSync(getTerminalWorktreeMetadataPath(projectPath, name), { force: true });
		return { success: true };
	} catch (error) {
		debugError("[TerminalWorktree] Error removing worktree:", error);
		return { success: false, error: failure(error, REMOVE_TIMEOUT) };
	}
}

export function registerTerminalWorktreeHandlers(): void {
	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_WORKTREE_CREATE, (_, request: CreateTerminalWorktreeRequest) =>
		createTerminalWorktree(request),
	);
	terminalIpcMain.handle(
		IPC_CHANNELS.TERMINAL_WORKTREE_LIST,
		(_, projectPath: string): IPCResult<TerminalWorktreeConfig[]> => ({
			success: true,
			data: listTerminalWorktrees(projectPath),
		}),
	);
	terminalIpcMain.handle(IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE, (_, projectPath: string, name: string, deleteBranch?: boolean) =>
		removeTerminalWorktree(projectPath, name, deleteBranch),
	);
	terminalIpcMain.handle(
		IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER,
		async (_, projectPath: string): Promise<IPCResult<OtherWorktreeInfo[]>> => ({
			success: true,
			data: await listOtherWorktrees(projectPath),
		}),
	);
}
