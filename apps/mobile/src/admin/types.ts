/** The administration routes' shapes (`server/schemas.py`, `server/routers/admin/`). */

export interface OrgMember {
	user_id: string;
	email: string;
	display_name: string;
	role_id: string;
	role_slug: string;
	role_name: string;
	is_active: boolean;
	created_at: string;
}

export interface Role {
	id: string;
	org_id: string | null;
	slug: string;
	name: string;
	description: string;
	is_system: boolean;
	/** "org" for an organization-wide role, "project" for a project one. */
	scope: string;
	permissions: string[];
}

export interface Permission {
	key: string;
	domain: string;
	action: string;
	privileged: boolean;
}

export interface Invitation {
	id: string;
	email: string;
	role: string;
	project_id: string | null;
	project_role: string | null;
	expires_at: string;
	created_at: string;
}

export interface CreatedInvitation extends Invitation {
	/** The one-time acceptance link, returned once, to share by hand when no email went out. */
	invite_link: string;
	email_sent: boolean;
}

export interface Group {
	id: string;
	name: string;
	description: string;
	role_slug: string | null;
	role_name: string | null;
	members: { user_id: string; email: string; display_name: string }[];
	projects: { project_id: string; name: string; role: string }[];
	created_at: string;
}

export const PROJECT_ROLES = ["owner", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The organization's ceilings and their live use (`QuotaPublic`); a null limit is unlimited. */
export interface Quota {
	org_id: string;
	max_users: number | null;
	max_projects: number | null;
	max_concurrent_runs: number | null;
	monthly_token_budget: number | null;
	enforce_hard_stop: boolean;
	used_users: number;
	used_projects: number;
	used_concurrent_runs: number;
	used_tokens_this_month: number;
}

export const QUOTA_LIMITS = [
	{ limit: "max_users", used: "used_users" },
	{ limit: "max_projects", used: "used_projects" },
	{ limit: "max_concurrent_runs", used: "used_concurrent_runs" },
	{ limit: "monthly_token_budget", used: "used_tokens_this_month" },
] as const;

export type QuotaLimit = (typeof QUOTA_LIMITS)[number]["limit"];

/** What a save sends: a limit left out stays, a null one is lifted. */
export type QuotaChanges = Partial<Record<QuotaLimit, number | null>> & { enforce_hard_stop?: boolean };

/** The control dashboard of the organization (`AdminOverviewResponse`). */
export interface AdminOverview {
	org_id: string;
	org_name: string;
	users_total: number;
	users_active: number;
	projects_total: number;
	specs_total: number;
	runs_active: number;
	runs_queued: number;
	runs_24h: number;
	runs_failed_24h: number;
	run_success_rate_7d: number;
	quota: Quota;
	runs_by_day: { date: string; count: number }[];
	runs_by_status: Record<string, number>;
	top_users: { user_id: string; display_name: string; runs: number }[];
	recent_failures: { run_id: string; phase: string; error: string; finished_at: string }[];
}

/** One line of the organization's administrative history (`AuditEntryPublic`). */
export interface AuditEntry {
	id: string;
	user_id: string | null;
	user_email: string | null;
	project_id: string | null;
	action: string;
	payload: Record<string, unknown> | null;
	created_at: string;
	login_id: string | null;
	login_method: string | null;
}

/** A live sign-in of a member (`SessionPublic`). */
export interface MemberSession {
	id: string;
	user_id: string;
	user_email: string | null;
	user_agent: string | null;
	created_at: string;
	expires_at: string;
	login_method: string | null;
}

/** How a person signs in to the server (`jwt_tokens.LOGIN_METHODS`). */
export const LOGIN_METHODS = ["local", "entra", "oidc", "invite"] as const;
