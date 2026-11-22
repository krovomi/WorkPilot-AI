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
	/** The server's OpenID Connect provider (`auth/sso.ts` checks every field again). */
	sso_enabled?: boolean;
	sso_name?: string;
	sso_client_id?: unknown;
	sso_scopes?: unknown;
	sso_authorization_endpoint?: unknown;
	sso_token_endpoint?: unknown;
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
	/** A part of a task split into small PRs (`task_split`): its group. */
	group?: { id: string; title: string; index: number; total: number };
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

export type Criticality = "low" | "medium" | "high";
export const CRITICALITIES: readonly Criticality[] = ["low", "medium", "high"];

/** `GET /api/board/cards/{id}/approvals`: where a card's approval stands (`shared_board/approvals.py`). */
export interface CardApproval {
	criticality: Criticality;
	criticalitySource: "set" | "assessed" | "default";
	needed: number;
	count: number;
	roles: string[];
	missingRoles: string[];
	approvals: { by: string; for: string | null; at: string; roles: string[] }[];
	complete: boolean;
	/** The build may start. */
	approved: boolean;
}

/** `POST /api/board/cards/{id}/approve`: the build may start only once `approved`. */
export interface ApproveResult {
	approved: boolean;
	approvedBy: string | null;
	approval?: Pick<CardApproval, "count" | "needed">;
}

/** An approval lent on a project (`/api/board/delegations`). */
export interface Delegation {
	id: string;
	from: { id: string; name: string };
	to: { id: string; name: string };
	startsAt: string;
	endsAt: string;
	active: boolean;
}

/** `GET /projects/{id}/members`. */
export interface ProjectMember {
	user_id: string;
	email: string;
	display_name: string;
	role: string;
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
/** A message sent to a card's running task (`foundation/steering.py`). */
export interface SteeringMessage {
	id: string;
	text: string;
	createdAt: string;
	source: string;
	targetSubtaskId: string | null;
	/** Written by WorkPilot once a session received it. */
	deliveredAt: string | null;
	deliveredSession: number | null;
	deliveredSubtaskId: string | null;
}

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

/** A decision of the policy audit trail (`security/policy_audit.py`). */
export type PolicyDecision =
	| "deny"
	| "review"
	| "approved"
	| "warn"
	| "outside_hours"
	| "budget_exceeded"
	| "invalid_policy"
	| "tool_loop";

export interface PolicyEvent {
	id?: string;
	at?: string;
	task?: string | null;
	tool?: string | null;
	target?: string | null;
	decision: PolicyDecision;
	rules?: string[];
	/** Who approved the call: a name, the server's id and roles, for an `approved` decision. */
	approvedBy?: string | null;
}

/** A call an agent waits on until someone approves or refuses it. */
export interface GovernanceRequest {
	id: string;
	at?: string;
	rules?: string[];
	tool?: string | null;
	target?: { kind?: string | null; summary?: string | null };
	task?: string | null;
}

/**
 * `GET /api/features/governance` (`shared_features/governance.py`): what the
 * project's `workpilot.policy.yaml` says, read by the server from its clone,
 * the calls its agents wait on, its agents, and what this person may do.
 */
export interface GovernanceReport {
	governance: {
		schedule: { timezone: string; allowedHours: string[]; days: string[]; openNow: boolean } | null;
		files: { forbidden: string[]; requiresReview: string[]; reviewers?: string[] };
		budget: { maxTokensPerHour?: number | null; maxTokensPerTask?: number | null } | null;
		loopDetection?: { maxSameToolCall: number } | null;
	} | null;
	errors?: string[];
	tokensLastHour?: number;
	events?: PolicyEvent[];
	metrics?: { blocked24h?: number; breakerTrips7d?: number };
	pending?: GovernanceRequest[];
	agents: { mine: number; project: number };
	may: { approve: boolean; stop: boolean; stopProject: boolean; export: boolean };
}

/** A wave of `GET /api/features/execution-waves/plan`: cards that may run side by side, in merge order. */
export interface ExecutionWave {
	index: number;
	taskIds: string[];
	residualRisk: number;
}

/**
 * `GET /api/features/execution-waves/plan` (`shared_features/execution_waves.py`):
 * the waves of the project's backlog, computed by the server from its clone, the
 * same way as the desktop. Only what the phone shows is typed.
 */
export interface ExecutionWavePlan {
	maxParallel: number;
	waves: ExecutionWave[];
	tasks: { taskId: string; title: string; planned: boolean }[];
	cycles: string[][];
	excluded: { taskId: string; reason: "cycle" | "blocked_by_cycle" }[];
	totalRisk: number;
	residualRisk: number;
	mergeChecks: { checked: number; conflicts: number };
}

/** Why the run did not start a card (a closed list the server keeps). */
export type WaveStartFailure = "needs_approval" | "claimed" | "already_running" | "quota" | "refused" | "missing";

/** The run of "Execute in optimal order", as the server keeps it in the clone. */
export interface WaveRun {
	waves: string[][];
	current: number;
	advanceWhen: "merged" | "review";
	maxParallel: number;
	started: string[];
	failures: Record<string, WaveStartFailure>;
	savedAt: string;
}

/** `GET`, `POST .../run`, `POST .../run/step`: the run, each of its cards' column, and what waits. */
export interface WaveRunAnswer {
	run: WaveRun | null;
	cards?: { id: string; title: string; column: string | null; running: boolean }[];
	blocked?: string[];
	ended: "done" | "stopped" | null;
	ignored: boolean;
}

/** `GET .../history`: the last 14 days of runs, counted, never estimated. */
export interface WaveHistory {
	ignored: boolean;
	summary: {
		days: number;
		runs: number;
		stopped: number;
		conflictsAvoided: number;
		riskAvoided: number;
		started: number;
		lastFinishedAt: string | null;
	};
}
