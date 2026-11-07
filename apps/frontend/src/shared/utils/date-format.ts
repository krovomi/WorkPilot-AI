/**
 * Dates written the way the app's language writes them.
 *
 * The app speaks English and French. A date follows the language chosen in
 * the app, not the operating system's region: French writes 02/11/2026 16:30,
 * English writes 11/2/2026, 4:30 PM. These helpers take the language
 * explicitly so they also work where i18n is not set up (main process,
 * tests); the renderer binds them to the current language in
 * `renderer/lib/date-format.ts`.
 */

/** Anything a date can arrive as: a Date, an ISO string, or epoch milliseconds. */
export type DateInput = Date | string | number | null | undefined;

/**
 * The locale that writes dates for an app language: French is fr-FR, English
 * (and an unknown or missing language) is en-US.
 */
export function dateLocale(language?: string | null): string {
	const base = (language ?? "").trim().toLowerCase().split(/[-_]/)[0];
	return base === "fr" ? "fr-FR" : "en-US";
}

/** The value as a valid Date, or null. */
export function toValidDate(value: DateInput): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** The calendar date (02/11/2026 or 11/2/2026), or "" when the value is not a date. */
export function formatDateIn(
	value: DateInput,
	language: string | null | undefined,
	options?: Intl.DateTimeFormatOptions,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleDateString(dateLocale(language), options) : "";
}

/** The date and the time, or "" when the value is not a date. */
export function formatDateTimeIn(
	value: DateInput,
	language: string | null | undefined,
	options?: Intl.DateTimeFormatOptions,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleString(dateLocale(language), options) : "";
}

/** The time of day (16:30 or 4:30 PM), or "" when the value is not a date. */
export function formatTimeIn(
	value: DateInput,
	language: string | null | undefined,
	options?: Intl.DateTimeFormatOptions,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleTimeString(dateLocale(language), options) : "";
}
