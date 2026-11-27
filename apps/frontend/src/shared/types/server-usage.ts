/** The organization's usage settings, as `GET /admin/usage/settings` answers. */
export interface UsageSettings {
	page_activity: boolean;
	/** When page activity was last turned on (ISO 8601). */
	page_activity_since: string | null;
	/** Null keeps the server's retention (`defaults`). */
	usage_retention_days: number | null;
	page_activity_retention_days: number | null;
	defaults: { usage_retention_days: number; page_activity_retention_days: number };
}

/** What `PUT /admin/usage/settings` takes. */
export interface UsageSettingsUpdate {
	page_activity: boolean;
	usage_retention_days: number | null;
	page_activity_retention_days: number | null;
}

export type UsageResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The views of `/admin/usage/*` the app reads (`main/server-usage-views.ts`). */
export type UsageView =
	| "summary"
	| "daily"
	| "people"
	| "models"
	| "projects"
	| "pages"
	| "delivery"
	| "presence";

/** The tables `/admin/usage/export` gives as CSV. */
export type UsageExport =
	| "daily"
	| "people"
	| "models"
	| "phases"
	| "projects"
	| "pages"
	| "failures";

/** A period (UTC days, `YYYY-MM-DD`, both included) and filters. */
export interface UsageQuery {
	start?: string;
	end?: string;
	user_id?: string;
	group_id?: string;
	project_id?: string;
	provider?: string;
	model?: string;
	/** The whole platform (its administrators only) instead of the organization. */
	platform?: boolean;
}

export interface UsageEnded {
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	success_rate: number | null;
}

export interface UsageSummary {
	start: string;
	end: string;
	tokens: { input: number; output: number; cache_write: number; cache_read: number; total: number };
	cost_usd: number;
	sessions: number;
	estimated: boolean;
	budget: { monthly_token_budget: number | null; used_this_month: number; percent: number | null } | null;
	active: { day: number; week: number; month: number };
	runs: UsageEnded;
	jobs: UsageEnded;
}

export interface UsageDailyRow {
	day: string;
	provider: string;
	tokens: number;
	cost_usd: number;
}

export interface UsagePersonRow {
	user_id: string | null;
	name: string | null;
	email: string | null;
	runs: number;
	jobs: number;
	tokens: number;
	cost_usd: number;
	providers: string[];
	models: string[];
	last_seen_at: string | null;
}

export interface UsageEngineFigures {
	sessions: number;
	tokens: number;
	cost_usd: number;
	runs: number;
	succeeded: number;
	failed: number;
	success_rate: number | null;
	cost_per_run_usd: number | null;
}

export interface UsageModels {
	models: Array<UsageEngineFigures & { provider: string; model: string }>;
	phases: Array<UsageEngineFigures & { provider: string; model: string; phase: string }>;
}

export interface UsageProjectRow {
	project_id: string | null;
	name: string | null;
	tokens: number;
	cost_usd: number;
	runs: number;
	phases: Array<{ phase: string; tokens: number; cost_usd: number }>;
}

export interface UsagePages {
	/** Whether the organization counts pages; null for the platform. */
	enabled: boolean | null;
	pages: Array<{ client: string; page: string; opens: number; people: number }>;
}

export interface UsageDelivery {
	funnel: {
		invited: number;
		accepted: number;
		first_sign_in: number;
		first_task: number;
		first_merge: number;
	};
	delivered: {
		tasks: number;
		cost_usd: number;
		cost_per_task_usd: number | null;
		median_hours_to_merge: number | null;
	};
	failures: Array<{ cause: string; runs: number; jobs: number }>;
}

export interface UsagePresence {
	online: Array<{ user_id: string | null; name: string | null; last_seen_at: string }>;
	running: Array<{
		kind: "run" | "job";
		what: string;
		started_at: string;
		project: string | null;
		user_id: string | null;
		name: string | null;
	}>;
	dormant: Array<{
		user_id: string | null;
		name: string | null;
		email: string | null;
		last_seen_at: string | null;
	}>;
	dormant_after_days: number;
}

export interface UsageEvent {
	at: string;
	kind: "sign_in" | "audit" | "run" | "job";
	what: string;
	status?: string;
	project?: string | null;
	provider?: string | null;
	model?: string | null;
}

/** One person's sheet: what administrators see of them. */
export interface UsagePersonSheet {
	user: { user_id: string; name: string | null; email: string | null };
	summary: UsageSummary;
	daily: UsageDailyRow[];
	timeline: UsageEvent[];
	pages: UsagePages;
}

/** `GET /users/me/usage`: the person's own sheet, and who reads it. */
export interface MyUsage extends UsagePersonSheet {
	visible_to: string[];
}

/** `GET /users/me/usage-notice`: what is measured, and whether to say it. */
export interface UsageNotice {
	due: boolean;
	measured: string[];
	page_activity: boolean;
	usage_retention_days: number;
	page_activity_retention_days: number;
	visible_to: string[];
}
