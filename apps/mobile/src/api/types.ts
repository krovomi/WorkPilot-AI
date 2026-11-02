/**
 * What the WorkPilot server answers, as the phone app reads it. The shapes
 * mirror `apps/backend/server/schemas.py` and the board routes of
 * `apps/backend/shared_board/`; a field the app does not show is left out.
 */

import type { ColorThemeId, ThemeMode } from "../ui/theme-ids";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user: ServerUser;
}

export interface AuthConfig {
	local_enabled: boolean;
	entra_enabled: boolean;
	entra_tenant_id?: string | null;
	entra_client_id?: string | null;
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
	my_role?: string | null;
}

export interface MyPermissions {
	user_id: string;
	is_platform_admin: boolean;
	org_id: string | null;
	org_role: string | null;
	permissions: string[];
	organizations: Organization[];
}

export interface ServerProject {
	id: string;
	org_id?: string | null;
	name: string;
	repo_url: string;
	default_branch: string;
	my_role?: string | null;
	forge?: string | null;
}

/** The columns of the board, as `board_mcp.server.COLUMNS` maps a plan's status. */
export type Column =
	| "backlog"
	| "queue"
	| "in_progress"
	| "ai_review"
	| "human_review"
	| "build_failed"
	| "pr_created"
	| "done"
	| "error";

export type CardKind =
	| "feature"
	| "bug_fix"
	| "refactoring"
	| "investigation"
	| "docs"
	| "test";

/** One card of `GET /api/board/cards`. */
export interface BoardCard {
	id: string;
	title: string;
	column: Column;
	kind: CardKind | null;
	updatedAt: string | null;
	subtasks: { completed: number; total: number };
	reviewReason?: string;
	qa?: string;
	specId: string | null;
	claimedBy: string | null;
	claimedByName: string | null;
}

/** `GET /api/board/cards/{id}`. */
export interface CardDetails extends Omit<BoardCard, "specId" | "claimedBy" | "claimedByName"> {
	description: string;
	spec: string | null;
	/** The QA reviewer's report (`qa_report.md`), once QA has run. */
	qaReport?: string | null;
	approval: { approved: boolean; approvedBy: string | null; approvedAt: string | null };
	requireReview: boolean;
	/** Engine, priority, category and goal (`shared_board/settings.py`); absent on an older server. */
	settings?: CardSettings;
}

export interface CardSettings {
	engine: { provider: string; model?: string; thinkingLevel?: string; isAutoProfile?: boolean } | null;
	priority: string | null;
	category: string | null;
	goal: { command: string; expectedExit?: number; maxRounds?: number; maxCostUsd?: number } | null;
	goalError: string | null;
}

export type RunPhase = "spec" | "build" | "qa" | "merge" | "pr";

export interface AgentRun {
	id: string;
	spec_id: string;
	phase: RunPhase | string;
	started_by: string | null;
	model: string | null;
	status: string;
	started_at: string;
	finished_at: string | null;
	error: string | null;
}

export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	patch: string | null;
}

/** `GET /api/board/cards/{id}/changes`. */
export interface CardChanges {
	exists: boolean;
	branch?: string;
	baseBranch?: string;
	commitCount?: number;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
	files: ChangedFile[];
}

export type LogPhase = "planning" | "coding" | "validation";

export interface TaskLogEntry {
	timestamp: string;
	type: string;
	content: string;
	tool_name?: string;
}

export interface TaskPhaseLog {
	phase: LogPhase;
	status: "pending" | "active" | "completed" | "failed";
	started_at: string | null;
	completed_at: string | null;
	entries: TaskLogEntry[];
}

/** `GET /api/board/cards/{id}/logs`: the build log, bounded and masked by the server. */
export interface TaskLogs {
	spec_id?: string;
	updated_at?: string;
	truncated?: boolean;
	phases: Record<LogPhase, TaskPhaseLog>;
}

/**
 * `GET/PUT /users/me/preferences` (`server/routers/preferences.py`): the
 * person's theme for all their devices; `null` until they choose one.
 */
export interface UiPreferences {
	theme: ThemeMode | null;
	colorTheme: ColorThemeId | null;
}
