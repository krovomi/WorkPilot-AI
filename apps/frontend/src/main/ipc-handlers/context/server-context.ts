/**
 * The Context view of a server project (server mode).
 *
 * Its index is a shared feature's file (`server-features.ts`, "context"):
 * read into the mirror, rebuilt by a job of the analyzer on the server. Its
 * memories are the project's own brain on the server, which every build of
 * the project learns into (`apps/backend/shared_features/context.py`); the
 * person's brain on this computer is never read for it.
 *
 * What the server sends is checked again here, each memory to the tab's
 * shape and size; the server never sends where its brain is.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";
import type {
	ContextSearchResult,
	IPCResult,
	MemoryEpisode,
	MemoryStatus,
	MemoryType,
	Project,
	ProjectIndex,
} from "../../../shared/types";
import { authedFetch } from "../../server-connection";
import { relayServerJob } from "../../server-features";
import { refreshServerFeature } from "../server-feature-files";

const MAX_CONTENT = 2_000;
const MAX_ROWS = 200;
const MAX_QUERY = 500;
const MAX_ERROR = 2_000;

interface ServerMemories {
	status: MemoryStatus;
	memories: MemoryEpisode[];
	results: ContextSearchResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function status(available: boolean): MemoryStatus {
	return available
		? { enabled: true, available: true, database: "WorkPilot Brain", onServer: true }
		: {
				enabled: true,
				available: false,
				onServer: true,
				reason: "reasons.serverBrainNotCreated",
			};
}

function episode(value: unknown): MemoryEpisode | null {
	if (!isRecord(value)) return null;
	const id = text(value.id, 300);
	const content = text(value.content, MAX_CONTENT);
	if (!id || !content) return null;
	return {
		id,
		type: (text(value.type, 40) || "session_insight") as MemoryType,
		timestamp: text(value.timestamp, 40),
		content,
		...(typeof value.session_number === "number"
			? { session_number: value.session_number }
			: {}),
	};
}

function result(value: unknown): ContextSearchResult | null {
	if (!isRecord(value)) return null;
	const content = text(value.content, MAX_CONTENT);
	if (!content) return null;
	return {
		content,
		score: typeof value.score === "number" ? value.score : 0,
		type: text(value.type, 40) || "knowledge",
	};
}

function rows<T>(value: unknown, read: (row: unknown) => T | null): T[] {
	return Array.isArray(value)
		? value
				.slice(0, MAX_ROWS)
				.map(read)
				.filter((row): row is T => row !== null)
		: [];
}

/** The project's memories, the most recent first, or ranked against `query`. */
export async function fetchServerMemories(
	project: Project,
	{ query = "", limit = 20 }: { query?: string; limit?: number },
): Promise<IPCResult<ServerMemories>> {
	const params = new URLSearchParams({
		project_id: project.id,
		limit: String(Math.max(1, Math.min(Math.trunc(limit) || 20, MAX_ROWS))),
	});
	const asked = typeof query === "string" ? query.trim().slice(0, MAX_QUERY) : "";
	if (asked) params.set("query", asked);
	const answer = await authedFetch<unknown>(
		`/api/features/context/memories?${params.toString()}`,
		"GET",
	);
	if (!answer.ok) return { success: false, error: answer.error };
	if (!isRecord(answer.data)) {
		return { success: false, error: "Unexpected answer from the server" };
	}
	return {
		success: true,
		data: {
			status: status(answer.data.available === true),
			memories: rows(answer.data.memories, episode),
			results: rows(answer.data.results, result),
		},
	};
}

/** The index as mirrored from the server, or null when it has none yet. */
export function mirroredIndex(project: Project): ProjectIndex | null {
	const file = path.join(project.path, AUTO_BUILD_PATHS.PROJECT_INDEX);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as ProjectIndex;
	} catch {
		return null;
	}
}

/** Read the server's index into the mirror; the error when it cannot. */
export function pullServerIndex(project: Project): Promise<string | null> {
	return refreshServerFeature(project, "context");
}

/**
 * Rebuild the index on the server (a job of the analyzer) and read it back.
 * A teammate's rebuild already running is followed, not doubled: the server
 * refuses a second one, and the person sees why.
 */
export function rebuildServerIndex(
	project: Project,
): Promise<IPCResult<ProjectIndex>> {
	return new Promise((resolve) => {
		const job = relayServerJob(project, "context", { options: {} });
		let failure = "";
		job.stderr.on("data", (data: Buffer) => {
			failure = (failure + data.toString("utf-8")).slice(-MAX_ERROR);
		});
		job.on("exit", (code: number | null) => {
			if (code !== 0) {
				resolve({
					success: false,
					error: failure.trim() || "The server could not rebuild the index",
				});
				return;
			}
			const index = mirroredIndex(project);
			resolve(
				index
					? { success: true, data: index }
					: { success: false, error: "Failed to generate project index" },
			);
		});
	});
}
