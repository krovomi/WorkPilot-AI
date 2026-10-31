/**
 * Reading, writing and deleting files inside a task's worktree.
 * Split out of worktree-handlers.ts (plan of 29 October, N8 A2).
 */
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { detectGitDefaultBranch } from "./worktree-git-refs";
import {
	resolveUnder,
	resolveWritableUnder,
} from "../../security/renderer-path";

export function registerWorktreeFileHandlers(): void {
	// Promisified execFile for async git operations
	const execFileAsync = promisify(execFile);

	/**
	 * Read a file from a worktree
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_READ_FILE,
		async (
			_,
			worktreePath: string,
			relativePath: string,
		): Promise<IPCResult<string>> => {
			try {
				// Resolved, links included, and still inside the worktree.
				const resolved = resolveUnder(worktreePath, relativePath, "file");
				if (!resolved) {
					return { success: false, error: "Path traversal not allowed" };
				}

				const content = await fsPromises.readFile(resolved, "utf-8");
				return { success: true, data: content };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to read file",
				};
			}
		},
	);

	/**
	 * Write a file to a worktree
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE,
		async (
			_,
			worktreePath: string,
			relativePath: string,
			content: string,
		): Promise<IPCResult<{ written: boolean }>> => {
			try {
				// Inside the worktree once its existing part is resolved: a link
				// in the worktree does not carry the write elsewhere.
				const resolved = resolveWritableUnder(worktreePath, relativePath);
				if (!resolved) {
					return { success: false, error: "Path traversal not allowed" };
				}

				// Ensure parent directory exists
				await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
				await fsPromises.writeFile(resolved, content, "utf-8");

				return { success: true, data: { written: true } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to write file",
				};
			}
		},
	);

	/**
	 * Discard changes to files in a worktree (git checkout)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DELETE_FILES,
		async (
			_,
			worktreePath: string,
			relativePaths: string[],
		): Promise<IPCResult<{ deleted: string[]; failed: string[] }>> => {
			const deleted: string[] = [];
			const failed: string[] = [];
			if (!Array.isArray(relativePaths)) {
				return { success: false, error: "Expected a list of paths" };
			}
			const resolvedWorktree = path.resolve(worktreePath);
			// Discarding means "restore this file to the base branch's version".
			// Which branch that is depends on the project — never assume one.
			const baseBranch = detectGitDefaultBranch(resolvedWorktree);
			const gitPath = getToolPath("git");

			// Load existing discard list
			const discardListPath = path.join(
				resolvedWorktree,
				".workpilot-discard-list",
			);
			let discardedFiles: string[] = [];
			try {
				const content = await fsPromises.readFile(discardListPath, "utf-8");
				discardedFiles = content
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"));
			} catch {
				// File doesn't exist yet
			}

			for (const relativePath of relativePaths) {
				try {
					// Security: validate path stays within worktree
					const resolved = resolveWritableUnder(resolvedWorktree, relativePath);
					if (!resolved) {
						failed.push(relativePath);
						continue;
					}

					// Discard changes: sync file state with the base branch.
					// execFileAsync (argv array), NOT a shell template string:
					// `relativePath` is a filename from the repo, and the
					// containment check above says nothing about shell
					// metacharacters. A file named `a" & calc & ".txt` in a
					// cloned repo would otherwise run as a command here.
					const statusResult = await execFileAsync(
						gitPath,
						["status", "--porcelain", "--", relativePath],
						{ cwd: resolvedWorktree },
					);
					const statusOutput = statusResult.stdout.trim();

					if (statusOutput.startsWith("??")) {
						// Untracked file, just remove it
						try {
							await fsPromises.unlink(resolved);
						} catch (err) {
							// Ignore if file doesn't exist
							if (
								!(err instanceof Error) ||
								!err.message.includes("ENOENT")
							) {
								throw err;
							}
						}
					} else if (statusOutput) {
						// File is tracked: reset to the base branch's version
						await execFileAsync(
							gitPath,
							["reset", baseBranch, "--", relativePath],
							{ cwd: resolvedWorktree },
						);
						// Then checkout the file from the base branch to match exactly
						await execFileAsync(
							gitPath,
							["checkout", baseBranch, "--", relativePath],
							{ cwd: resolvedWorktree },
						);
					}

					// Add to discard list so backend excludes it from merge preview
					if (!discardedFiles.includes(relativePath)) {
						discardedFiles.push(relativePath);
					}

					deleted.push(relativePath);
				} catch (error) {
					console.error(
						`[WORKTREE_DISCARD] Failed to discard changes to ${relativePath}:`,
						error,
					);
					failed.push(relativePath);
				}
			}

			// Write discard list for backend to read
			if (discardedFiles.length > 0) {
				await fsPromises.writeFile(
					discardListPath,
					discardedFiles
						.map((f) => f.trim())
						.join("\n")
						.concat("\n"),
					"utf-8",
				);
			}

			return { success: true, data: { deleted, failed } };
		},
	);
}
