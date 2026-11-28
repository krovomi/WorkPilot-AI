/**
 * The Usage tab's period presets and number formats.
 *
 * A period is a pair of UTC days (`YYYY-MM-DD`, both included), as the
 * server reads them. Numbers follow the app's language, like its dates.
 */
import { appDateLocale, formatAppDate } from "@/lib/date-format";

export type PeriodPreset = "7d" | "30d" | "month" | "custom";

export interface Period {
	start: string;
	end: string;
}

function day(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** The days a preset covers, ending today (UTC). */
export function periodOf(preset: Exclude<PeriodPreset, "custom">, now = new Date()): Period {
	const end = day(now);
	if (preset === "month") return { start: `${end.slice(0, 8)}01`, end };
	const days = preset === "7d" ? 7 : 30;
	const start = new Date(now.getTime() - (days - 1) * 86_400_000);
	return { start: day(start), end };
}

/**
 * A server day (`YYYY-MM-DD`) in the app's language. Read as UTC, as the
 * server writes it, so a time zone west of UTC does not show the day before.
 */
export function formatDay(day: string, options?: Intl.DateTimeFormatOptions): string {
	return formatAppDate(day, { timeZone: "UTC", ...options });
}

export function formatCount(value: number): string {
	return new Intl.NumberFormat(appDateLocale()).format(value);
}

/** Tokens in short form: 1 234 567 → 1,2 M. */
export function formatTokens(value: number): string {
	return new Intl.NumberFormat(appDateLocale(), {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

export function formatUsd(value: number): string {
	return new Intl.NumberFormat(appDateLocale(), {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: value >= 100 ? 0 : 2,
	}).format(value);
}

/** A share (0..1) as a percent, or a dash before any run ended. */
export function formatRate(value: number | null): string {
	if (value === null) return "–";
	return new Intl.NumberFormat(appDateLocale(), {
		style: "percent",
		maximumFractionDigits: 0,
	}).format(value);
}

/** Save text the server gave as a file the person downloads. */
export function download(text: string, name: string, type: string): void {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	URL.revokeObjectURL(url);
}
