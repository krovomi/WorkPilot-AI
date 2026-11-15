/**
 * Sharing a recorded agent session (#347): export, import, bookmarks.
 *
 * Main does the work (`main/ipc-handlers/replay-share-handlers.ts`); this
 * store only keeps what is running and the last outcome, as an i18n key. A
 * bookmark that is saved is put on the open session of the replay store, so
 * the view shows it without reading the session again.
 */

import i18n from "i18next";
import { create } from "zustand";
import type {
	ReplayBookmark,
	ReplayBookmarkRequest,
	ReplayExportOptions,
} from "../../shared/types/replay-share";
import { useAgentReplayStore } from "./agent-replay-store";

/** Error codes the backend and main answer with, each with its own text. */
const KNOWN_ERRORS = new Set([
	"too_large",
	"unreadable",
	"not_a_bundle",
	"unsupported_version",
	"not_a_file",
]);

export interface ReplayShareNotice {
	tone: "ok" | "error";
	key: string;
	values?: Record<string, string>;
}

interface ReplayShareState {
	exporting: boolean;
	importing: boolean;
	savingBookmark: boolean;
	notice: ReplayShareNotice | null;
	exportSession: (
		sessionId: string,
		options: Omit<ReplayExportOptions, "language">,
	) => Promise<void>;
	importSession: () => Promise<void>;
	addBookmark: (sessionId: string, request: ReplayBookmarkRequest) => Promise<boolean>;
	removeBookmark: (sessionId: string, bookmarkId: string) => Promise<void>;
	clearNotice: () => void;
}

/** The `detail` of a FastAPI refusal, or the error itself. */
export function errorDetail(error: string): string {
	try {
		const parsed = JSON.parse(error) as { detail?: unknown };
		return typeof parsed.detail === "string" ? parsed.detail : error;
	} catch {
		return error;
	}
}

export function failure(
	result: { error: string; unreachable?: true },
): ReplayShareNotice {
	if (result.unreachable) {
		return { tone: "error", key: "replay:errors.backendUnreachable" };
	}
	const detail = errorDetail(result.error);
	return KNOWN_ERRORS.has(detail)
		? { tone: "error", key: `replay:share.errors.${detail}` }
		: { tone: "error", key: "replay:share.errors.generic", values: { error: detail } };
}

function withBookmarks(
	sessionId: string,
	change: (bookmarks: ReplayBookmark[]) => ReplayBookmark[],
): void {
	useAgentReplayStore.setState((state) => {
		const session = state.activeSession;
		if (!session || session.session_id !== sessionId) return {};
		return { activeSession: { ...session, bookmarks: change(session.bookmarks ?? []) } };
	});
}

const byStep = (a: ReplayBookmark, b: ReplayBookmark) =>
	a.step_index - b.step_index || a.created_at - b.created_at;

export const useReplayShareStore = create<ReplayShareState>((set) => ({
	exporting: false,
	importing: false,
	savingBookmark: false,
	notice: null,

	exportSession: async (sessionId, options) => {
		set({ exporting: true, notice: null });
		const language = i18n.language?.startsWith("fr") ? "fr" : "en";
		const result = await window.electronAPI.exportReplaySession(sessionId, {
			...options,
			language,
		});
		if (!result.success) set({ exporting: false, notice: failure(result) });
		else if (result.canceled) set({ exporting: false });
		else
			set({
				exporting: false,
				notice: {
					tone: "ok",
					key: "replay:share.exported",
					values: { path: result.filePath },
				},
			});
	},

	importSession: async () => {
		set({ importing: true, notice: null });
		const result = await window.electronAPI.importReplaySession();
		if (!result.success) {
			set({ importing: false, notice: failure(result) });
			return;
		}
		if (result.canceled) {
			set({ importing: false });
			return;
		}
		set({
			importing: false,
			notice: {
				tone: "ok",
				key: "replay:share.imported",
				values: { name: result.session.agent_name },
			},
		});
		await useAgentReplayStore.getState().fetchSessions();
	},

	addBookmark: async (sessionId, request) => {
		set({ savingBookmark: true, notice: null });
		const result = await window.electronAPI.addReplayBookmark(sessionId, request);
		if (!result.success) {
			set({ savingBookmark: false, notice: failure(result) });
			return false;
		}
		withBookmarks(sessionId, (marks) => [...marks, result.bookmark].sort(byStep));
		set({ savingBookmark: false });
		return true;
	},

	removeBookmark: async (sessionId, bookmarkId) => {
		const result = await window.electronAPI.removeReplayBookmark(sessionId, bookmarkId);
		if (!result.success) {
			set({ notice: failure(result) });
			return;
		}
		withBookmarks(sessionId, (marks) => marks.filter((b) => b.id !== bookmarkId));
	},

	clearNotice: () => set({ notice: null }),
}));
