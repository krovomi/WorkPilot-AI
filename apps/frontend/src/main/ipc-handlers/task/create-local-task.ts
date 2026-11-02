/**
 * A new Kanban task of a project on this computer, written to disk.
 *
 * The part of `TASK_CREATE` after the title and the description are settled:
 * the spec directory, `implementation_plan.json`, `task_metadata.json`,
 * `requirements.json` and the attached images. Shared with the main-process
 * features that open cards themselves (multi-repo orchestration).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import type { Project, Task, TaskMetadata } from "../../../shared/types";
import { slugifySpecTitle } from "../../../shared/utils/spec-slug";
import { projectStore } from "../../project-store";

export interface NewLocalTask {
	/** Plain-text title, already generated when the user gave none. */
	readonly title: string;
	/** The description the agents read (plain text). */
	readonly aiDescription: string;
	/** The description the board shows (HTML kept for tracker imports). */
	readonly displayDescription: string;
	readonly descriptionIsHtml: boolean;
	readonly metadata?: TaskMetadata;
}

export function createLocalTask(project: Project, input: NewLocalTask): Task {
	const { title: finalTitle, aiDescription, displayDescription, descriptionIsHtml, metadata } =
		input;
	// Generate a unique spec ID based on existing specs
	const specsBaseDir = getSpecsDir(project.autoBuildPath);
	const specsDir = path.join(project.path, specsBaseDir);

	// Find next available spec number
	let specNumber = 1;
	if (existsSync(specsDir)) {
		const existingDirs = readdirSync(specsDir, { withFileTypes: true })
			.filter((d: Dirent | string) => {
				// Handle both Dirent objects and string fallbacks
				if (typeof d === "string") {
					// If it's a string, check if it's a directory by using statSync
					const fullPath = path.join(specsDir, d);
					try {
						return statSync(fullPath).isDirectory();
					} catch {
						return false;
					}
				}
				// If it's a Dirent object, use isDirectory method
				return typeof d.isDirectory === "function" && d.isDirectory();
			})
			.map((d: Dirent | string) => (typeof d === "string" ? d : d.name));

		// Extract numbers from spec directory names (e.g., "001-feature" -> 1)
		const existingNumbers = existingDirs
			.map((name: string) => {
				const match = name.match(/^(\d+)/);
				return match ? parseInt(match[1], 10) : 0;
			})
			.filter((n: number) => n > 0);

		if (existingNumbers.length > 0) {
			specNumber = Math.max(...existingNumbers) + 1;
		}
	}

	// Create spec ID with zero-padded number and slugified title
	const slugifiedTitle = slugifySpecTitle(finalTitle);
	const specId = `${String(specNumber).padStart(3, "0")}-${slugifiedTitle}`;

	// Create spec directory
	const specDir = path.join(specsDir, specId);
	mkdirSync(specDir, { recursive: true });

	// Build metadata with source type
	const taskMetadata: TaskMetadata = {
		sourceType: "manual",
		...metadata,
	};

	// Process and save attached images
	if (
		taskMetadata.attachedImages &&
		taskMetadata.attachedImages.length > 0
	) {
		const attachmentsDir = path.join(specDir, "attachments");
		mkdirSync(attachmentsDir, { recursive: true });
		const resolvedAttachmentsDir = path.resolve(attachmentsDir);

		// MIME type allowlist (defense in depth - frontend also validates)
		const ALLOWED_MIME_TYPES = [
			"image/png",
			"image/jpeg",
			"image/jpg",
			"image/gif",
			"image/webp",
			"image/svg+xml",
		];

		const savedImages: typeof taskMetadata.attachedImages = [];

		for (const image of taskMetadata.attachedImages) {
			if (image.data) {
				// Validate MIME type
				if (
					!image.mimeType ||
					!ALLOWED_MIME_TYPES.includes(image.mimeType)
				) {
					console.warn(
						`[TASK_CREATE] Skipping image with missing or disallowed MIME type: ${image.mimeType}`,
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
						`[TASK_CREATE] Skipping image with invalid filename: ${image.filename}`,
					);
					continue;
				}

				// Validate resolved path stays within attachments directory
				const imagePath = path.join(attachmentsDir, sanitizedFilename);
				const resolvedPath = path.resolve(imagePath);
				if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)) {
					console.warn(
						`[TASK_CREATE] Skipping image with path traversal attempt: ${image.filename}`,
					);
					continue;
				}

				try {
					// Decode base64 and save to file
					const buffer = Buffer.from(image.data, "base64");
					writeFileSync(imagePath, buffer);

					// Store relative path instead of base64 data
					savedImages.push({
						id: image.id,
						filename: sanitizedFilename,
						mimeType: image.mimeType,
						size: image.size,
						path: `attachments/${sanitizedFilename}`,
						// Don't include data or thumbnail to save space
					});
				} catch (err) {
					console.error(`Failed to save image ${sanitizedFilename}:`, err);
				}
			}
		}

		// Update metadata with saved image paths (without base64 data)
		taskMetadata.attachedImages = savedImages;
	}

	// Create initial implementation_plan.json (task is created but not started)
	const now = new Date().toISOString();
	const implementationPlan = {
		feature: finalTitle,
		description: aiDescription,
		created_at: now,
		updated_at: now,
		status: "pending",
		phases: [],
	};

	const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
	writeFileSync(
		planPath,
		JSON.stringify(implementationPlan, null, 2),
		"utf-8",
	);

	// Save task metadata if provided
	if (taskMetadata) {
		const metadataPath = path.join(specDir, "task_metadata.json");
		writeFileSync(
			metadataPath,
			JSON.stringify(taskMetadata, null, 2),
			"utf-8",
		);
	}

	// Create requirements.json with attached images
	const requirements: Record<string, unknown> = {
		task_description: aiDescription,
		workflow_type: taskMetadata.category || "feature",
	};

	// Conserver le HTML enrichi (images inlinées comprises) pour l'UI sans
	// polluer `task_description` consommé par l'IA. project-store privilégie
	// ce champ pour l'affichage de la description.
	if (descriptionIsHtml && displayDescription !== aiDescription) {
		requirements.display_description = displayDescription;
	}

	// Propagate acceptance criteria so they reach every pipeline phase
	// (planner, spec_writer, qa_reviewer all read this from requirements.json).
	if (
		taskMetadata.acceptanceCriteria &&
		taskMetadata.acceptanceCriteria.length > 0
	) {
		requirements.acceptance_criteria = taskMetadata.acceptanceCriteria;
	}

	// Propagate free-form extra note as `additional_context` so it gets
	// surfaced to the orchestrator (see _load_requirements_context).
	if (taskMetadata.extraNote?.trim()) {
		requirements.additional_context = taskMetadata.extraNote.trim();
	}

	// Add attached images to requirements if present
	if (
		taskMetadata.attachedImages &&
		taskMetadata.attachedImages.length > 0
	) {
		requirements.attached_images = taskMetadata.attachedImages.map(
			(img) => ({
				filename: img.filename,
				path: img.path,
				description: "", // User can add descriptions later
			}),
		);
	}

	const requirementsPath = path.join(
		specDir,
		AUTO_BUILD_PATHS.REQUIREMENTS,
	);
	writeFileSync(
		requirementsPath,
		JSON.stringify(requirements, null, 2),
		"utf-8",
	);

	// Create the task object
	const task: Task = {
		id: specId,
		specId: specId,
		projectId: project.id,
		title: finalTitle,
		description: displayDescription,
		status: "backlog",
		subtasks: [],
		logs: [],
		metadata: taskMetadata,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	// Invalidate cache since a new task was created
	projectStore.invalidateTasksCache(project.id);

	return task;
}
