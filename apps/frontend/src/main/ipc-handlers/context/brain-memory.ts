/**
 * The project's memory, read from the shared brain.
 *
 * What the builds learn is kept in one place — the Obsidian vault
 * (`apps/backend/brain/project_memory.py`) — and the Memories tab reads it
 * through the backend, like every other surface. It used to read LadybugDB
 * when Graphiti was switched on and `<spec>/memory/` files otherwise, so the
 * tab showed whichever store the last build had happened to reach.
 */

import type {
	ContextSearchResult,
	GraphitiMemoryStatus,
	MemoryEpisode,
} from "../../../shared/types";
import { backendFetch } from "../_backend-fetch";

interface BrainStatusResponse {
	root?: string;
	exists?: boolean;
	enabled?: boolean;
}

interface BrainMemoriesResponse {
	memories?: MemoryEpisode[];
	results?: ContextSearchResult[];
}

/** Where the vault is, and whether it exists yet — in the tab's status shape. */
export async function fetchBrainMemoryStatus(): Promise<GraphitiMemoryStatus> {
	const result = await backendFetch<BrainStatusResponse>(
		"/api/brain/status",
		{ method: "GET" },
		10_000,
	);
	if (!result.success) {
		return { enabled: false, available: false, reason: "reasons.brainUnreachable" };
	}
	if (!result.exists) {
		// Created by the first build that learns something, or plugged in
		// from Settings → Integrations → Shared brain.
		return {
			enabled: true,
			available: false,
			dbPath: result.root,
			reason: "reasons.brainNotCreated",
		};
	}
	return {
		enabled: true,
		available: true,
		database: "WorkPilot Brain",
		dbPath: result.root,
	};
}

function memoriesPath(projectPath: string, params: Record<string, string>): string {
	const query = new URLSearchParams({ project_dir: projectPath, ...params });
	return `/api/brain/memories?${query.toString()}`;
}

/** The project's most recent memories, newest first. */
export async function loadBrainMemories(
	projectPath: string,
	limit: number,
): Promise<MemoryEpisode[]> {
	const result = await backendFetch<BrainMemoriesResponse>(
		memoriesPath(projectPath, { limit: String(limit) }),
		{ method: "GET" },
		15_000,
	);
	return result.success ? (result.memories ?? []) : [];
}

/** The project's memories ranked against a query. */
export async function searchBrainMemories(
	projectPath: string,
	query: string,
	limit: number,
): Promise<ContextSearchResult[]> {
	const result = await backendFetch<BrainMemoriesResponse>(
		memoriesPath(projectPath, { query, limit: String(limit) }),
		{ method: "GET" },
		15_000,
	);
	return result.success ? (result.results ?? []) : [];
}
