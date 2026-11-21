/**
 * Sharing a recorded agent session (#347): export it as a `.wpreplay` bundle
 * or a standalone page, import a bundle someone sent, mark steps and answer
 * a mark.
 *
 * The local backend masks the session and builds the file; main asks where
 * to write it, or which bundle to read, in a native dialog. The renderer
 * never names a path: it gives a session id, closed-list options and
 * bounded text, all checked here. A bundle is read only up to the size the
 * backend accepts, and the backend rebuilds every field of it.
 */

import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	ReplayFileResult,
	ReplayImportResult,
} from "../../shared/types/replay-share";
import { showOpenDialog, showSaveDialog } from "../electron-utils";
import { backendFetch } from "./_backend-fetch";
import { isReplayId } from "./replay-handlers";

/** As `MAX_BUNDLE_BYTES` in `apps/backend/replay/bundle.py`. */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const MAX_NOTE = 4000;
const MAX_AUTHOR = 100;
const MAX_STEP = 1_000_000;
const TIMEOUT_MS = 120_000;
const FORMATS = new Set(["wpreplay", "html"]);

export interface ExportBody {
	format: "wpreplay" | "html";
	strip_reasoning: boolean;
	strip_tokens: boolean;
	include_file_contents: boolean;
	language: "en" | "fr";
}

const invalid = (what: string) => ({
	success: false as const,
	error: `Invalid ${what}`,
});

function flag(value: unknown): boolean | null {
	if (value === undefined) return false;
	return typeof value === "boolean" ? value : null;
}

/** The export the renderer asks for, or null when malformed. */
export function exportBody(raw: unknown): ExportBody | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	if (typeof source.format !== "string" || !FORMATS.has(source.format)) return null;
	const flags = [
		flag(source.stripReasoning),
		flag(source.stripTokens),
		flag(source.includeFileContents),
	];
	if (flags.includes(null)) return null;
	return {
		format: source.format as ExportBody["format"],
		strip_reasoning: flags[0] === true,
		strip_tokens: flags[1] === true,
		include_file_contents: flags[2] === true,
		language: source.language === "fr" ? "fr" : "en",
	};
}

/** The bookmark the renderer asks for, or null when malformed. */
export function bookmarkBody(
	raw: unknown,
): { step_index: number; note: string; author: string } | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const step = source.stepIndex;
	if (!Number.isInteger(step) || (step as number) < 0 || (step as number) > MAX_STEP) {
		return null;
	}
	const note = source.note;
	const author = source.author ?? "";
	if (typeof note !== "string" || note.length > MAX_NOTE) return null;
	if (typeof author !== "string" || author.length > MAX_AUTHOR) return null;
	return { step_index: step as number, note, author };
}

/** A reply to a bookmark, or null when malformed. */
export function replyBody(raw: unknown): { note: string; author: string } | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const note = source.note;
	const author = source.author ?? "";
	if (typeof note !== "string" || !note.trim() || note.length > MAX_NOTE) return null;
	if (typeof author !== "string" || author.length > MAX_AUTHOR) return null;
	return { note, author };
}

const json = (body: unknown): RequestInit => ({
	method: "POST",
	body: JSON.stringify(body),
});

async function exportSession(
	sessionId: unknown,
	options: unknown,
): Promise<ReplayFileResult> {
	if (!isReplayId(sessionId)) return invalid("session id");
	const body = exportBody(options);
	if (!body) return invalid("export options");
	const built = await backendFetch<{ file_name: string; content_base64: string }>(
		`/replay/sessions/${sessionId}/export`,
		json(body),
		TIMEOUT_MS,
	);
	if (!built.success) return built;
	const extension = body.format;
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: path.basename(String(built.file_name)),
		filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
	});
	if (canceled || !filePath) return { success: true, canceled: true };
	const content = exportedFile(built.content_base64, extension);
	if (!content) return { success: false, error: "bad_export" };
	await writeFile(filePath, content);
	return { success: true, filePath };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const HTML_START = Buffer.from("<!doctype html>");

/**
 * The bytes the backend built, only when they are what was asked for: a
 * gzip bundle or a page, no larger than a bundle the backend would read back.
 */
export function exportedFile(raw: unknown, format: ExportBody["format"]): Buffer | null {
	if (typeof raw !== "string" || !BASE64.test(raw)) return null;
	if (raw.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4) return null;
	const bytes = Buffer.from(raw, "base64");
	const start = format === "html" ? HTML_START : GZIP_MAGIC;
	return bytes.subarray(0, start.length).equals(start) ? bytes : null;
}

/** Reads through one handle, so the file checked is the file read; never more than a bundle. */
export async function readBundle(file: string): Promise<Buffer | "not_a_file" | "too_large"> {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) return "not_a_file";
		if (info.size > MAX_BUNDLE_BYTES) return "too_large";
		const buffer = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		return total > MAX_BUNDLE_BYTES ? "too_large" : buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
}

async function importSession(): Promise<ReplayImportResult> {
	const { canceled, filePaths } = await showOpenDialog({
		properties: ["openFile"],
		filters: [{ name: "WPREPLAY", extensions: ["wpreplay", "json"] }],
	});
	const filePath = filePaths?.[0];
	if (canceled || !filePath) return { success: true, canceled: true };
	const content = await readBundle(filePath);
	if (typeof content === "string") return { success: false, error: content };
	return backendFetch<{ session: { session_id: string; agent_name: string } }>(
		"/replay/import",
		json({ content_base64: content.toString("base64") }),
		TIMEOUT_MS,
	);
}

export function registerReplayShareHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_EXPORT_SESSION,
		(_e, sessionId: unknown, options: unknown) => exportSession(sessionId, options),
	);

	ipcMain.handle(IPC_CHANNELS.REPLAY_IMPORT_SESSION, () => importSession());

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_ADD_BOOKMARK,
		(_e, sessionId: unknown, bookmark: unknown) => {
			if (!isReplayId(sessionId)) return invalid("session id");
			const body = bookmarkBody(bookmark);
			if (!body) return invalid("bookmark");
			return backendFetch(`/replay/sessions/${sessionId}/bookmarks`, json(body));
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK,
		(_e, sessionId: unknown, bookmarkId: unknown) =>
			isReplayId(sessionId) && isReplayId(bookmarkId)
				? backendFetch(`/replay/sessions/${sessionId}/bookmarks/${bookmarkId}`, {
						method: "DELETE",
					})
				: invalid("bookmark id"),
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_ADD_BOOKMARK_REPLY,
		(_e, sessionId: unknown, bookmarkId: unknown, reply: unknown) => {
			if (!isReplayId(sessionId) || !isReplayId(bookmarkId)) return invalid("bookmark id");
			const body = replyBody(reply);
			if (!body) return invalid("reply");
			return backendFetch(
				`/replay/sessions/${sessionId}/bookmarks/${bookmarkId}/replies`,
				json(body),
			);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK_REPLY,
		(_e, sessionId: unknown, bookmarkId: unknown, replyId: unknown) =>
			isReplayId(sessionId) && isReplayId(bookmarkId) && isReplayId(replyId)
				? backendFetch(
						`/replay/sessions/${sessionId}/bookmarks/${bookmarkId}/replies/${replyId}`,
						{ method: "DELETE" },
					)
				: invalid("reply id"),
	);
}
