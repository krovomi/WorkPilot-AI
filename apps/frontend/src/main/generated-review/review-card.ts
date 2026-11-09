/**
 * The Kanban card a page's generated code waits on for review.
 *
 * A page that writes code opens a workspace here before it writes: the card
 * (a spec folder like any task's, `sourceType: "generated"`), then its
 * worktree on `workpilot/<spec>`. The page writes into the worktree, never
 * into the project folder, and records each run as a commit and a completed
 * subtask; the card then sits in human review, where the person reads the
 * diff and opens the pull request from the card, as for any task.
 *
 * Runs of the same page join the card that is still waiting for its review
 * (tests then the packages they need, two designs of one screen): one card,
 * one branch, one pull request. Once that pull request is opened the card
 * leaves human review and the next run opens a new card. A run that ends
 * without writing anything on a card it just opened takes the card away
 * again, so a failed generation leaves nothing on the board.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../shared/constants";
import type { Project } from "../../shared/types";
import type { GeneratedReview, GeneratedReviewSource } from "../../shared/types/generated-review";
import { getAppLanguage } from "../app-language";
import { createLocalTask } from "../ipc-handlers/task/create-local-task";
import { projectStore } from "../project-store";
import { cleanupWorktree } from "../utils/worktree-cleanup";
import { findTaskWorktree, isPathWithinBase } from "../worktree-paths";
import {
	commitReviewWorktree,
	createReviewWorktree,
	type RunReviewWorktree,
	runReviewWorktree,
} from "./review-worktree";

export interface ReviewWorkspace {
	readonly project: Project;
	readonly source: GeneratedReviewSource;
	readonly specId: string;
	readonly title: string;
	/** Where the page writes: the card's worktree, a checkout of its branch. */
	readonly worktreePath: string;
	readonly branch: string;
	readonly baseBranch: string;
	/** The card was already waiting for review when this run started. */
	readonly reused: boolean;
	/** The branch head when this run began (the runner's `create`). */
	readonly startHead?: string;
}

export interface OpenReviewRequest {
	readonly source: GeneratedReviewSource;
	/** What this run produces, one line (the card's title when it is new). */
	readonly subject: string;
	/** What the card's description says it holds (plain text). */
	readonly description?: string;
}

export interface ReviewDeps {
	readonly run: RunReviewWorktree;
	readonly cleanup: typeof cleanupWorktree;
	readonly language: () => string;
}

const defaultDeps: ReviewDeps = {
	run: runReviewWorktree,
	cleanup: cleanupWorktree,
	language: getAppLanguage,
};

const TITLE_PREFIX: Record<GeneratedReviewSource, { en: string; fr: string }> = {
	"test-studio": { en: "Generated tests", fr: "Tests générés" },
	"design-import": { en: "Imported design", fr: "Design importé" },
	changelog: { en: "Changelog update", fr: "Mise à jour du changelog" },
	"pair-programming": { en: "Pair programming", fr: "Pair programming" },
	"quick-command": { en: "Quick command", fr: "Commande rapide" },
};

const DESCRIPTION: { en: string; fr: string } = {
	en: "Code written by a WorkPilot page, on this card's branch instead of the project folder. Review the diff, then open the pull request.",
	fr: "Code écrit par une page de WorkPilot, sur la branche de cette carte plutôt que dans le dossier du projet. Relisez le diff puis ouvrez la pull request.",
};

const STEPS_PHASE = { en: "Generated code", fr: "Code généré" };

