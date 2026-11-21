/**
 * The memory's lifecycle in the Memories tab: journal, trash, pins, conflicts.
 *
 * Every handler takes a project id — the project is the main process's own,
 * its path never comes from the renderer — and revalidates the rest
 * (`memory-lifecycle-validation.ts`) before calling `/api/brain/memory/*`,
 * where the backend checks every id again. A server project's memory is its
 * own brain's, on the server, which does not serve this surface yet: those
 * calls answer `server-project`.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	MemoryConflictOpinion,
	MemoryJournalEntry,
	MemoryLifecycleMetrics,
	MemoryLifecycleView,
	MemoryRestoreOutcome,
	MemoryRevertOutcome,
} from "../../../shared/types";
import { backendFetch } from "../_backend-fetch";
import { featureProject } from "../server-feature-files";
import {
	boundedText,
	conflictChoice,
	conflictId,
	entryId,
	MAX_CANONICAL_LENGTH,
	MAX_REASON_LENGTH,
	maintainerNames,
	memoryId,
	scopeText,
	trashId,
} from "./memory-lifecycle-validation";

const INVALID = { success: false, error: "invalid" } as const;

interface LifecycleResponse {
	journal?: MemoryJournalEntry[];
	revertible?: MemoryLifecycleView["revertible"];
	last_undo?: string | null;
	metrics?: MemoryLifecycleMetrics;
	maintainers?: string[];
	can_arbitrate?: boolean;
	trash?: MemoryLifecycleView["trash"];
	conflicts?: MemoryLifecycleView["conflicts"];
	pinned?: number;
	pin_limit?: number;
	retention_days?: number;
}

/** The local project's path, or why there is none. */
function localProject(projectId: unknown): { path: string } | { error: string } {
	const project = featureProject(projectId);
	if (!project) return { error: "project-not-found" };
	if (project.remote) return { error: "server-project" };
	return { path: project.path };
}

function post(body: Record<string, unknown>): RequestInit {
	// No headers: backendFetch sets the JSON content type itself.
	return { method: "POST", body: JSON.stringify(body) };
}

function failure(result: { success: false; error: string; code?: unknown }): IPCResult<never> {
	const code = typeof result.code === "string" ? result.code : result.error;
	return { success: false, error: code };
}

export async function loadMemoryLifecycle(
	projectPath: string,
): Promise<IPCResult<MemoryLifecycleView>> {
	const query = new URLSearchParams({ project_dir: projectPath, limit: "200" });
	const result = await backendFetch<LifecycleResponse>(
		`/api/brain/memory/lifecycle?${query.toString()}`,
		{ method: "GET" },
		15_000,
	);
	if (!result.success) return failure(result);
	return {
		success: true,
		data: {
			journal: result.journal ?? [],
			revertible: result.revertible ?? {},
			lastUndo: result.last_undo ?? null,
			metrics: result.metrics ?? null,
			maintainers: result.maintainers ?? [],
			canArbitrate: result.can_arbitrate !== false,
			trash: result.trash ?? [],
			conflicts: result.conflicts ?? [],
			pinned: result.pinned ?? 0,
			pinLimit: result.pin_limit ?? 50,
			retentionDays: result.retention_days ?? 30,
		},
	};
}

