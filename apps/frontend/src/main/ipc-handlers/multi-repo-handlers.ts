/**
 * Multi-repo orchestration: one change across several repositories, each run
 * as a Kanban task of its own project (`main/multi-repo/`).
 *
 * The renderer is not trusted (security.md, S6): it names a project by id, an
 * orchestration by its id (checked against its pattern), and repositories by
 * paths that must resolve to a registered project or to a folder the user
 * picked in a dialog this session. Errors come back as `multiRepo:` i18n keys.
 */
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	IPCResult,
	MultiRepoCreateConfig,
	MultiRepoOrchestration,
	Project,
} from "../../shared/types";
import { parseTaskEngine, readEngine, writeEngine } from "../multi-repo/engine";
import { createMultiRepoHost, ensureRepoProject } from "../multi-repo/host";
import {
	createOrchestration,
	listOrchestrationIds,
	type NewRepo,
	orchestrationDir,
	readManifest,
	toOrchestration,
} from "../multi-repo/manifest";
import {
	isMultiRepoRunning,
	startMultiRepoRun,
	stopMultiRepoRun,
} from "../multi-repo/service";
import { projectStore } from "../project-store";
import { resolveKnownProject, resolveUserChosen } from "../security/renderer-path";

export const MAX_REPOS = 8;
const MAX_TASK_CHARS = 20_000;

function localProject(projectId: unknown): Project | null {
	if (typeof projectId !== "string") return null;
	const project = projectStore.getProject(projectId);
	return project && !project.remote ? project : null;
}

function load(project: Project, id: string): MultiRepoOrchestration | null {
	const dir = orchestrationDir(project, id);
	const manifest = dir ? readManifest(dir) : null;
	if (!dir || !manifest) return null;
	const engine = readEngine(dir);
	return {
		...toOrchestration(id, project.id, manifest, isMultiRepoRunning(dir)),
		...(engine ? { engine } : {}),
	};
}

/** A repo's name in the orchestration: its project's, unique, parseable. */
function repoName(project: Project, taken: Set<string>): string {
	const base =
		project.name.replace(/[,:]+/g, "-").trim() || path.basename(project.path) || "repo";
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	taken.add(name);
	return name;
}

/** The repos of a create request, resolved, registered and initialized. */
export function resolveRepos(
	config: unknown,
): { repos: NewRepo[] } | { error: string } {
	const raw = (config as MultiRepoCreateConfig | undefined)?.repos;
	if (!Array.isArray(raw) || raw.length < 2) return { error: "errors.noRepos" };
	if (raw.length > MAX_REPOS) return { error: "errors.tooManyRepos" };

	const repos: NewRepo[] = [];
	const seen = new Set<string>();
	const names = new Set<string>();
	for (const entry of raw) {
		const localPath = (entry as { localPath?: unknown } | null)?.localPath;
		// A registered project, or a folder the user picked in a dialog.
		const resolved =
			resolveKnownProject(localPath) ?? resolveUserChosen(localPath, "directory");
		if (!resolved) return { error: "errors.repoNotAllowed" };
		if (seen.has(resolved)) return { error: "errors.duplicateRepo" };
		seen.add(resolved);
		const project = ensureRepoProject(resolved);
		if (!project) return { error: "errors.repoNotUsable" };
		repos.push({ name: repoName(project, names), path: project.path, projectId: project.id });
	}
	return { repos };
}

/**
 * Register all multi-repo orchestration IPC handlers
 */
export function registerMultiRepoHandlers(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_CREATE,
		async (_, projectId: unknown, config: unknown): Promise<IPCResult<MultiRepoOrchestration>> => {
			const project = localProject(projectId);
			if (!project) return { success: false, error: "errors.projectNotFound" };
			const description = (config as MultiRepoCreateConfig | undefined)?.taskDescription;
			if (typeof description !== "string" || !description.trim()) {
				return { success: false, error: "errors.noDescription" };
			}
			if (description.length > MAX_TASK_CHARS) {
				return { success: false, error: "errors.descriptionTooLong" };
			}
			const engine = parseTaskEngine((config as MultiRepoCreateConfig | undefined)?.engine);
			if (engine === "invalid") return { success: false, error: "errors.invalidEngine" };
			const resolved = resolveRepos(config);
			if ("error" in resolved) return { success: false, error: resolved.error };
			try {
				const id = createOrchestration(project, resolved.repos, description.trim());
				const dir = orchestrationDir(project, id);
				if (engine && dir) writeEngine(dir, engine);
				const created = load(project, id);
				return created
					? { success: true, data: created }
					: { success: false, error: "errors.createFailed" };
			} catch (error) {
				console.error("[MultiRepo] Create failed:", error);
				return { success: false, error: "errors.createFailed" };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_GET,
		async (_, projectId: unknown, id: unknown): Promise<IPCResult<MultiRepoOrchestration | null>> => {
			const project = localProject(projectId);
			if (!project) return { success: false, error: "errors.projectNotFound" };
			return { success: true, data: typeof id === "string" ? load(project, id) : null };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_LIST,
		async (_, projectId: unknown): Promise<IPCResult<MultiRepoOrchestration[]>> => {
			const project = localProject(projectId);
			if (!project) return { success: false, error: "errors.projectNotFound" };
			const all = listOrchestrationIds(project)
				.map((id) => load(project, id))
				.filter((o): o is MultiRepoOrchestration => o !== null)
				.reverse();
			return { success: true, data: all };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_START,
		async (_, projectId: unknown, id: unknown): Promise<IPCResult> => {
			const project = localProject(projectId);
			const dir = project ? orchestrationDir(project, id) : null;
			if (!project || !dir || !readManifest(dir)) {
				return { success: false, error: "errors.notFound" };
			}
			const started = startMultiRepoRun(
				dir,
				createMultiRepoHost(id as string, project.id, getMainWindow),
			);
			return started ? { success: true } : { success: false, error: "errors.alreadyRunning" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MULTI_REPO_STOP,
		async (_, projectId: unknown, id: unknown): Promise<IPCResult> => {
			const project = localProject(projectId);
			const dir = project ? orchestrationDir(project, id) : null;
			if (!dir) return { success: false, error: "errors.notFound" };
			stopMultiRepoRun(dir);
			return { success: true };
		},
	);
}
