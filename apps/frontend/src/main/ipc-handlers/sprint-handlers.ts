/**
 * IPC of the Kanban's sprints (docs/architecture/kanban-sprints.md). The
 * renderer names a project by id and a sprint by id; its drafts, commitments
 * and reports are checked here (S6) before they reach a local project's file
 * (main/sprints/local-sprints.ts) or a server project, which checks them
 * again (main/sprints/server-sprints.ts). Every answer is the project's
 * sprints as they now are.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import type { Sprint } from "../../shared/types/sprint";
import { cleanSprintDraft, isSprintId } from "../../shared/utils/sprints";
import { projectStore } from "../project-store";
import { getServerProject } from "../server-projects";
import { readLocalSprints, updateLocalSprints } from "../sprints/local-sprints";
import {
	cleanCommitment,
	cleanReport,
	completeSprint,
	deleteSprint,
	type SprintError,
	saveSprint,
	startSprint,
} from "../sprints/sprint-book";
import {
	completeServerSprint,
	deleteServerSprint,
	listServerSprints,
	saveServerSprint,
	startServerSprint,
} from "../sprints/server-sprints";

const MAX_PROJECT_ID = 200;

type Target = { server: string } | { local: NonNullable<ReturnType<typeof projectStore.getProject>> };

function targetOf(projectId: unknown): Target | string {
	if (typeof projectId !== "string" || !projectId || projectId.length > MAX_PROJECT_ID) return "Invalid project id";
	if (getServerProject(projectId)) return { server: projectId };
	const project = projectStore.getProject(projectId);
	return project ? { local: project } : "Unknown project";
}

async function local(
	target: Target,
	change: (sprints: Sprint[]) => { sprints: Sprint[] } | { error: SprintError },
): Promise<IPCResult<Sprint[]>> {
	if (!("local" in target)) return { success: false, error: "server_project" };
	let result: { sprints: Sprint[] } | { error: SprintError };
	try {
		result = await updateLocalSprints(target.local, (sprints) => {
			const outcome = change(sprints);
			return "error" in outcome ? { error: outcome.error } : { sprints: outcome.sprints };
		});
	} catch {
		// Unwritable file, or a folder that leaves the project.
		return { success: false, error: "write_failed" };
	}
	return "error" in result && result.error
		? { success: false, error: result.error }
		: { success: true, data: (result as { sprints: Sprint[] }).sprints };
}

export async function handleListSprints(projectId: unknown): Promise<IPCResult<Sprint[]>> {
	const target = targetOf(projectId);
	if (typeof target === "string") return { success: false, error: target };
	if ("server" in target) return listServerSprints(target.server);
	return { success: true, data: await readLocalSprints(target.local) };
}

export async function handleSaveSprint(projectId: unknown, draft: unknown): Promise<IPCResult<Sprint[]>> {
	const target = targetOf(projectId);
	if (typeof target === "string") return { success: false, error: target };
	const clean = cleanSprintDraft(draft);
	if (!clean) return { success: false, error: "invalid" };
	if ("server" in target) return saveServerSprint(target.server, clean);
	return local(target, (sprints) => saveSprint(sprints, clean, new Date().toISOString()));
}

export async function handleStartSprint(
	projectId: unknown,
	sprintId: unknown,
	committed: unknown,
): Promise<IPCResult<Sprint[]>> {
	const target = targetOf(projectId);
	if (typeof target === "string") return { success: false, error: target };
	const commitment = cleanCommitment(committed);
	if (!isSprintId(sprintId) || !commitment) return { success: false, error: "invalid" };
	if ("server" in target) return startServerSprint(target.server, sprintId, commitment);
	return local(target, (sprints) => startSprint(sprints, sprintId, commitment, new Date().toISOString()));
}

export async function handleCompleteSprint(
	projectId: unknown,
	sprintId: unknown,
	report: unknown,
): Promise<IPCResult<Sprint[]>> {
	const target = targetOf(projectId);
	if (typeof target === "string") return { success: false, error: target };
	const done = cleanReport(report);
	if (!isSprintId(sprintId) || !done) return { success: false, error: "invalid" };
	if ("server" in target) return completeServerSprint(target.server, sprintId, done);
	return local(target, (sprints) => completeSprint(sprints, sprintId, done, new Date().toISOString()));
}

export async function handleDeleteSprint(projectId: unknown, sprintId: unknown): Promise<IPCResult<Sprint[]>> {
	const target = targetOf(projectId);
	if (typeof target === "string") return { success: false, error: target };
	if (!isSprintId(sprintId)) return { success: false, error: "invalid" };
	if ("server" in target) return deleteServerSprint(target.server, sprintId);
	return local(target, (sprints) => deleteSprint(sprints, sprintId));
}

export function registerSprintHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.SPRINTS_LIST, (_, projectId: unknown) => handleListSprints(projectId));
	ipcMain.handle(IPC_CHANNELS.SPRINTS_SAVE, (_, projectId: unknown, draft: unknown) =>
		handleSaveSprint(projectId, draft),
	);
	ipcMain.handle(IPC_CHANNELS.SPRINTS_START, (_, projectId: unknown, sprintId: unknown, committed: unknown) =>
		handleStartSprint(projectId, sprintId, committed),
	);
	ipcMain.handle(IPC_CHANNELS.SPRINTS_COMPLETE, (_, projectId: unknown, sprintId: unknown, report: unknown) =>
		handleCompleteSprint(projectId, sprintId, report),
	);
	ipcMain.handle(IPC_CHANNELS.SPRINTS_DELETE, (_, projectId: unknown, sprintId: unknown) =>
		handleDeleteSprint(projectId, sprintId),
	);
}
