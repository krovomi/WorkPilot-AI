/**
 * A server project's sprints, kept by the server for every member
 * (`apps/backend/shared_board/sprints.py`, `/api/board/sprints`), which
 * checks them again. The app sends ids it checked and never a path.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import type { IPCResult, SprintDraft } from "../../shared/types";
import type { Sprint, SprintCommitment, SprintReport } from "../../shared/types/sprint";
import { readSprints } from "../../shared/utils/sprints";
import { authedFetch } from "../server-connection";

function url(projectId: string, sprintId?: string, action?: string): string {
	const id = sprintId ? `/${encodeURIComponent(sprintId)}` : "";
	const verb = action ? `/${action}` : "";
	return `/api/board/sprints${id}${verb}?project_id=${encodeURIComponent(projectId)}`;
}

async function sprintsOf(
	request: Promise<{ ok: true; data: unknown } | { ok: false; error: string }>,
): Promise<IPCResult<Sprint[]>> {
	const result = await request;
	if (!result.ok) return { success: false, error: result.error };
	return { success: true, data: readSprints(result.data) };
}

export function listServerSprints(projectId: string): Promise<IPCResult<Sprint[]>> {
	return sprintsOf(authedFetch<unknown>(url(projectId), "GET"));
}

export function saveServerSprint(projectId: string, draft: SprintDraft): Promise<IPCResult<Sprint[]>> {
	return sprintsOf(authedFetch<unknown>(url(projectId), "POST", draft));
}

export function startServerSprint(
	projectId: string,
	sprintId: string,
	committed: SprintCommitment,
): Promise<IPCResult<Sprint[]>> {
	return sprintsOf(authedFetch<unknown>(url(projectId, sprintId, "start"), "POST", { committed }));
}

export function completeServerSprint(
	projectId: string,
	sprintId: string,
	report: SprintReport,
): Promise<IPCResult<Sprint[]>> {
	return sprintsOf(authedFetch<unknown>(url(projectId, sprintId, "complete"), "POST", { report }));
}

export function deleteServerSprint(projectId: string, sprintId: string): Promise<IPCResult<Sprint[]>> {
	return sprintsOf(authedFetch<unknown>(url(projectId, sprintId), "DELETE"));
}
