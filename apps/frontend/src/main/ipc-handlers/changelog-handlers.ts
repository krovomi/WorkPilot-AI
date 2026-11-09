import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../../shared/constants";
import type {
	BranchDiffOptions,
	ChangelogGenerationRequest,
	ChangelogSaveRequest,
	ChangelogSaveResult,
	ChangelogTask,
	ExistingChangelog,
	GitBranchInfo,
	GitCommit,
	GitHistoryOptions,
	GitTagInfo,
	IPCResult,
	Task,
	TaskSpecContent,
} from "../../shared/types";
import {
	STAGED_ASSETS_DIR,
	saveChangelogForReview,
	stagedAsset,
} from "../changelog/changelog-review";
import { findOpenReviewCard } from "../generated-review/review-card";
import { changelogService } from "../changelog-service";
import { projectStore } from "../project-store";
import { resolveKnownProject, resolveUnder } from "../security/renderer-path";
import { getServerProject } from "../server-projects";
import {
	generateServerChangelog,
	saveServerChangelog,
	serverChangelogCommits,
	serverChangelogDoneTasks,
	serverChangelogSources,
	serverChangelogSpecs,
	suggestVersionFromCommitTypes,
} from "./server-changelog";

/** The images the changelog view may read back, by extension. */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/** A server project's changelog has no file or image on this computer. */
const NOT_ON_SERVER = "Not available for a server project";

/**
 * Register all changelog-related IPC handlers. A server project's changelog
 * is the server's (`server-changelog.ts`): each handler sends it there.
 */
