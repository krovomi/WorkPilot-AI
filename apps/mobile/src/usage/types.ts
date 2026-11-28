/**
 * What the server answers about a person's own usage (`/users/me/usage`,
 * `/users/me/usage-notice`, `server/routers/usage_self.py`), as the desktop
 * reads it (`apps/frontend/src/shared/types/server-usage.ts`).
 */

export interface UsageEnded {
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	success_rate: number | null;
}

export interface UsageEvent {
	at: string;
	kind: "sign_in" | "audit" | "run" | "job";
	what: string;
	status?: string;
	project?: string | null;
	model?: string | null;
}

export interface MyUsage {
	user: { user_id: string; name: string | null; email: string | null };
	summary: {
		start: string;
		end: string;
		tokens: { input: number; output: number; total: number };
		cost_usd: number;
		sessions: number;
		estimated: boolean;
		runs: UsageEnded;
		jobs: UsageEnded;
	};
	daily: Array<{ day: string; provider: string; tokens: number; cost_usd: number }>;
	timeline: UsageEvent[];
	pages: { enabled: boolean | null; pages: Array<{ client: string; page: string; opens: number }> };
	visible_to: string[];
}

export interface UsageNotice {
	due: boolean;
	measured: string[];
	page_activity: boolean;
	usage_retention_days: number;
	page_activity_retention_days: number;
	visible_to: string[];
}
