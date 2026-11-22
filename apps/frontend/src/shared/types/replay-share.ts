/**
 * Sharing a recorded agent session (#347): what the renderer asks main for,
 * and what main answers. The backend masks and builds the file
 * (`apps/backend/replay/bundle.py`, `viewer.py`); main only asks where to
 * write it, or which file to read.
 */

/** `.wpreplay` (to import elsewhere) or a page anyone can open. */
export type ReplayExportFormat = "wpreplay" | "html";

export interface ReplayExportOptions {
	format: ReplayExportFormat;
	stripReasoning: boolean;
	stripTokens: boolean;
	includeFileContents: boolean;
	language: "en" | "fr";
}

/** A video of the page, played step by step (#347). */
export interface ReplayVideoOptions {
	stripReasoning: boolean;
	stripTokens: boolean;
	language: "en" | "fr";
	/** WebM by default; MP4 is encoded again by the machine's ffmpeg. */
	format?: ReplayVideoFormat;
}

export type ReplayVideoFormat = "webm" | "mp4";

/** What this machine lacks to record a video: an answer, not an error. */
export type ReplayVideoRefusal =
	| "no_playwright"
	| "no_browser"
	| "no_encoder"
	| "no_mp4_encoder";

export type ReplayVideoResult =
	| { success: true; canceled: true }
	| {
			success: true;
			canceled?: false;
			filePath: string;
			stepsPlayed: number;
			stepsTotal: number;
	  }
	| { success: true; canceled?: false; refused: ReplayVideoRefusal }
	| { success: false; error: string; unreachable?: true };

/** A model's account of the steps of a session without a thinking trace. */
export interface ReplaySummary {
	text: string;
	provider: string;
	model: string;
	language: string;
	created_at: number;
}

export interface ReplaySummaryRequest {
	/** The provider the person chose; the backend takes its fast model. */
	provider: string;
	language: "en" | "fr";
}

/** An answer to a bookmark's note: bookmarks are discussed this way. */
export interface ReplayBookmarkReply {
	id: string;
	/** Markdown, shown as text. */
	note: string;
	author: string;
	created_at: number;
}

export interface ReplayBookmark {
	id: string;
	step_index: number;
	/** Markdown, shown as text. */
	note: string;
	author: string;
	created_at: number;
	/** Absent in a session saved before replies existed. */
	replies?: ReplayBookmarkReply[];
}

export interface ReplayBookmarkReplyRequest {
	note: string;
	author?: string;
}

export interface ReplayBookmarkRequest {
	stepIndex: number;
	note: string;
	author?: string;
}

/** Written, or the person closed the dialog. */
export type ReplayFileResult =
	| { success: true; canceled: true }
	| { success: true; canceled?: false; filePath: string }
	| { success: false; error: string; unreachable?: true };

export type ReplayImportResult =
	| { success: true; canceled: true }
	| {
			success: true;
			canceled?: false;
			session: { session_id: string; agent_name: string };
	  }
	| { success: false; error: string; unreachable?: true };

/** How long a team link lasts, in days (the server allows 1 to 30). */
export const REPLAY_SHARE_TTL_DAYS = [1, 7, 30] as const;

/** A session left with a server project's team, as its list shows it (#347). */
export interface ReplayTeamShare {
	id: string;
	title: string;
	steps: number;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	state: "active" | "expired" | "revoked";
	openCount: number;
	lastOpenedAt?: string;
	canRevoke: boolean;
}

export interface ReplayTeamShareRequest {
	/** A server project the app listed, where the person is a member. */
	projectId: string;
	ttlDays: number;
	stripReasoning: boolean;
	stripTokens: boolean;
	includeFileContents: boolean;
}

/** The link holds its token: the server never shows it again. */
export type ReplayTeamShareResult =
	| { success: true; link: string; share: ReplayTeamShare }
	| { success: false; error: string; unreachable?: true };

export type ReplayTeamShareListResult =
	| { success: true; shares: ReplayTeamShare[] }
	| { success: false; error: string; unreachable?: true };

/** A team link of the person, on one of the server's projects (Settings). */
export interface ReplayMyTeamShare extends ReplayTeamShare {
	projectId: string;
	projectName: string;
}

export type ReplayMyTeamShareListResult =
	| { success: true; shares: ReplayMyTeamShare[] }
	| { success: false; error: string; unreachable?: true };

/** What the app counts as one export of a replay. */
export const REPLAY_EXPORT_KINDS = ["wpreplay", "html", "video", "team_link"] as const;
export type ReplayExportKind = (typeof REPLAY_EXPORT_KINDS)[number];

/**
 * How this machine shares its replays, counted on this machine and sent
 * nowhere (`apps/backend/replay/usage.py`): seven-day windows, oldest first.
 */
export interface ReplayUsage {
	weeks: { start: string; end: string; total: number; byKind: Record<ReplayExportKind, number> }[];
	exports: number;
	exportsPerWeek: number;
	sessions: {
		total: number;
		annotated: number;
		discussed: number;
		summarized: number;
		imported: number;
	};
	/** Sessions with a bookmark, over all sessions; null without a session. */
	annotatedRatio: number | null;
}

/**
 * A server project's team links over its last weeks, as aggregates only,
 * computed by that server (`shared_features/replay_share_overview.py`).
 */
export interface ReplayTeamUsage {
	windowDays: number;
	weeks: { start: string; end: string; created: number; opened: number }[];
	links: number;
	openedLinks: number;
	openRate: number | null;
	opens: number;
	active: number;
	annotated: number;
	annotatedRatio: number | null;
	sharers: number;
}

export type ReplayUsageResult =
	| { success: true; usage: ReplayUsage }
	| { success: false; error: string; unreachable?: true };

export type ReplayTeamUsageResult =
	| { success: true; usage: ReplayTeamUsage }
	| { success: false; error: string; unreachable?: true };