export function registerChangelogHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// ============================================
	// Changelog Event Handlers
	// ============================================

	changelogService.on(
		"generation-progress",
		(
			projectId: string,
			progress: import("../../shared/types").ChangelogGenerationProgress,
		) => {
			const mainWindow = getMainWindow();
			if (mainWindow) {
				mainWindow.webContents.send(
					IPC_CHANNELS.CHANGELOG_GENERATION_PROGRESS,
					projectId,
					progress,
				);
			}
		},
	);

	changelogService.on(
		"generation-complete",
		(
			projectId: string,
			result: import("../../shared/types").ChangelogGenerationResult,
		) => {
			const mainWindow = getMainWindow();
			if (mainWindow) {
				mainWindow.webContents.send(
					IPC_CHANNELS.CHANGELOG_GENERATION_COMPLETE,
					projectId,
					result,
				);
			}
		},
	);

	changelogService.on(
		"generation-error",
		(projectId: string, error: string) => {
			const mainWindow = getMainWindow();
			if (mainWindow) {
				mainWindow.webContents.send(
					IPC_CHANNELS.CHANGELOG_GENERATION_ERROR,
					projectId,
					error,
				);
			}
		},
	);

	changelogService.on(
		"rate-limit",
		(
			_projectId: string,
			rateLimitInfo: import("../../shared/types").SDKRateLimitInfo,
		) => {
			const mainWindow = getMainWindow();
			if (mainWindow) {
				mainWindow.webContents.send(
					IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT,
					rateLimitInfo,
				);
			}
		},
	);

	// ============================================
	// Changelog Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_GET_DONE_TASKS,
		async (
			_,
			projectId: string,
			rendererTasks?: Task[],
		): Promise<IPCResult<ChangelogTask[]>> => {
			const remote = getServerProject(projectId);
			if (remote) return serverChangelogDoneTasks(remote);
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// Use renderer tasks if provided (they have the correct UI status),
			// otherwise fall back to reading from filesystem
			const tasks = rendererTasks || projectStore.getTasks(projectId);

			// Get specs directory path
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const doneTasks = changelogService.getCompletedTasks(
				project.path,
				tasks,
				specsBaseDir,
			);

			return { success: true, data: doneTasks };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_LOAD_TASK_SPECS,
		async (
			_,
			projectId: string,
			taskIds: string[],
		): Promise<IPCResult<TaskSpecContent[]>> => {
			const remote = getServerProject(projectId);
			if (remote) return serverChangelogSpecs(remote, taskIds);
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const tasks = projectStore.getTasks(projectId);

			// Get specs directory path
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specs = await changelogService.loadTaskSpecs(
				project.path,
				taskIds,
				tasks,
				specsBaseDir,
			);

			return { success: true, data: specs };
		},
	);

	ipcMain.on(
		IPC_CHANNELS.CHANGELOG_GENERATE,
		async (_, request: ChangelogGenerationRequest) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) return;

			const remote = getServerProject(request?.projectId);
			if (remote) {
				await generateServerChangelog(remote, request, {
					progress: (id, progress) =>
						changelogService.emit("generation-progress", id, progress),
					complete: (id, result) =>
						changelogService.emit("generation-complete", id, result),
					error: (id, error) => {
						changelogService.emit("generation-progress", id, {
							stage: "error",
							progress: 0,
							message: error,
							error,
						});
						changelogService.emit("generation-error", id, error);
					},
				});
				return;
			}

			const project = projectStore.getProject(request.projectId);
			if (!project) {
				mainWindow.webContents.send(
					IPC_CHANNELS.CHANGELOG_GENERATION_ERROR,
					request.projectId,
					"Project not found",
				);
				return;
			}

			// Load specs for selected tasks (only in tasks mode)
			let specs: TaskSpecContent[] = [];
			if (
				request.sourceMode === "tasks" &&
				request.taskIds &&
				request.taskIds.length > 0
			) {
				const tasks = projectStore.getTasks(request.projectId);
				const specsBaseDir = getSpecsDir(project.autoBuildPath);
				specs = await changelogService.loadTaskSpecs(
					project.path,
					request.taskIds,
					tasks,
					specsBaseDir,
				);
			}

			// Start generation
			changelogService.generateChangelog(
				request.projectId,
				project.path,
				request,
				specs,
			);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_SAVE,
		async (
			_,
			request: ChangelogSaveRequest,
		): Promise<IPCResult<ChangelogSaveResult>> => {
			// A server project's changelog is kept on the server, for the team.
			const remote = getServerProject(request?.projectId);
			if (remote) return saveServerChangelog(remote, request.content);
			const project = projectStore.getProject(request.projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				// On a review card's branch, never in the project folder.
				const result = await saveChangelogForReview(project.path, request, (root, req) =>
					changelogService.saveChangelog(root, req),
				);
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to save changelog",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_READ_EXISTING,
		async (_, projectId: string): Promise<IPCResult<ExistingChangelog>> => {
			const remote = getServerProject(projectId);
			if (remote) {
				const sources = await serverChangelogSources(remote);
				return sources.success && sources.data
					? { success: true, data: sources.data.existing }
					: { success: false, error: sources.error };
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// A version saved but not merged yet lives on the open changelog card.
			const open = findOpenReviewCard(project, "changelog");
			const result = changelogService.readExistingChangelog(open?.worktreePath ?? project.path);
			return { success: true, data: result };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_SUGGEST_VERSION,
		async (
			_,
			projectId: string,
			taskIds: string[],
		): Promise<IPCResult<{ version: string; reason: string }>> => {
			const remote = getServerProject(projectId);
			const project = remote ?? projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				// Get current version from existing changelog
				const existing = remote
					? (await serverChangelogSources(remote)).data?.existing
					: changelogService.readExistingChangelog(project.path);
				const currentVersion = existing?.lastVersion;

				// Load specs for selected tasks to analyze change types
				const specs = remote
					? ((await serverChangelogSpecs(remote, taskIds)).data ?? [])
					: await changelogService.loadTaskSpecs(
							project.path,
							taskIds,
							projectStore.getTasks(projectId),
							getSpecsDir(project.autoBuildPath),
						);

				// Analyze specs and suggest version
				const suggestedVersion = changelogService.suggestVersion(
					specs,
					currentVersion,
				);

				// Determine reason for the suggestion
				let reason = "patch";
				if (currentVersion) {
					const [oldMajor, oldMinor] = currentVersion.split(".").map(Number);
					const [newMajor, newMinor] = suggestedVersion.split(".").map(Number);
					if (newMajor > oldMajor) {
						reason = "breaking";
					} else if (newMinor > oldMinor) {
						reason = "feature";
					}
				}

				return {
					success: true,
					data: { version: suggestedVersion, reason },
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to suggest version",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_SUGGEST_VERSION_FROM_COMMITS,
		async (
			_,
			projectId: string,
			commits: GitCommit[],
		): Promise<IPCResult<{ version: string; reason: string }>> => {
			const remote = getServerProject(projectId);
			if (remote) {
				// Nothing of a server project goes to a model on this computer.
				const sources = await serverChangelogSources(remote);
				const current =
					sources.data?.existing.lastVersion ??
					sources.data?.tags[0]?.name.replace(/^v/, "");
				return {
					success: true,
					data: suggestVersionFromCommitTypes(commits, current),
				};
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				// Get current version from existing changelog or git tags
				const existing = changelogService.readExistingChangelog(project.path);
				let currentVersion = existing.lastVersion;

				// If no version in changelog, try to get latest tag
				if (!currentVersion) {
					const tags = changelogService.getTags(project.path);
					if (tags.length > 0) {
						// Extract version from tag name (e.g., "v2.1.0" -> "2.1.0")
						currentVersion = tags[0].name.replace(/^v/, "");
					}
				}

				// Use AI to analyze commits and suggest version
				const result = await changelogService.suggestVersionFromCommits(
					project.path,
					commits,
					currentVersion,
				);

				return {
					success: true,
					data: result,
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to suggest version from commits",
				};
			}
		},
	);

	// ============================================
	// Changelog Git Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_GET_BRANCHES,
		async (_, projectId: string): Promise<IPCResult<GitBranchInfo[]>> => {
			const remote = getServerProject(projectId);
			if (remote) {
				const sources = await serverChangelogSources(remote);
				return sources.success && sources.data
					? { success: true, data: sources.data.branches }
					: { success: false, error: sources.error };
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				const branches = changelogService.getBranches(project.path);
				return { success: true, data: branches };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to get branches",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_GET_TAGS,
		async (_, projectId: string): Promise<IPCResult<GitTagInfo[]>> => {
			const remote = getServerProject(projectId);
			if (remote) {
				const sources = await serverChangelogSources(remote);
				return sources.success && sources.data
					? { success: true, data: sources.data.tags }
					: { success: false, error: sources.error };
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				const tags = changelogService.getTags(project.path);
				return { success: true, data: tags };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Failed to get tags",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_GET_COMMITS_PREVIEW,
		async (
			_,
			projectId: string,
			options: GitHistoryOptions | BranchDiffOptions,
			mode: "git-history" | "branch-diff",
		): Promise<IPCResult<GitCommit[]>> => {
			const remote = getServerProject(projectId);
			if (remote) {
				return serverChangelogCommits(
					remote,
					options,
					mode === "branch-diff" ? "branch-diff" : "git-history",
				);
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			try {
				let commits: GitCommit[];

				if (mode === "git-history") {
					commits = changelogService.getCommits(
						project.path,
						options as GitHistoryOptions,
					);
				} else {
					commits = changelogService.getBranchDiffCommits(
						project.path,
						options as BranchDiffOptions,
					);
				}

				return { success: true, data: commits };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to get commits preview",
				};
			}
		},
	);

	// ============================================
	// Changelog Image Operations
	// ============================================

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_SAVE_IMAGE,
		async (
			_,
			projectId: string,
			imageData: string,
			filename: string,
		): Promise<IPCResult<{ relativePath: string; url: string }>> => {
			if (getServerProject(projectId)) {
				return { success: false, error: NOT_ON_SERVER };
			}
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			// A bare file name with an image extension: nothing that climbs out
			// of the assets folder or lands as something else.
			if (
				typeof filename !== "string" ||
				filename !== path.basename(filename) ||
				filename.startsWith(".") ||
				!IMAGE_MIME_TYPES[path.extname(filename).toLowerCase()]
			) {
				return { success: false, error: "Invalid image file name" };
			}

			try {
				// Kept out of the checkout until « Enregistrer » commits it, with
				// the text, on the review card's branch (changelog-review.ts).
				const assetsDir = path.join(project.path, STAGED_ASSETS_DIR);
				if (!existsSync(assetsDir)) {
					mkdirSync(assetsDir, { recursive: true });
				}

				// Decode base64 image data
				const base64Data = imageData.includes(",")
					? imageData.split(",")[1]
					: imageData;
				const buffer = Buffer.from(base64Data, "base64");

				// Save image file
				const imagePath = path.join(assetsDir, filename);
				writeFileSync(imagePath, buffer);

				// Return relative path for use in markdown
				const relativePath = `.github/assets/${filename}`;
				// For GitHub releases, we'll use the relative path which will work when the release is created
				const url = relativePath;

				return { success: true, data: { relativePath, url } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to save image",
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CHANGELOG_READ_LOCAL_IMAGE,
		async (
			_,
			projectPath: string,
			relativePath: string,
		): Promise<IPCResult<string>> => {
			try {
				// The project must be one the user added, and the image a file
				// inside it once resolved: the renderer names, the main decides.
				const projectDir = resolveKnownProject(projectPath);
				// A pasted image waits outside the checkout until the save.
				const fullPath =
					projectDir &&
					(stagedAsset(projectDir, relativePath) ??
						resolveUnder(projectDir, relativePath, "file"));
				const mimeType =
					typeof relativePath === "string"
						? IMAGE_MIME_TYPES[path.extname(relativePath).toLowerCase()]
						: undefined;
				if (!fullPath || !mimeType) {
					return { success: false, error: "Image not found in this project" };
				}

				const base64 = readFileSync(fullPath).toString("base64");

				// Return as data URL
				const dataUrl = `data:${mimeType};base64,${base64}`;
				return { success: true, data: dataUrl };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to read image",
				};
			}
		},
	);

	// ============================================
	// Changelog Agent Events → Renderer
}
