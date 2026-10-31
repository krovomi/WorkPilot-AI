/**
 * The worktree's diff and one file's diff, against the task's base branch.
 * Split out of worktree-handlers.ts (plan of 29 October, N8 A2).
 */
import { execFileSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	WorktreeDiff,
	WorktreeDiffFile,
} from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { findServerCard } from "../../server-board-actions";
import { serverFileDiff, serverWorktreeDiff } from "../../server-board-review";
import { findTaskWorktree } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";
import {
	getEffectiveBaseBranch,
	resolveDiffRefs,
} from "./worktree-git-refs";

export function registerWorktreeDiffHandlers(): void {
	/**
	 * Get the diff for a task's worktree
	 * Per-spec architecture: Each spec has its own worktree at .workpilot/worktrees/tasks/{spec-name}/
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DIFF,
		async (_, taskId: string): Promise<IPCResult<WorktreeDiff>> => {
			const serverCard = findServerCard(taskId);
			if (serverCard) return serverWorktreeDiff(serverCard);
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Find worktree at .workpilot/worktrees/tasks/{spec-name}/
				const worktreePath = findTaskWorktree(project.path, task.specId);

				if (!worktreePath) {
					return { success: false, error: "No worktree found for this task" };
				}

				// Get base branch using proper fallback chain:
				// 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
				// Note: We do NOT use current HEAD as that may be a feature branch
				const baseBranch = getEffectiveBaseBranch(
					project.path,
					task.specId,
					project.settings?.mainBranch,
				);

				// Récupère la branche du worktree pour pouvoir préférer
				// `origin/<branch>` quand elle existe (alignement avec la PR).
				let worktreeBranch = "HEAD";
				try {
					worktreeBranch = execFileSync(
						getToolPath("git"),
						["rev-parse", "--abbrev-ref", "HEAD"],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();
				} catch {
					// fallback à HEAD - resolveDiffRefs gérera l'absence de origin/
				}
				const diffRefs = resolveDiffRefs(
					worktreePath,
					worktreeBranch,
					baseBranch,
				);
				const diffRange = `${diffRefs.baseRef}...${diffRefs.headRef}`;

				// Get the diff with file stats
				const files: WorktreeDiffFile[] = [];

				try {
					// Single atomic git call: status, stats and patch all come from the
					// same snapshot, preventing a race where separate numstat/fullDiff
					// invocations could see different HEAD commits on an
					// actively-committing worktree (causing additions > 0 but patch = "").
					const fullDiff = execFileSync(
						getToolPath("git"),
						["diff", diffRange],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();

					// Split into per-file sections by walking the diff line by line.
					const sections: string[] = [];
					let currentLines: string[] = [];
					for (const line of fullDiff.split("\n")) {
						if (line.startsWith("diff --git ")) {
							if (currentLines.length > 0) sections.push(currentLines.join("\n"));
							currentLines = [line];
						} else {
							currentLines.push(line);
						}
					}
					if (currentLines.length > 0) sections.push(currentLines.join("\n"));

					for (const section of sections) {
						const headerMatch = section.match(/^diff --git a\/(.*) b\/(.*)$/m);
						if (!headerMatch) continue;

						// Use the b/ (destination) path as canonical — correct for renames too.
						const filePath = headerMatch[2];

						let status: "added" | "modified" | "deleted" | "renamed" =
							"modified";
						if (/^new file mode/m.test(section)) status = "added";
						else if (/^deleted file mode/m.test(section)) status = "deleted";
						else if (/^rename from /m.test(section)) status = "renamed";

						// Count additions/deletions from the same content as the patch.
						let additions = 0;
						let deletions = 0;
						for (const line of section.split("\n")) {
							if (line.startsWith("+") && !line.startsWith("+++")) additions++;
							else if (line.startsWith("-") && !line.startsWith("---"))
								deletions++;
						}

						files.push({
							path: filePath,
							status,
							additions,
							deletions,
							patch: section || undefined,
						});
					}
				} catch (diffError) {
					console.error("Error getting diff:", diffError);
				}

				// Load and apply discard list filter
				const discardListPath = path.join(
					worktreePath,
					".workpilot-discard-list",
				);
				let discardedFiles: string[] = [];
				try {
					const content = await fsPromises.readFile(
						discardListPath,
						"utf-8",
					);
					discardedFiles = content
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line && !line.startsWith("#"));
					if (discardedFiles.length > 0) {
						console.error(
							`[TASK_WORKTREE_DIFF] Loaded ${discardedFiles.length} discarded files:`,
							discardedFiles,
						);
					}
				} catch (err) {
					// .workpilot-discard-list est optionnel : ENOENT est normal
					// quand l'utilisateur n'a discardé aucun fichier. Seuls les
					// autres types d'erreur (permissions, EIO…) sont remontés.
					const isMissing =
						err instanceof Error &&
						(err as NodeJS.ErrnoException).code === "ENOENT";
					if (!isMissing) {
						console.error(
							"[TASK_WORKTREE_DIFF] Error reading discard list:",
							err,
						);
					}
				}

				// Filter out discarded files from the diff
				const isWorkpilotArtifact = (p: string): boolean => {
					const normalized = p.replaceAll("\\", "/");
					return (
						normalized === ".workpilot" ||
						normalized.startsWith(".workpilot/") ||
						normalized.startsWith(".workpilot-")
					);
				};
				const filteredFiles = files.filter(
					(file) =>
						!discardedFiles.includes(file.path) &&
						!isWorkpilotArtifact(file.path),
				);
				if (discardedFiles.length > 0) {
					console.error(
						`[TASK_WORKTREE_DIFF] Filtered from ${files.length} to ${filteredFiles.length} files`,
					);
				}

				// Generate summary
				const totalAdditions = filteredFiles.reduce(
					(sum, f) => sum + f.additions,
					0,
				);
				const totalDeletions = filteredFiles.reduce(
					(sum, f) => sum + f.deletions,
					0,
				);
				const summary = `${filteredFiles.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`;

				return {
					success: true,
					data: { files: filteredFiles, summary },
				};
			} catch (error) {
				console.error("Failed to get worktree diff:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to get worktree diff",
				};
			}
		},
	);

	/**
	 * Get the diff for a single impacted file, on demand.
	 *
	 * Contrairement à TASK_WORKTREE_DIFF (qui n'expose que les changements
	 * commités via `base...head`), ce handler tente plusieurs stratégies afin de
	 * toujours pouvoir montrer les lignes modifiées d'un fichier impacté :
	 *   1. plage commitée `base...head`,
	 *   2. changements non commités vs `HEAD`,
	 *   3. arbre de travail vs index,
	 *   4. fichier non suivi (synthétise un patch « ajouté »).
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_FILE_DIFF,
		async (
			_,
			taskId: string,
			filePath: string,
		): Promise<IPCResult<WorktreeDiffFile>> => {
			const serverCard = findServerCard(taskId);
			if (serverCard) return serverFileDiff(serverCard, filePath);
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (!worktreePath) {
					return { success: false, error: "No worktree found for this task" };
				}

				// Normalise et protège contre la traversée de chemin.
				const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
				if (
					!normalized ||
					normalized.split("/").some((segment) => segment === "..")
				) {
					return { success: false, error: "Invalid file path" };
				}

				const git = getToolPath("git");
				const runGit = (args: string[]): string => {
					try {
						return execFileSync(git, args, {
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						}).trim();
					} catch {
						return "";
					}
				};

				const baseBranch = getEffectiveBaseBranch(
					project.path,
					task.specId,
					project.settings?.mainBranch,
				);
				let worktreeBranch = "HEAD";
				try {
					worktreeBranch = execFileSync(
						git,
						["rev-parse", "--abbrev-ref", "HEAD"],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();
				} catch {
					// fallback à HEAD
				}
				const diffRefs = resolveDiffRefs(
					worktreePath,
					worktreeBranch,
					baseBranch,
				);
				const diffRange = `${diffRefs.baseRef}...${diffRefs.headRef}`;

				const parseStatus = (
					nameStatus: string,
				): WorktreeDiffFile["status"] => {
					const first = nameStatus.split("\n").filter(Boolean)[0];
					switch (first?.[0]) {
						case "A":
							return "added";
						case "D":
							return "deleted";
						case "R":
							return "renamed";
						default:
							return "modified";
					}
				};
				const parseNumstat = (
					numstat: string,
				): { additions: number; deletions: number } => {
					const first = numstat.split("\n").filter(Boolean)[0];
					if (!first) return { additions: 0, deletions: 0 };
					const [adds, dels] = first.split("\t");
					return {
						additions: Number.parseInt(adds, 10) || 0,
						deletions: Number.parseInt(dels, 10) || 0,
					};
				};

				const tryDiff = (spec: string[]): WorktreeDiffFile | null => {
					const patch = runGit(["diff", ...spec, "--", normalized]);
					if (!patch) return null;
					const numstat = runGit([
						"diff",
						...spec,
						"--numstat",
						"--",
						normalized,
					]);
					const nameStatus = runGit([
						"diff",
						...spec,
						"--name-status",
						"--",
						normalized,
					]);
					const { additions, deletions } = parseNumstat(numstat);
					return {
						path: normalized,
						status: parseStatus(nameStatus),
						additions,
						deletions,
						patch,
					};
				};

				let result =
					tryDiff([diffRange]) ?? tryDiff(["HEAD"]) ?? tryDiff([]);

				// Fichier non suivi : git diff ne renvoie rien → patch synthétique.
				if (!result) {
					const porcelain = runGit([
						"status",
						"--porcelain",
						"--",
						normalized,
					]);
					if (porcelain.startsWith("??")) {
						const content = await fsPromises
							.readFile(path.join(worktreePath, normalized), "utf-8")
							.catch(() => "");
						const lines = content.split("\n");
						const body = lines.map((line) => `+${line}`).join("\n");
						result = {
							path: normalized,
							status: "added",
							additions: lines.length,
							deletions: 0,
							patch:
								`diff --git a/${normalized} b/${normalized}\n` +
								`--- /dev/null\n+++ b/${normalized}\n` +
								`@@ -0,0 +1,${lines.length} @@\n${body}`,
						};
					}
				}

				// Aucun changement détecté : réponse neutre (l'UI affiche « no diff »).
				if (!result) {
					return {
						success: true,
						data: {
							path: normalized,
							status: "modified",
							additions: 0,
							deletions: 0,
							patch: undefined,
						},
					};
				}

				return { success: true, data: result };
			} catch (error) {
				console.error("Failed to get file diff:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to get file diff",
				};
			}
		},
	);
}
