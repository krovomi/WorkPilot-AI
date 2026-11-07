/**
 * How old a stored credential is (plan of 29 October, S5). The main process
 * dates a key when its value changes, never when it is merely saved again:
 * a key stored before dating existed has no date, and is shown as such rather
 * than as "saved today".
 */

/** Past this age a stored API key is worth renewing. */
export const SECRET_RENEWAL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When each secret settings key got its current value (ISO 8601). */
export type SecretDates = Record<string, string>;

/** A date as settings.json or profiles.json hold it, or undefined when unusable. */
export function parseSecretDate(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

/** Whole days since `setAt`, or undefined when the date is unknown. */
export function secretAgeDays(
	setAt: unknown,
	now: number = Date.now(),
): number | undefined {
	const time = parseSecretDate(setAt);
	if (time === undefined) return undefined;
	return Math.max(0, Math.floor((now - time) / DAY_MS));
}

/** True only for a known age past the renewal threshold. */
export function secretNeedsRenewal(ageDays: number | undefined): boolean {
	return ageDays !== undefined && ageDays >= SECRET_RENEWAL_DAYS;
}

/**
 * The dates to store with `next`: a secret keeps its date while its value is
 * the one `previous` held, gets `now` when the value changes, and loses its
 * date when it is emptied. A secret whose value did not change and that had no
 * date stays undated.
 */
export function stampSecretDates(
	next: Record<string, unknown>,
	previous: Record<string, unknown> | undefined,
	previousDates: unknown,
	isSecretKey: (key: string) => boolean,
	now: Date = new Date(),
): SecretDates {
	const known =
		typeof previousDates === "object" &&
		previousDates !== null &&
		!Array.isArray(previousDates)
			? (previousDates as Record<string, unknown>)
			: {};
	const dates: SecretDates = {};
	for (const [key, value] of Object.entries(next)) {
		if (!isSecretKey(key) || typeof value !== "string" || value === "") {
			continue;
		}
		if (previous?.[key] !== value) {
			dates[key] = now.toISOString();
			continue;
		}
		const kept = known[key];
		if (typeof kept === "string" && parseSecretDate(kept) !== undefined) {
			dates[key] = kept;
		}
	}
	return dates;
}
