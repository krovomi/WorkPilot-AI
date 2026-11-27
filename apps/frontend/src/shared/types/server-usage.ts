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
