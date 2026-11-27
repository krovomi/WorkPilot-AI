/**
 * Sprints of a project's Kanban (main/ipc-handlers/sprint-handlers.ts): the
 * renderer names the project and the sprint by id; every call answers with
 * the project's sprints as they now are.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult, Sprint, SprintCommitment, SprintDraft, SprintReport } from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface SprintsAPI {
	listSprints: (projectId: string) => Promise<IPCResult<Sprint[]>>;
	saveSprint: (projectId: string, draft: SprintDraft) => Promise<IPCResult<Sprint[]>>;
	startSprint: (projectId: string, sprintId: string, committed: SprintCommitment) => Promise<IPCResult<Sprint[]>>;
	completeSprint: (projectId: string, sprintId: string, report: SprintReport) => Promise<IPCResult<Sprint[]>>;
	deleteSprint: (projectId: string, sprintId: string) => Promise<IPCResult<Sprint[]>>;
}

export const createSprintsAPI = (): SprintsAPI => ({
	listSprints: (projectId) => invokeIpc(IPC_CHANNELS.SPRINTS_LIST, projectId),
	saveSprint: (projectId, draft) => invokeIpc(IPC_CHANNELS.SPRINTS_SAVE, projectId, draft),
	startSprint: (projectId, sprintId, committed) =>
		invokeIpc(IPC_CHANNELS.SPRINTS_START, projectId, sprintId, committed),
	completeSprint: (projectId, sprintId, report) =>
		invokeIpc(IPC_CHANNELS.SPRINTS_COMPLETE, projectId, sprintId, report),
	deleteSprint: (projectId, sprintId) => invokeIpc(IPC_CHANNELS.SPRINTS_DELETE, projectId, sprintId),
});
