/**
 * Date formatting bound to the language chosen in the app.
 *
 * Every date the renderer shows goes through these helpers, so a French app
 * writes 02/11/2026 16:30 and an English app writes 11/2/2026, 4:30 PM,
 * whatever the operating system's region. A guard test forbids calling
 * `toLocaleDateString` / `toLocaleTimeString` / `Intl.DateTimeFormat` on
 * dates directly in the renderer.
 */
import i18n from "../../shared/i18n";
import {
	type DateInput,
	dateLocale,
	formatDateIn,
	formatDateTimeIn,
	formatTimeIn,
	toValidDate,
} from "../../shared/utils/date-format";

export type { DateInput };

/** The locale the app writes dates in right now (fr-FR or en-US). */
export function appDateLocale(): string {
	return dateLocale(i18n.language);
}

/** The calendar date in the app's language, or "". */
export function formatAppDate(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
): string {
	return formatDateIn(value, i18n.language, options);
}

/** The date and time in the app's language, or "". */
export function formatAppDateTime(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
): string {
	return formatDateTimeIn(value, i18n.language, options);
}

/** The time of day in the app's language, or "". */
export function formatAppTime(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
): string {
	return formatTimeIn(value, i18n.language, options);
}

/**
 * A YYYY-MM-DD day (a calendar day, not a moment) in the app's language:
 * 28/11/2026 or 11/28/2026, or what the options ask for. Anything that is not
 * such a day comes back as it was.
 */
export function formatAppDay(day: string, options?: Intl.DateTimeFormatOptions): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
	return formatAppDate(`${day}T00:00:00`, options) || day;
}

/**
 * A YYYY-MM month in the app's language: "novembre 2026" / "November 2026",
 * or "nov. 2026" / "Nov 2026" when short. Anything else comes back as it was.
 */
export function formatAppMonth(month: string, style: "long" | "short" = "long"): string {
	if (!/^\d{4}-\d{2}$/.test(month)) return month;
	return formatAppDate(`${month}-01T00:00:00`, { month: style, year: "numeric" }) || month;
}

/**
 * A YYYY-MM-DD day as "Today", "Yesterday" or a short date ("2 nov." /
 * "Nov 2") in the app's language.
 */
export function formatAppDayLabel(day: string, now: Date = new Date()): string {
	const date = toValidDate(`${day}T00:00:00`);
	if (!date) return day;
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const diffDays = Math.round(
		(startOfToday.getTime() - date.getTime()) / (24 * 60 * 60 * 1000),
	);
	if (diffDays === 0) return i18n.t("common:time.today");
	if (diffDays === 1) return i18n.t("common:time.yesterday");
	return formatAppDate(date, { month: "short", day: "numeric" });
}
