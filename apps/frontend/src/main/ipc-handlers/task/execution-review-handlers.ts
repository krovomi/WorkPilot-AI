/**
 * Reviewing a task: approve, or reject with feedback.
 * Split out of execution-handlers.ts (plan of 29 October, N8 A2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import type { ImageAttachment, IPCResult } from "../../../shared/types";
import { appLog } from "../../app-logger";
import { recordPlanFeedback } from "../../review-lessons";
import { getToolPath } from "../../cli-tool-manager";
import { taskStateManager } from "../../task-state-manager";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { findTaskWorktree } from "../../worktree-paths";
import {
	buildChangeRequestSubtask,
	addChangeRequestSubtaskToPlan,
} from "./plan-file-utils";
import { findTaskAndProject } from "./shared";
import { updateExistingFile } from "../../utils/existing-file";
import { type ExecutionHandlerContext } from "./execution-utils";

export function registerTaskReviewHandlers(ctx: ExecutionHandlerContext): void {
	const { agentManager } = ctx;

	/**
	 * Review a task (approve or reject)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_REVIEW,
		async (
			_,
			taskId: string,
			approved: boolean,
			feedback?: string,
			images?: ImageAttachment[],
		): Promise<IPCResult> => {
			// Find task and project
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Check if dev mode is enabled for this project
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);

			// Check if worktree exists - QA needs to run in the worktree where the build happened
			const worktreePath = findTaskWorktree(project.path, task.specId);
			const worktreeSpecDir = worktreePath
				? path.join(worktreePath, specsBaseDir, task.specId)
				: null;
			const hasWorktree = worktreePath !== null;

			if (approved) {
				// Write approval to QA report
				const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
				try {
					writeFileSync(
						qaReportPath,
						`# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`,
						"utf-8",
					);
				} catch (error) {
					appLog.error("[TASK_REVIEW] Failed to write QA report:", error);
					return { success: false, error: "Failed to write QA report file" };
				}

				taskStateManager.handleUiEvent(
					taskId,
					{ type: "MARK_DONE" },
					task,
					project,
				);
			} else {
				// Reset and discard all changes from worktree merge in main
				// The worktree still has all changes, so nothing is lost
				if (hasWorktree) {
					// Step 1: Unstage all changes
					const resetResult = spawnSync(getToolPath("git"), ["reset", "HEAD"], {
						cwd: project.path,
						encoding: "utf-8",
						stdio: "pipe",
						env: getIsolatedGitEnv(),
					});
					if (resetResult.status === 0) {
						appLog.info("[TASK_REVIEW] Unstaged changes in main");
					}

					// Step 2: Discard all working tree changes (restore to pre-merge state)
					const checkoutResult = spawnSync(
						getToolPath("git"),
						["checkout", "--", "."],
						{
							cwd: project.path,
							encoding: "utf-8",
							stdio: "pipe",
							env: getIsolatedGitEnv(),
						},
					);
					if (checkoutResult.status === 0) {
						appLog.info("[TASK_REVIEW] Discarded working tree changes in main");
					}

					// Step 3: Clean untracked files that came from the merge
					// IMPORTANT: Exclude .workpilot directory to preserve specs and worktree data
					const cleanResult = spawnSync(
						getToolPath("git"),
						["clean", "-fd", "-e", ".workpilot"],
						{
							cwd: project.path,
							encoding: "utf-8",
							stdio: "pipe",
							env: getIsolatedGitEnv(),
						},
					);
					if (cleanResult.status === 0) {
						appLog.info(
							"[TASK_REVIEW] Cleaned untracked files in main (excluding .workpilot)",
						);
					}

					appLog.info("[TASK_REVIEW] Main branch restored to pre-merge state");
				}

				// Write feedback for QA fixer - write to WORKTREE spec dir if it exists
				// The QA process runs in the worktree where the build and implementation_plan.json are
				const targetSpecDir =
					hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
				const fixRequestPath = path.join(targetSpecDir, "QA_FIX_REQUEST.md");

				console.warn(
					"[TASK_REVIEW] Writing QA fix request to:",
					fixRequestPath,
				);
				console.warn(
					"[TASK_REVIEW] hasWorktree:",
					hasWorktree,
					"worktreePath:",
					worktreePath,
				);

				// Process images if provided
				let imageReferences = "";
				if (images && images.length > 0) {
					const imagesDir = path.join(targetSpecDir, "feedback_images");
					try {
						if (!existsSync(imagesDir)) {
							mkdirSync(imagesDir, { recursive: true });
						}
						const savedImages: string[] = [];
						for (const image of images) {
							try {
								if (!image.data) {
									console.warn(
										"[TASK_REVIEW] Skipping image with no data:",
										image.filename,
									);
									continue;
								}
								// Server-side MIME type validation (defense in depth - frontend also validates)
								// Reject missing mimeType to prevent bypass attacks
								const ALLOWED_MIME_TYPES = [
									"image/png",
									"image/jpeg",
									"image/jpg",
									"image/gif",
									"image/webp",
									"image/svg+xml",
								];
								if (
									!image.mimeType ||
									!ALLOWED_MIME_TYPES.includes(image.mimeType)
								) {
									console.warn(
										"[TASK_REVIEW] Skipping image with missing or disallowed MIME type:",
										image.mimeType,
									);
									continue;
								}
								// Sanitize filename to prevent path traversal attacks
								const sanitizedFilename = path.basename(image.filename);
								if (
									!sanitizedFilename ||
									sanitizedFilename === "." ||
									sanitizedFilename === ".."
								) {
									console.warn(
										"[TASK_REVIEW] Skipping image with invalid filename:",
										image.filename,
									);
									continue;
								}
								// Remove data URL prefix if present (e.g., "data:image/png;base64," or "data:image/svg+xml;base64,")
								const base64Data = image.data.replace(
									/^data:image\/[^;]+;base64,/,
									"",
								);
								const imageBuffer = Buffer.from(base64Data, "base64");
								const imagePath = path.join(imagesDir, sanitizedFilename);
								// Verify the resolved path is within the images directory (defense in depth)
								const resolvedPath = path.resolve(imagePath);
								const resolvedImagesDir = path.resolve(imagesDir);
								if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
									console.warn(
										"[TASK_REVIEW] Skipping image with path outside target directory:",
										image.filename,
									);
									continue;
								}
								writeFileSync(imagePath, imageBuffer);
								savedImages.push(`feedback_images/${sanitizedFilename}`);
								appLog.info("[TASK_REVIEW] Saved image:", sanitizedFilename);
							} catch (imgError) {
								appLog.error(
									"[TASK_REVIEW] Failed to save image:",
									image.filename,
									imgError,
								);
							}
						}
						if (savedImages.length > 0) {
							imageReferences =
								"\n\n## Reference Images\n\n" +
								savedImages
									.map((imgPath) => `![Feedback Image](${imgPath})`)
									.join("\n\n");
						}
					} catch (dirError) {
						appLog.error(
							"[TASK_REVIEW] Failed to create images directory:",
							dirError,
						);
					}
				}

				try {
					writeFileSync(
						fixRequestPath,
						`# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || "No feedback provided"}${imageReferences}\n\nCreated at: ${new Date().toISOString()}\n`,
						"utf-8",
					);
				} catch (error) {
					appLog.error("[TASK_REVIEW] Failed to write QA fix request:", error);
					return {
						success: false,
						error: "Failed to write QA fix request file",
					};
				}

				// A rejected plan's feedback is a rule candidate (IA1); the person
				// adopts it or not in the Learning Loop. Never waits, never fails the review.
				if (task.reviewReason === "plan_review") {
					void recordPlanFeedback(project.path, task.specId, feedback);
				}

				// Record the requested change as a single, traceable subtask so the
				// Subtasks tab keeps a visible history of every modification the user
				// asked for. It is rendered with a distinct colour in the UI
				// (origin: "change_request"). This is created unconditionally — even
				// when there is no worktree or no files have changed yet — so a request
				// always leaves a trace.
				try {
					const changeRequestSubtask = buildChangeRequestSubtask(
						feedback || "Needs fixes based on user feedback",
					);

					// Write the trace to BOTH plans:
					//  - the worktree plan, which the agent actually reads/updates;
					//  - the MAIN project plan, which the Subtasks tab watches. The
					//    worktree plan is only synced back to the main one after QA, so
					//    without this second write the new subtask would not appear in
					//    the UI until much later (the reported "no new coloured subtask").
					// The subtask carries no files at creation — its real changes are
					// captured in files_changed by the backend once the agent runs.
					const worktreePlanPath = path.join(
						hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir,
						AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
					);
					const mainPlanPath = path.join(
						specDir,
						AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
					);

					const wrote = addChangeRequestSubtaskToPlan(
						worktreePlanPath,
						changeRequestSubtask,
					);
					if (path.resolve(mainPlanPath) !== path.resolve(worktreePlanPath)) {
						addChangeRequestSubtaskToPlan(mainPlanPath, changeRequestSubtask);
					}

					appLog.info(
						`[TASK_REVIEW] Recorded change-request subtask (${changeRequestSubtask.id}, written=${wrote})`,
					);
				} catch (subtaskError) {
					// Don't fail the review - continue with QA process
					appLog.warn(
						`[TASK_REVIEW] Failed to record change-request subtask: ${subtaskError instanceof Error ? subtaskError.message : String(subtaskError)}`,
					);
				}

				// Re-open the plan for another pass WITHOUT re-running work that
				// already passed. A "Request Changes" is a follow-up: the agent should
				// pick up the new change-request subtask (pending) and retry any
				// genuinely failed ones, but COMPLETED subtasks stay completed —
				// otherwise every modification re-executes the whole task and floods
				// the logs with the other subtasks (matches the follow-up planner's
				// "never change the status of completed subtasks" rule).
				//
				// Reset BOTH plans: the MAIN plan is authoritative on restart (run.py
				// is launched with the main project dir and copy_spec_to_worktree
				// overwrites the worktree copy from it) AND it is the plan the UI
				// watches — so it must carry the change-request + in-progress status.
				const resetPlanPaths = [
					path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
					...(hasWorktree && worktreeSpecDir
						? [path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)]
						: []),
				];
				for (const resetPlanPath of resetPlanPaths) {
					try {
						updateExistingFile(resetPlanPath, (text) => {
						const resetPlan = JSON.parse(text);
						if (resetPlan.phases) {
							for (const phase of resetPlan.phases) {
								if (Array.isArray(phase.subtasks)) {
									for (const subtask of phase.subtasks) {
										// Retry failed subtasks; preserve completed ones.
										if (subtask.status === "failed") {
											subtask.status = "pending";
										}
									}
								}
							}
						}
						// Reset QA signoff so QA re-validates the task after the change.
						if (resetPlan.qa_signoff) {
							resetPlan.qa_signoff.status = "pending";
						}
						resetPlan.status = "in_progress";
						resetPlan.planStatus = "in_progress";
						resetPlan.updated_at = new Date().toISOString();
						return JSON.stringify(resetPlan, null, 2);
						});
					} catch (resetError) {
						appLog.warn(
							`[TASK_REVIEW] Could not reset plan ${resetPlanPath}: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
						);
					}
				}
				appLog.info(
					"[TASK_REVIEW] Re-opened plan(s) for change request (completed subtasks preserved)",
				);

				// Start full pipeline (planning → coding → QA) instead of QA-only
				// This ensures changes requested by the user go through the complete workflow.
				//
				// IMPORTANT: pass the MAIN project path (never the worktree path) as the
				// project dir. The WorktreeManager then reuses the EXISTING worktree
				// idempotently instead of trying to `git worktree add` a branch that is
				// already checked out (which fails with "branch already used by worktree",
				// git exit 128). Keeping worktree isolation (not --direct) also preserves
				// the worktree→main progress sync (run.py sets source_spec_dir), so the
				// kanban/modal percentage actually reaches 100% once the change-request
				// completes — running --direct skips that sync and leaves the main plan
				// (which the UI watches) stuck on the "pending" change-request subtask.
				const qaProjectPath = project.path;
				const baseBranch =
					task.metadata?.baseBranch || project.settings?.mainBranch;
				console.warn(
					"[TASK_REVIEW] Starting full pipeline with projectPath:",
					qaProjectPath,
				);
				agentManager.startTaskExecution(
					taskId,
					qaProjectPath,
					task.specId,
					{
						baseBranch,
						useWorktree: task.metadata?.useWorktree,
						useLocalBranch: task.metadata?.useLocalBranch,
						enableStreaming: true,
						streamingSessionId: taskId,
					},
					project.id,
				);

				taskStateManager.handleUiEvent(
					taskId,
					{ type: "USER_RESUMED" },
					task,
					project,
				);
			}

			return { success: true };
		},
	);
}
