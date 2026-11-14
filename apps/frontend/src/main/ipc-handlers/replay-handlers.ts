/**
 * Agent Replay and Session History: recorded agent sessions, read from the
 * local backend (`apps/backend/replay/api.py`, `dashboard/api.py`).
 *
 * The renderer used to fetch `${VITE_BACKEND_URL}/replay/...` itself. The
 * variable is never set in the renderer (electron-vite reads `.env` files from
 * `src/renderer`, not from `.env-files/`), so the URL was relative: in dev it
 * reached the Vite server, which answered its HTML page, and the views said the
 * backend did not answer while it ran; packaged, a `file://` page has no
 * origin the backend's CORS accepts. Main reaches the backend the app starts
 * (`backendFetch`), as every other machine feature does.
 *
 * Every argument is checked here: ids name a JSON file in the backend's
 * replay store, so only plain id characters pass.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { type BackendResult, backendFetch } from "./_backend-fetch";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TEXT = 2000;
const BREAKPOINT_TYPES = new Set([
	"tool_call",
	"file_change",
	"decision",
	"error",
	"token_threshold",
	"step_index",
	"pattern_match",
]);

type Invalid = { success: false; error: string };

const invalid = (what: string): Invalid => ({
	success: false,
	error: `Invalid ${what}`,
});

export function isReplayId(value: unknown): value is string {
	return typeof value === "string" && ID.test(value);
}

function boundedText(value: unknown): string | null {
	if (value === undefined || value === null) return "";
	return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

/** The body of a breakpoint the renderer asks for, or null when malformed. */
export function breakpointBody(raw: unknown): Record<string, string> | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const type = source.breakpoint_type;
	if (typeof type !== "string" || !BREAKPOINT_TYPES.has(type)) return null;
	const condition = boundedText(source.condition);
	const description = boundedText(source.description);
	if (condition === null || description === null) return null;
	return { breakpoint_type: type, condition, description };
}

const json = (body: unknown): RequestInit => ({
	method: "POST",
	body: JSON.stringify(body),
});

export function registerReplayHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_LIST_SESSIONS,
		(): Promise<BackendResult<Record<string, unknown>>> =>
			backendFetch("/replay/sessions"),
	);

	ipcMain.handle(IPC_CHANNELS.REPLAY_GET_SESSION, (_e, sessionId: unknown) =>
		isReplayId(sessionId)
			? backendFetch(`/replay/sessions/${sessionId}`)
			: invalid("session id"),
	);

	ipcMain.handle(IPC_CHANNELS.REPLAY_DELETE_SESSION, (_e, sessionId: unknown) =>
		isReplayId(sessionId)
			? backendFetch(`/replay/sessions/${sessionId}`, { method: "DELETE" })
			: invalid("session id"),
	);

	ipcMain.handle(IPC_CHANNELS.REPLAY_GET_HEATMAP, (_e, sessionId: unknown) =>
		isReplayId(sessionId)
			? backendFetch(`/replay/sessions/${sessionId}/heatmap`)
			: invalid("session id"),
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_COMPARE,
		(_e, sessionAId: unknown, sessionBId: unknown) =>
			isReplayId(sessionAId) && isReplayId(sessionBId)
				? backendFetch(
						"/replay/compare",
						json({ session_a_id: sessionAId, session_b_id: sessionBId }),
					)
				: invalid("session id"),
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_ADD_BREAKPOINT,
		(_e, sessionId: unknown, breakpoint: unknown) => {
			const body = breakpointBody(breakpoint);
			if (!isReplayId(sessionId)) return invalid("session id");
			if (!body) return invalid("breakpoint");
			return backendFetch(`/replay/sessions/${sessionId}/breakpoints`, json(body));
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_REMOVE_BREAKPOINT,
		(_e, sessionId: unknown, breakpointId: unknown) =>
			isReplayId(sessionId) && isReplayId(breakpointId)
				? backendFetch(`/replay/sessions/${sessionId}/breakpoints/${breakpointId}`, {
						method: "DELETE",
					})
				: invalid("breakpoint id"),
	);

	ipcMain.handle(IPC_CHANNELS.SESSION_HISTORY_LIST, (_e, projectId: unknown) =>
		typeof projectId === "string" && projectId.length > 0 && projectId.length <= 256
			? backendFetch(`/api/sessions/${encodeURIComponent(projectId)}`)
			: invalid("project id"),
	);
}
