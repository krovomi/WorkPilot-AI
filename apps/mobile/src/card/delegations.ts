/** Lending one's approval from the phone: a number of days from now. */

/** The longest a delegation lasts, as the server allows it. */
export const MAX_DAYS = 90;

/** A whole number of days between 1 and {@link MAX_DAYS}, or null. */
export function parseDays(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d{1,3}$/.test(text)) return null;
	const days = Number(text);
	return days >= 1 && days <= MAX_DAYS ? days : null;
}

/** When a delegation of `days` days that starts now ends, in ISO 8601 (UTC). */
export function lendingEnd(days: number, now: Date = new Date()): string {
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
