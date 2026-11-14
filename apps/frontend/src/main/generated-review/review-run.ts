/**
 * One page run that writes code, from opening the card to its commit.
 *
 * The page asks for a run with the project folder the renderer named; the
 * folder must be a project of this computer (the renderer is not trusted to
 * name any folder, S6), and a server project has none. The run gives back
 * the worktree to write into and `map`, which moves the renderer's paths
 * (the file under test, the chosen test folder) to the same place in the
 * worktree. `finish` commits and puts the card in review; `abandon` takes
 * away a card the run opened and never wrote to.
 */
import path from "node:path";
import type { Project } from "../../shared/types";
import type { GeneratedReview, GeneratedReviewSource } from "../../shared/types/generated-review";
import { projectStore } from "../project-store";
import {
	abandonReviewWorkspace,
	openReviewWorkspace,
	recordReviewStep,
	type ReviewDeps,
	type ReviewStepRecord,
	type ReviewWorkspace,
	toWorkspacePath,
} from "./review-card";

export interface ReviewRun {
	readonly workspace: ReviewWorkspace;
	/** The worktree: what the writer is told is the project root. */
	readonly root: string;
	/** A path of the project folder at the same place in the worktree. */
	map(target: string | undefined): string | undefined;
	/** Commit the run and put its card in review. */
	finish(step: ReviewStepRecord): Promise<GeneratedReview>;
	/** The run wrote nothing: a card it opened goes away again. */
	abandon(): Promise<void>;
}

/** Raised when there is no card to write into; the message is for the person. */
export class ReviewUnavailableError extends Error {
	constructor(
		message: string,
		readonly details?: string,
	) {
		super(message);
		this.name = "ReviewUnavailableError";
	}
}

/** The local project at `projectPath`, or undefined. */
export function findLocalProject(projectPath: string | undefined): Project | undefined {
	if (!projectPath) return undefined;
	const wanted = path.resolve(projectPath);
	return projectStore
		.getProjects()
		.find((project) => !project.remote && project.path && path.resolve(project.path) === wanted);
}

export async function openReviewRun(
	projectPath: string | undefined,
	source: GeneratedReviewSource,
	subject: string,
	deps?: ReviewDeps,
	description?: string,
): Promise<ReviewRun> {
	const project = findLocalProject(projectPath);
	if (!project) {
		throw new ReviewUnavailableError(
			"Generated code is only written into a project of this computer, on a review branch.",
			`Not a local project: ${projectPath ?? "(none)"}`,
		);
	}
	let workspace: ReviewWorkspace;
	try {
		workspace = await openReviewWorkspace(project, { source, subject, description }, deps);
	} catch (error) {
		throw new ReviewUnavailableError(
			"The review branch for this code could not be prepared, so nothing was written to the project.",
			error instanceof Error ? error.message : String(error),
		);
	}
	return {
		workspace,
		root: workspace.worktreePath,
		map: (target) => toWorkspacePath(project.path, workspace.worktreePath, target),
		finish: (step) => recordReviewStep(workspace, step, deps),
		abandon: () => abandonReviewWorkspace(workspace, deps),
	};
}
