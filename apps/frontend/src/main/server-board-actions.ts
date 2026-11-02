/**
 * What the app does to a server card (server mode): create, edit, delete it,
 * start and stop its work. Every action is a request to the server, which
 * checks the person's rights and writes the card; the app then reads the
 * board again. Nothing is written or run on this computer.
 *
 * The task handlers send here any task whose id names a server project
 * (`serverTaskId`), and `TASK_CREATE` any server project id.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type {
	CardEditConflict,
	IPCResult,
	Project,
	Task,
	TaskMetadata,
	TaskUpdateResult,
} from "../shared/types";
import { CARD_EDIT_CONFLICT } from "../shared/types/team-room";
import { getRemoteTasks, parseServerTaskId } from "./remote-board";
import { serverImageUploads } from "./server-card-images";
import { patchServerCardSettings, settingsFromMetadata } from "./server-card-settings";
import { authedFetch } from "./server-connection";
import { getServerProject } from "./server-projects";

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
/** Length of a title taken from the description, as `TASK_CREATE` cuts it. */
const FALLBACK_TITLE = 60;
const ACTIVE_RUN = new Set(["queued", "running"]);

export interface ServerCard {
	project: Project;
	cardId: string;
}

/** The server card a task id names, when its project is one the app listed. */
export function findServerCard(taskId: unknown): ServerCard | null {
	const parsed = parseServerTaskId(taskId);
	const project = parsed ? getServerProject(parsed.projectId) : undefined;
	return parsed && project ? { project, cardId: parsed.cardId } : null;
}

function cardsUrl(project: Project, cardId?: string, action?: string): string {
	const card = cardId ? `/${encodeURIComponent(cardId)}` : "";
	const verb = action ? `/${action}` : "";
	return `/api/board/cards${card}${verb}?project_id=${encodeURIComponent(project.id)}`;
}

function specsUrl(project: Project, rest = ""): string {
	return `/projects/${encodeURIComponent(project.id)}/specs${rest}`;
}

/** The card as the board now has it, read again from the server. */
async function reread(card: ServerCard): Promise<IPCResult<Task>> {
	return serverCardTask(card.project, card.cardId);
}

/** A card of a server project's board, read again from the server. */
export async function serverCardTask(
	project: Project,
	cardId: string,
): Promise<IPCResult<Task>> {
	const card = { project, cardId };
	const tasks = await getRemoteTasks(card.project);
	if (!tasks.success || !tasks.data) {
		return { success: false, error: tasks.error ?? "Board unavailable" };
	}
	const task = tasks.data.find((t) => t.specId === card.cardId);
	return task ? { success: true, data: task } : { success: false, error: "Card not found" };
}

/** A card title made of the description's first non-empty line. */
function titleFromDescription(description: string): string {
	const line =
		description
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	return line.length > FALLBACK_TITLE ? `${line.slice(0, FALLBACK_TITLE)}...` : line;
}

export async function createServerCard(
	project: Project,
	title: unknown,
	description: unknown,
	metadata?: TaskMetadata,
): Promise<IPCResult<Task>> {
	const text = typeof description === "string" ? description : "";
	const given = typeof title === "string" ? title.trim() : "";
	// The New Task dialog leaves the title optional: as on the computer when
	// no title can be generated, the description's first line stands for it.
	const name = given || titleFromDescription(text);
	if (!name || name.length > MAX_TITLE || text.length > MAX_DESCRIPTION) {
		return { success: false, error: "Invalid title or description" };
	}
	const settings = settingsFromMetadata(metadata);
	const images = serverImageUploads(metadata?.attachedImages);
	if (images.error) return { success: false, error: images.error };
	const result = await authedFetch<{ id?: unknown }>(cardsUrl(project), "POST", {
		title: name,
		description: text,
		require_review: metadata?.requireReviewBeforeCoding !== false,
		// The engine, priority and category the dialog chose; the server writes
		// them where the build reads them.
		...(settings ? { settings } : {}),
		...(images.uploads?.length ? { attachments: images.uploads } : {}),
	});
	if (!result.ok) return { success: false, error: result.error };
	const cardId = result.data?.id;
	if (typeof cardId !== "string") {
		return { success: false, error: "Unexpected answer from the server" };
	}
	return reread({ project, cardId });
}

/**
 * Weigh an edit against the card as it now is on the server. `base` is the
 * card as the dialog opened it. A field this person left as it was is not
 * sent, so a teammate's change to it stays; a field both changed is a
 * conflict, for the person to settle. Without a base (another caller, or the
 * person chose "last write wins"), the edit is taken as it is.
 */
export function reconcileEdit(
	base: unknown,
	changes: Readonly<Record<string, string>>,
	current: Pick<Task, "title" | "description">,
): { changes: Record<string, string>; conflicts: CardEditConflict[] } {
	const kept = { ...changes };
	if (!base || typeof base !== "object") return { changes: kept, conflicts: [] };
	const was = base as Record<string, unknown>;
	const conflicts: CardEditConflict[] = [];
	for (const field of ["title", "description"] as const) {
		const mine = kept[field];
		const raw = was[field];
		if (mine === undefined || typeof raw !== "string") continue;
		const before = field === "title" ? raw.trim() : raw;
		const theirs = current[field] ?? "";
		if (mine === before) delete kept[field];
		else if (before !== theirs) conflicts.push({ field, mine, theirs });
	}
	return { changes: kept, conflicts };
}

