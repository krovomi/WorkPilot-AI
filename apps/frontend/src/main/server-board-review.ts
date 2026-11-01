/**
 * Reviewing a server card's work from the app (server mode). A server card's
 * build workspace is on the server, so the review panel reads its changes
 * from there, sends the work back through the server, and starts the merge
 * or the pull request as runs the server executes with its own permissions.
 * Nothing here runs git or writes a file on this computer.
 *
 * The worktree and review handlers send here any task id that names a server
 * card (`findServerCard`).
 */

import type {
	IPCResult,
	WorktreeCreatePRResult,
	WorktreeDiff,
	WorktreeDiffFile,
	WorktreeMergeResult,
	WorktreeStatus,
} from "../shared/types";
import { type ServerCard, startRun } from "./server-board-actions";
import { serverImageUploads } from "./server-card-images";
import { authedFetch } from "./server-connection";

const MAX_FEEDBACK = 20_000;
const FILE_STATUS = new Set<WorktreeDiffFile["status"]>([
	"added",
	"modified",
	"deleted",
	"renamed",
]);

interface ServerChanges {
	status: WorktreeStatus;
	diff: WorktreeDiff;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toFile(raw: unknown): WorktreeDiffFile | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const status = item.status as WorktreeDiffFile["status"];
	if (typeof item.path !== "string" || !item.path || !FILE_STATUS.has(status)) {
		return null;
	}
	return {
		path: item.path,
		status,
		additions: count(item.additions) ?? 0,
		deletions: count(item.deletions) ?? 0,
		patch: text(item.patch),
	};
}

/** The server's answer, taken field by field: nothing else reaches the view. */
export function parseChanges(data: unknown): ServerChanges | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	if (raw.exists !== true) {
		return { status: { exists: false }, diff: { files: [], summary: "" } };
	}
	const files = Array.isArray(raw.files)
		? raw.files.map(toFile).filter((f): f is WorktreeDiffFile => f !== null)
		: [];
	return {
		status: {
			exists: true,
			branch: text(raw.branch),
			baseBranch: text(raw.baseBranch),
			commitCount: count(raw.commitCount),
			filesChanged: count(raw.filesChanged),
			additions: count(raw.additions),
			deletions: count(raw.deletions),
		},
		diff: { files, summary: text(raw.summary) ?? "" },
	};
}

function cardUrl(card: ServerCard, action: string): string {
	return `/api/board/cards/${encodeURIComponent(card.cardId)}/${action}?project_id=${encodeURIComponent(card.project.id)}`;
}

async function changes(card: ServerCard): Promise<IPCResult<ServerChanges>> {
	const result = await authedFetch<unknown>(cardUrl(card, "changes"), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const parsed = parseChanges(result.data);
	return parsed
		? { success: true, data: parsed }
		: { success: false, error: "Unexpected answer from the server" };
}

export async function serverWorktreeStatus(
	card: ServerCard,
): Promise<IPCResult<WorktreeStatus>> {
	const result = await changes(card);
	return result.success && result.data
		? { success: true, data: result.data.status }
		: { success: false, error: result.error };
}

export async function serverWorktreeDiff(
	card: ServerCard,
): Promise<IPCResult<WorktreeDiff>> {
	const result = await changes(card);
	if (!result.success || !result.data) return { success: false, error: result.error };
	return result.data.status.exists
		? { success: true, data: result.data.diff }
		: { success: false, error: "No worktree found for this task" };
}

export async function serverFileDiff(
	card: ServerCard,
	filePath: unknown,
): Promise<IPCResult<WorktreeDiffFile>> {
	if (typeof filePath !== "string" || !filePath) {
		return { success: false, error: "Invalid file path" };
	}
	const wanted = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
	const result = await serverWorktreeDiff(card);
	if (!result.success || !result.data) return { success: false, error: result.error };
	const file = result.data.files.find((f) => f.path === wanted);
	return file ? { success: true, data: file } : { success: false, error: "File not changed" };
}

/**
 * There is no merge preview from the server yet: the merge itself runs
 * there, and the card shows its outcome. An empty preview lets the panel
 * offer the merge without inventing conflicts it did not check.
 */
export function previewServerMerge(): IPCResult<WorktreeMergeResult> {
	return { success: true, data: { success: true, message: "" } };
}

/** Merge on the server: a `merge` run, which needs `task.merge` there. */
export async function mergeServerCard(
	card: ServerCard,
	options?: unknown,
): Promise<IPCResult<WorktreeMergeResult>> {
	if ((options as { noCommit?: unknown } | undefined)?.noCommit === true) {
		// Staging leaves changes uncommitted in a checkout to look at: the
		// server's clone is nobody's to look at, so it is not offered.
		return { success: false, error: "Stage-only merge is not available on a server project" };
	}
	const run = await startRun(card, "merge");
	return run.success
		? { success: true, data: { success: true, message: "Merge started on the server" } }
		: { success: false, error: run.error };
}

/**
 * Open the pull request from the server: a `pr` run, which needs
 * `vcs.pr.create` there. The server writes the title and body from the spec;
 * the dialog's own edits are not sent.
 */
export async function createServerCardPR(
	card: ServerCard,
): Promise<IPCResult<WorktreeCreatePRResult>> {
	const run = await startRun(card, "pr");
	return run.success
		? {
				success: true,
				data: { success: true, message: "Pull request started on the server" },
			}
		: { success: false, error: run.error };
}

/**
 * The review panel's answer on a server card. Approving records this person's
 * approval of the spec on the server (Start then builds it). Sending the work
 * back writes the request where the build reads it and starts the build again.
 */
export async function reviewServerCard(
	card: ServerCard,
	approved: unknown,
	feedback?: unknown,
	images?: unknown,
): Promise<IPCResult> {
	if (approved === true) {
		const result = await authedFetch(cardUrl(card, "approve"), "POST");
		return result.ok ? { success: true } : { success: false, error: result.error };
	}
	const uploads = serverImageUploads(images);
	if (uploads.error) return { success: false, error: uploads.error };
	const said = typeof feedback === "string" ? feedback.trim() : "";
	if (!said || said.length > MAX_FEEDBACK) {
		return { success: false, error: "Say what to change" };
	}
	const sent = await authedFetch(cardUrl(card, "request-changes"), "POST", {
		feedback: said,
		...(uploads.uploads?.length ? { images: uploads.uploads } : {}),
	});
	if (!sent.ok) return { success: false, error: sent.error };
	return startRun(card, "build");
}
