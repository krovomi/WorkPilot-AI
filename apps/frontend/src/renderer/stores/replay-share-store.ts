/**
 * Sharing a recorded agent session (#347): export, import, bookmarks, a
 * video of the replay and a model's summary of its steps.
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
	ReplayBookmarkReply,
	ReplayBookmarkReplyRequest,
	ReplayBookmarkRequest,
	ReplayExportOptions,
	ReplayVideoOptions,
	ReplayVideoResult,
} from "../../shared/types/replay-share";
import { useAgentReplayStore } from "./agent-replay-store";

/** Error codes the backend and main answer with, each with its own text. */
const KNOWN_ERRORS = new Set([
	"too_large",
	"unreadable",
	"not_a_bundle",
	"unsupported_version",
	"not_a_file",
	"bad_export",
	"bad_target",
	"video_busy",
	"video_timeout",
	"video_too_large",
	"video_failed",
	"recording",
	"has_thinking",
	"no_steps",
	"summary_failed",
	"summary_empty",
	"empty_reply",
	"too_many_replies",
	// Team links (#347): main's and the server's refusals.
	"not_a_link",
	"not_signed_in",
	"other_server",
	"not_a_server_project",
	"too_large_to_share",
	"bad_share",
	"share_not_found",
	"share_expired",
	"share_revoked",
	"too_many_shares",
]);

const appLanguage = (): "en" | "fr" =>
	i18n.language?.startsWith("fr") ? "fr" : "en";

export interface ReplayShareNotice {
	/** `info`: nothing went wrong, the machine lacks what the action needs. */
	tone: "ok" | "error" | "info";
	key: string;
	values?: Record<string, string>;
}

interface ReplayShareState {
	exporting: boolean;
	importing: boolean;
	savingBookmark: boolean;
	recordingVideo: boolean;
	summarizing: boolean;
	notice: ReplayShareNotice | null;
	exportSession: (
		sessionId: string,
		options: Omit<ReplayExportOptions, "language">,
	) => Promise<void>;
	importSession: () => Promise<void>;
	addBookmark: (sessionId: string, request: ReplayBookmarkRequest) => Promise<boolean>;
	removeBookmark: (sessionId: string, bookmarkId: string) => Promise<void>;
	/** Answers a bookmark; the reply lands under it on the open session. */
	addReply: (
		sessionId: string,
		bookmarkId: string,
		request: ReplayBookmarkReplyRequest,
	) => Promise<boolean>;
	removeReply: (sessionId: string, bookmarkId: string, replyId: string) => Promise<void>;
	exportVideo: (
		sessionId: string,
		options: Omit<ReplayVideoOptions, "language">,
	) => Promise<void>;
	/** Two sessions side by side, as one video. */
	exportComparisonVideo: (
		sessionAId: string,
		sessionBId: string,
		options: Omit<ReplayVideoOptions, "language">,
	) => Promise<void>;
	/** Asks `provider`'s fast model; the summary lands on the open session. */
	summarize: (sessionId: string, provider: string) => Promise<void>;
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

function withReplies(
	sessionId: string,
	bookmarkId: string,
	change: (replies: ReplayBookmarkReply[]) => ReplayBookmarkReply[],
): void {
	withBookmarks(sessionId, (marks) =>
		marks.map((mark) =>
			mark.id === bookmarkId ? { ...mark, replies: change(mark.replies ?? []) } : mark,
		),
	);
}

/** What a recording came to, for the notice; null when the person canceled. */
function videoNotice(result: ReplayVideoResult): ReplayShareNotice | null {
	if (!result.success) return failure(result);
	if (result.canceled) return null;
	if ("refused" in result) {
		return { tone: "info", key: `replay:share.video.refused.${result.refused}` };
	}
	return {
		tone: "ok",
		key:
			result.stepsPlayed < result.stepsTotal
				? "replay:share.video.savedPart"
				: "replay:share.video.saved",
		values: {
			path: result.filePath,
			played: String(result.stepsPlayed),
			total: String(result.stepsTotal),
		},
	};
}

const byStep = (a: ReplayBookmark, b: ReplayBookmark) =>
	a.step_index - b.step_index || a.created_at - b.created_at;

export const useReplayShareStore = create<ReplayShareState>((set) => ({
	exporting: false,
	importing: false,
	savingBookmark: false,
	recordingVideo: false,
	summarizing: false,
	notice: null,

	exportSession: async (sessionId, options) => {
		set({ exporting: true, notice: null });
		const result = await window.electronAPI.exportReplaySession(sessionId, {
			...options,
			language: appLanguage(),
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

	addReply: async (sessionId, bookmarkId, request) => {
		set({ savingBookmark: true, notice: null });
		const result = await window.electronAPI.addReplayBookmarkReply(
			sessionId,
			bookmarkId,
			request,
		);
		if (!result.success) {
			set({ savingBookmark: false, notice: failure(result) });
			return false;
		}
		withReplies(sessionId, bookmarkId, (replies) => [...replies, result.reply]);
		set({ savingBookmark: false });
		return true;
	},

	removeReply: async (sessionId, bookmarkId, replyId) => {
		const result = await window.electronAPI.removeReplayBookmarkReply(
			sessionId,
			bookmarkId,
			replyId,
		);
		if (!result.success) {
			set({ notice: failure(result) });
			return;
		}
		withReplies(sessionId, bookmarkId, (replies) => replies.filter((r) => r.id !== replyId));
	},

	exportVideo: async (sessionId, options) => {
		set({ recordingVideo: true, notice: null });
		const result = await window.electronAPI.exportReplayVideo(sessionId, {
			...options,
			language: appLanguage(),
		});
		set({ recordingVideo: false, notice: videoNotice(result) });
	},

	exportComparisonVideo: async (sessionAId, sessionBId, options) => {
		set({ recordingVideo: true, notice: null });
		const result = await window.electronAPI.exportReplayComparisonVideo(
			sessionAId,
			sessionBId,
			{ ...options, language: appLanguage() },
		);
		set({ recordingVideo: false, notice: videoNotice(result) });
	},

	summarize: async (sessionId, provider) => {
		set({ summarizing: true, notice: null });
		const result = await window.electronAPI.summarizeReplaySession(sessionId, {
			provider: provider.trim().toLowerCase(),
			language: appLanguage(),
		});
		if (!result.success) {
			set({ summarizing: false, notice: failure(result) });
			return;
		}
		useAgentReplayStore.setState((state) => {
			const session = state.activeSession;
			if (!session || session.session_id !== sessionId) return {};
			return { activeSession: { ...session, summary: result.summary } };
		});
		set({ summarizing: false });
	},

	clearNotice: () => set({ notice: null }),
}));
