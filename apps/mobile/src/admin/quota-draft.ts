/** The quota form's text, and what a save sends from it. */

import { QUOTA_LIMITS, type Quota, type QuotaChanges, type QuotaLimit } from "./types";

export type QuotaDraft = Record<QuotaLimit, string>;

export function draftOf(quota: Quota): QuotaDraft {
	return Object.fromEntries(QUOTA_LIMITS.map(({ limit }) => [limit, quota[limit]?.toString() ?? ""])) as QuotaDraft;
}

/** The highest limit the form takes, far above any real ceiling and within a 64-bit integer. */
export const MAX_QUOTA = 1_000_000_000_000;

/**
 * What changed against the server's quota: an empty field lifts the limit
 * (null), a whole number sets it, anything else makes the draft invalid
 * (`null` result). Unchanged limits are left out.
 */
export function quotaChanges(quota: Quota, draft: QuotaDraft, hardStop: boolean): QuotaChanges | null {
	const changes: QuotaChanges = {};
	for (const { limit } of QUOTA_LIMITS) {
		const raw = draft[limit].trim();
		if (raw !== "" && !/^\d+$/.test(raw)) return null;
		const value = raw === "" ? null : Number(raw);
		if (value !== null && value > MAX_QUOTA) return null;
		if (value !== quota[limit]) changes[limit] = value;
	}
	if (hardStop !== quota.enforce_hard_stop) changes.enforce_hard_stop = hardStop;
	return changes;
}
