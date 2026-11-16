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

export interface ReplayBookmark {
	id: string;
	step_index: number;
	/** Markdown, shown as text. */
	note: string;
	author: string;
	created_at: number;
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