export async function updateServerCard(
	card: ServerCard,
	updates: unknown,
): Promise<TaskUpdateResult> {
	const raw = (updates && typeof updates === "object" ? updates : {}) as Record<
		string,
		unknown
	>;
	const current = await reread(card);
	if (!current.success || !current.data) return { success: false, error: current.error };
	// Only what changed: the edit dialog sends the text back unchanged, and the
	// server refuses a text edit once work started, while the engine may change.
	const asked: Record<string, string> = {};
	if (typeof raw.title === "string" && raw.title.trim() !== current.data.title) {
		asked.title = raw.title.trim();
	}
	if (typeof raw.description === "string" && raw.description !== current.data.description) {
		asked.description = raw.description;
	}
	const { changes: body, conflicts } = reconcileEdit(raw.base, asked, current.data);
	if (conflicts.length > 0) return { success: false, error: CARD_EDIT_CONFLICT, conflicts };
	if (body.title !== undefined && (!body.title || body.title.length > MAX_TITLE)) {
		return { success: false, error: "Invalid title" };
	}
	if ((body.description?.length ?? 0) > MAX_DESCRIPTION) {
		return { success: false, error: "Description too long" };
	}
	const settings = settingsFromMetadata(raw.metadata as Partial<TaskMetadata> | undefined);
	if (settings) {
		const result = await patchServerCardSettings(card, settings);
		if (!result.success) return { success: false, error: result.error };
	}
	if (Object.keys(body).length > 0) {
		const result = await authedFetch(cardsUrl(card.project, card.cardId), "PATCH", body);
		if (!result.ok) return { success: false, error: result.error };
	}
	return reread(card);
}

export async function deleteServerCard(card: ServerCard): Promise<IPCResult> {
	const result = await authedFetch(cardsUrl(card.project, card.cardId), "DELETE");
	return result.ok ? { success: true } : { success: false, error: result.error };
}

/** The server's index id of a card, which its run and claim routes take. */
export async function serverCardIndexId(card: ServerCard): Promise<IPCResult<string>> {
	const result = await authedFetch<unknown>(specsUrl(card.project), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const row = Array.isArray(result.data)
		? result.data.find(
				(item) =>
					item &&
					typeof item === "object" &&
					(item as Record<string, unknown>).spec_name === card.cardId,
			)
		: undefined;
	const id = (row as Record<string, unknown> | undefined)?.id;
	return typeof id === "string" ? { success: true, data: id } : { success: false, error: "Card not found" };
}

/** Start one of the card's run phases on the server, which checks its permission. */
export async function startRun(
	card: ServerCard,
	phase: "spec" | "build" | "merge" | "pr",
	pr?: Record<string, unknown>,
): Promise<IPCResult> {
	const id = await serverCardIndexId(card);
	if (!id.success || !id.data) return { success: false, error: id.error };
	const result = await authedFetch(
		specsUrl(card.project, `/${encodeURIComponent(id.data)}/runs`),
		"POST",
		pr ? { phase, pr } : { phase },
	);
	return result.ok ? { success: true } : { success: false, error: result.error };
}

/**
 * Start a card's work on the server, as the app's Start does locally: a card
 * without a spec gets one (and its build when it asks for no review); a card
 * with a spec is built or resumed, and when it asks for a review, starting it
 * is this person approving the spec as it now stands (the server records who).
 */
export async function startServerCard(card: ServerCard): Promise<IPCResult> {
	const current = await reread(card);
	if (!current.success || !current.data) return { success: false, error: current.error };
	const spec = path.join(card.project.path, ".workpilot", "specs", card.cardId, "spec.md");
	if (!existsSync(spec)) return startRun(card, "spec");
	if (current.data.metadata?.requireReviewBeforeCoding !== false) {
		const approval = await authedFetch(
			cardsUrl(card.project, card.cardId, "approve"),
			"POST",
		);
		if (!approval.ok) return { success: false, error: approval.error };
	}
	return startRun(card, "build");
}

/** Stop the card's run on the server, if one is queued or running. */
export async function stopServerCard(card: ServerCard): Promise<IPCResult> {
	const id = await serverCardIndexId(card);
	if (!id.success || !id.data) return { success: false, error: id.error };
	const runs = await authedFetch<unknown>(
		specsUrl(card.project, `/${encodeURIComponent(id.data)}/runs`),
		"GET",
	);
	if (!runs.ok) return { success: false, error: runs.error };
	const active = Array.isArray(runs.data)
		? (runs.data as Array<Record<string, unknown>>).find(
				(run) => typeof run?.id === "string" && ACTIVE_RUN.has(String(run.status)),
			)
		: undefined;
	if (!active) return { success: true };
	const result = await authedFetch(
		specsUrl(
			card.project,
			`/${encodeURIComponent(id.data)}/runs/${encodeURIComponent(String(active.id))}/cancel`,
		),
		"POST",
	);
	return result.ok ? { success: true } : { success: false, error: result.error };
}