function lang(deps: ReviewDeps): "en" | "fr" {
	return deps.language().toLowerCase().startsWith("fr") ? "fr" : "en";
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function specsDir(project: Project): string {
	return path.join(project.path, getSpecsDir(project.autoBuildPath));
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The card of `source` still waiting for review in `project`, with its worktree. */
export function findOpenReviewCard(
	project: Project,
	source: GeneratedReviewSource,
): { specId: string; title: string; worktreePath: string; baseBranch: string } | null {
	const dir = specsDir(project);
	if (!existsSync(dir)) return null;
	let names: string[];
	try {
		names = readdirSync(dir).sort().reverse();
	} catch {
		return null;
	}
	for (const specId of names) {
		const metadata = readJson(path.join(dir, specId, "task_metadata.json"));
		if (metadata?.generatedBy !== source) continue;
		const plan = readJson(path.join(dir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
		if (plan?.status !== "human_review") continue;
		const worktreePath = findTaskWorktree(project.path, specId);
		if (!worktreePath) continue;
		return {
			specId,
			title: typeof plan.feature === "string" ? plan.feature : specId,
			worktreePath,
			baseBranch: typeof metadata.baseBranch === "string" ? metadata.baseBranch : "",
		};
	}
	return null;
}

/**
 * The card and worktree this run writes into: the one still waiting for
 * review, or a new one. Throws when the project is not a git repository or
 * the worktree cannot be made; nothing is left behind then.
 */
export async function openReviewWorkspace(
	project: Project,
	request: OpenReviewRequest,
	deps: ReviewDeps = defaultDeps,
): Promise<ReviewWorkspace> {
	const open = findOpenReviewCard(project, request.source);
	if (open) {
		// Where this run starts on the card's branch.
		const current = await createReviewWorktree(
			project.path,
			open.specId,
			open.baseBranch || undefined,
			deps.run,
		);
		return {
			project,
			source: request.source,
			specId: open.specId,
			title: open.title,
			worktreePath: open.worktreePath,
			branch: `workpilot/${path.basename(open.worktreePath)}`,
			baseBranch: open.baseBranch,
			reused: true,
			...(current.head ? { startHead: current.head } : {}),
		};
	}

	const language = lang(deps);
	const separator = language === "fr" ? " : " : ": ";
	const title = oneLine(
		`${TITLE_PREFIX[request.source][language]}${separator}${request.subject}`,
		100,
	);
	const description = [DESCRIPTION[language], request.description?.trim()]
		.filter(Boolean)
		.join("\n\n");
	const requestedBase = project.settings?.mainBranch || undefined;
	const task = createLocalTask(project, {
		title,
		aiDescription: description,
		displayDescription: description,
		descriptionIsHtml: false,
		metadata: {
			sourceType: "generated",
			generatedBy: request.source,
			...(requestedBase ? { baseBranch: requestedBase } : {}),
		},
	});
	const specDir = path.join(specsDir(project), task.specId);
	try {
		const created = await createReviewWorktree(project.path, task.specId, requestedBase, deps.run);
		if (created.baseBranch && created.baseBranch !== requestedBase) {
			// The pull request targets the branch the worktree was cut from.
			const metadataPath = path.join(specDir, "task_metadata.json");
			const metadata = readJson(metadataPath) ?? {};
			writeFileSync(
				metadataPath,
				JSON.stringify({ ...metadata, baseBranch: created.baseBranch }, null, 2),
				"utf-8",
			);
		}
		return {
			project,
			source: request.source,
			specId: task.specId,
			title,
			worktreePath: created.path,
			branch: created.branch,
			baseBranch: created.baseBranch,
			reused: false,
			...(created.head ? { startHead: created.head } : {}),
		};
	} catch (error) {
		rmSync(specDir, { recursive: true, force: true });
		projectStore.invalidateTasksCache(project.id);
		throw error;
	}
}

interface PlanSubtaskRecord {
	id: string;
	description: string;
	status: string;
	files_changed?: string[];
}

/**
 * Commit what the run wrote and put the card in human review with the run as
 * a completed subtask. Nothing written: no commit, and a card this run
 * opened is taken away again (see `abandonReviewWorkspace`).
 */
export async function recordReviewStep(
	workspace: ReviewWorkspace,
	step: { message: string; summary: string },
	deps: ReviewDeps = defaultDeps,
): Promise<GeneratedReview> {
	const { project, specId } = workspace;
	const commit = await commitReviewWorktree(
		project.path,
		specId,
		workspace.baseBranch || undefined,
		oneLine(step.message, 100),
		deps.run,
		workspace.startHead,
	);
	const review: GeneratedReview = {
		taskId: specId,
		specId,
		title: workspace.title,
		branch: workspace.branch,
		baseBranch: workspace.baseBranch,
		files: commit.files,
		committed: commit.committed,
		reused: workspace.reused,
	};
	if (!commit.committed) {
		await abandonReviewWorkspace(workspace, deps);
		return review;
	}

	const planPath = path.join(specsDir(project), specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
	const plan = readJson(planPath) ?? {};
	const phases = Array.isArray(plan.phases) ? (plan.phases as Record<string, unknown>[]) : [];
	const first = phases[0] ?? {
		phase: 1,
		name: STEPS_PHASE[lang(deps)],
		type: "implementation",
		subtasks: [],
	};
	const subtasks = Array.isArray(first.subtasks) ? (first.subtasks as PlanSubtaskRecord[]) : [];
	subtasks.push({
		id: `generated-${subtasks.length + 1}`,
		description: oneLine(step.summary, 200),
		status: "completed",
		files_changed: commit.files,
	});
	const now = new Date().toISOString();
	writeFileSync(
		planPath,
		JSON.stringify(
			{
				...plan,
				phases: [{ ...first, subtasks }, ...phases.slice(1)],
				status: "human_review",
				planStatus: "review",
				reviewReason: "completed",
				xstateState: "human_review",
				executionPhase: "complete",
				updated_at: now,
			},
			null,
			2,
		),
		"utf-8",
	);
	projectStore.invalidateTasksCache(project.id);
	return review;
}

/**
 * Take back a card this run opened and never wrote to: its worktree, its
 * branch and its spec folder. A card that was already waiting for review
 * (`reused`) keeps everything it had.
 */
export async function abandonReviewWorkspace(
	workspace: ReviewWorkspace,
	deps: ReviewDeps = defaultDeps,
): Promise<void> {
	if (workspace.reused) return;
	const { project, specId } = workspace;
	const planPath = path.join(specsDir(project), specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
	const plan = readJson(planPath);
	if (plan?.status === "human_review") return;
	if (existsSync(workspace.worktreePath)) {
		await deps.cleanup({
			worktreePath: workspace.worktreePath,
			projectPath: project.path,
			specId,
			logPrefix: "[GeneratedReview]",
			deleteBranch: true,
		});
	}
	rmSync(path.join(specsDir(project), specId), { recursive: true, force: true });
	projectStore.invalidateTasksCache(project.id);
}

/**
 * `target`, a path in the project folder, at the same place in the worktree.
 * A relative path is relative to the project root either way and is kept; a
 * path outside the project (or already in a worktree) has no counterpart and
 * gives undefined, so the caller drops it rather than write outside.
 */
export function toWorkspacePath(
	projectPath: string,
	worktreePath: string,
	target: string | undefined,
): string | undefined {
	if (!target) return undefined;
	if (!path.isAbsolute(target)) {
		const resolved = path.resolve(worktreePath, target);
		return isPathWithinBase(resolved, worktreePath) ? target : undefined;
	}
	const resolved = path.resolve(target);
	if (isPathWithinBase(resolved, worktreePath)) return resolved;
	if (!isPathWithinBase(resolved, projectPath)) return undefined;
	const relative = path.relative(path.resolve(projectPath), resolved);
	if (relative.split(path.sep)[0] === ".workpilot") return undefined;
	return path.join(worktreePath, relative);
}
