/**
 * The board of a server project, drawn like a local one.
 *
 * The server sends the files the app reads to draw its cards
 * (`GET /api/board/snapshot`, `apps/backend/shared_board/api.py`). They are
 * written into the project's mirror folder in the layout of a local project
 * and read by the project store's own loader, so a server card looks exactly
 * like a local one. The mirror is rewritten from scratch on each read: it is
 * never the source of anything, and nothing runs in it.
 *
 * What the server sends is checked again here: card ids by the board's
 * pattern, file names against a closed list, sizes against its limits.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IPCResult, Project, Task } from "../shared/types";
import { projectStore } from "./project-store";
import { authedFetch } from "./server-connection";

/** The files of a card the app reads, with the most of each it accepts. */
export const SNAPSHOT_FILES: ReadonlyMap<string, number> = new Map([
	["implementation_plan.json", 1_000_000],
	["task_metadata.json", 200_000],
	["requirements.json", 200_000],
	["pause_state.json", 50_000],
	["review_state.json", 50_000],
	["spec.md", 300_000],
	["qa_report.md", 300_000],
]);

/** Same pattern as the board's (`board_mcp/server.py`, `CARD_ID`). */
const CARD_ID = /^\d{3,4}-[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_CARDS = 500;

type CardFiles = Record<string, string>;

export interface BoardSnapshot {
	cards: Record<string, CardFiles>;
	worktrees: Record<string, CardFiles>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function cardFiles(raw: unknown): CardFiles {
	const files: CardFiles = {};
	if (!isRecord(raw)) return files;
	for (const [name, content] of Object.entries(raw)) {
		const limit = SNAPSHOT_FILES.get(name);
		if (
			limit !== undefined &&
			typeof content === "string" &&
			Buffer.byteLength(content, "utf-8") <= limit
		) {
			files[name] = content;
		}
	}
	return files;
}

/** The snapshot keeping only what the app reads, or null when it is not one. */
export function parseSnapshot(raw: unknown): BoardSnapshot | null {
	if (!isRecord(raw) || !isRecord(raw.cards)) return null;
	const cards: Record<string, CardFiles> = {};
	for (const [id, files] of Object.entries(raw.cards)) {
		if (Object.keys(cards).length >= MAX_CARDS) break;
		if (CARD_ID.test(id)) cards[id] = cardFiles(files);
	}
	const worktrees: Record<string, CardFiles> = {};
	if (isRecord(raw.worktrees)) {
		for (const [id, files] of Object.entries(raw.worktrees)) {
			if (Object.hasOwn(cards, id)) worktrees[id] = cardFiles(files);
		}
	}
	return { cards, worktrees };
}

function writeCard(directory: string, files: CardFiles): void {
	mkdirSync(directory, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(directory, name), content, "utf-8");
	}
}

/** Replace the mirror's board with the snapshot, in a local project's layout. */
export function writeMirror(root: string, snapshot: BoardSnapshot): void {
	const workpilot = path.join(root, ".workpilot");
	rmSync(workpilot, { recursive: true, force: true });
	mkdirSync(path.join(workpilot, "specs"), { recursive: true });
	for (const [id, files] of Object.entries(snapshot.cards)) {
		writeCard(path.join(workpilot, "specs", id), files);
	}
	for (const [id, files] of Object.entries(snapshot.worktrees)) {
		const tree = path.join(workpilot, "worktrees", "tasks", id);
		writeCard(path.join(tree, ".workpilot", "specs", id), files);
	}
}

async function load(project: Project): Promise<IPCResult<Task[]>> {
	const result = await authedFetch<unknown>(
		`/api/board/snapshot?project_id=${encodeURIComponent(project.id)}`,
		"GET",
	);
	if (!result.ok) return { success: false, error: result.error };
	const snapshot = parseSnapshot(result.data);
	if (!snapshot) {
		return { success: false, error: "Unexpected answer from the server" };
	}
	writeMirror(project.path, snapshot);
	return { success: true, data: projectStore.getMirrorTasks(project) };
}

const inFlight = new Map<string, Promise<IPCResult<Task[]>>>();

/**
 * The cards of a server project, fresh from the server. Concurrent reads of
 * one project share a request, so two never rewrite the mirror together.
 */
export function getRemoteTasks(project: Project): Promise<IPCResult<Task[]>> {
	const pending = inFlight.get(project.id);
	if (pending) return pending;
	const request = load(project)
		.catch(
			(error): IPCResult<Task[]> => ({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}),
		)
		.finally(() => inFlight.delete(project.id));
	inFlight.set(project.id, request);
	return request;
}