export function registerMemoryLifecycleHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE,
		async (_, projectId: unknown): Promise<IPCResult<MemoryLifecycleView>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			return loadMemoryLifecycle(project.path);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_HISTORY,
		async (_, projectId: unknown, rawId: unknown): Promise<IPCResult<MemoryJournalEntry[]>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = memoryId(rawId);
			if (!id) return INVALID;
			const query = new URLSearchParams({ project_dir: project.path, id });
			const result = await backendFetch<{ entries?: MemoryJournalEntry[] }>(
				`/api/brain/memory/history?${query.toString()}`,
				{ method: "GET" },
				15_000,
			);
			return result.success
				? { success: true, data: result.entries ?? [] }
				: failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_FORGET,
		async (_, projectId: unknown, rawId: unknown, rawReason: unknown): Promise<IPCResult<void>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = memoryId(rawId);
			const reason = boundedText(rawReason, MAX_REASON_LENGTH);
			if (!id || reason === null) return INVALID;
			const result = await backendFetch(
				"/api/brain/memory/forget",
				post({ project_dir: project.path, id, reason }),
			);
			return result.success ? { success: true } : failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_RESTORE,
		async (_, projectId: unknown, rawId: unknown): Promise<IPCResult<MemoryRestoreOutcome>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = trashId(rawId);
			if (!id) return INVALID;
			const result = await backendFetch<Partial<MemoryRestoreOutcome>>(
				"/api/brain/memory/restore",
				post({ project_dir: project.path, id }),
			);
			if (!result.success) return failure(result);
			return {
				success: true,
				data: { path: result.path ?? "", contradicts: result.contradicts ?? [] },
			};
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_PIN,
		async (_, projectId: unknown, rawId: unknown, pinned: unknown): Promise<IPCResult<{ count: number }>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = memoryId(rawId);
			if (!id || typeof pinned !== "boolean") return INVALID;
			const result = await backendFetch<{ count?: number }>(
				"/api/brain/memory/pin",
				post({ project_dir: project.path, id, pinned }),
			);
			return result.success
				? { success: true, data: { count: result.count ?? 0 } }
				: failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT,
		async (
			_,
			projectId: unknown,
			rawConflict: unknown,
			rawChoice: unknown,
			rawText: unknown,
		): Promise<IPCResult<{ canonical: string | null }>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = conflictId(rawConflict);
			const choice = conflictChoice(rawChoice);
			const text = boundedText(rawText, MAX_CANONICAL_LENGTH);
			if (!id || !choice || text === null) return INVALID;
			if (choice === "custom" && !text.trim()) return INVALID;
			const result = await backendFetch<{ canonical?: string | null }>(
				"/api/brain/memory/conflicts/resolve",
				post({ project_dir: project.path, conflict_id: id, choice, text }),
			);
			return result.success
				? { success: true, data: { canonical: result.canonical ?? null } }
				: failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_REVERT,
		async (_, projectId: unknown, rawEntry: unknown): Promise<IPCResult<MemoryRevertOutcome>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = entryId(rawEntry);
			if (!id) return INVALID;
			const result = await backendFetch<Partial<MemoryRevertOutcome>>(
				"/api/brain/memory/revert",
				post({ project_dir: project.path, entry_id: id }),
			);
			if (!result.success) return failure(result);
			return {
				success: true,
				data: {
					mode: result.mode === "unmerge" ? "unmerge" : "undo",
					restored: result.restored ?? [],
					conflict: result.conflict ?? null,
				},
			};
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE,
		async (_, projectId: unknown, rawId: unknown, rawScope: unknown): Promise<IPCResult<{ appliesTo: string }>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = memoryId(rawId);
			const scope = scopeText(rawScope);
			if (!id || scope === null) return INVALID;
			const result = await backendFetch<{ applies_to?: string }>(
				"/api/brain/memory/scope",
				post({ project_dir: project.path, id, applies_to: scope }),
			);
			return result.success
				? { success: true, data: { appliesTo: result.applies_to ?? "" } }
				: failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS,
		async (_, projectId: unknown, rawNames: unknown): Promise<IPCResult<string[]>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const names = maintainerNames(rawNames);
			if (!names) return INVALID;
			const result = await backendFetch<{ maintainers?: string[] }>(
				"/api/brain/memory/maintainers",
				post({ project_dir: project.path, names }),
			);
			return result.success
				? { success: true, data: result.maintainers ?? [] }
				: failure(result);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION,
		async (_, projectId: unknown, rawConflict: unknown): Promise<IPCResult<MemoryConflictOpinion>> => {
			const project = localProject(projectId);
			if ("error" in project) return { success: false, error: project.error };
			const id = conflictId(rawConflict);
			if (!id) return INVALID;
			const result = await backendFetch<{ opinion?: MemoryConflictOpinion }>(
				"/api/brain/memory/conflicts/suggest",
				post({ project_dir: project.path, conflict_id: id }),
				120_000,
			);
			if (!result.success) return failure(result);
			return result.opinion
				? { success: true, data: result.opinion }
				: { success: false, error: "no-answer" };
		},
	);
}
