import type { TFunction } from "i18next";

/** Small text helpers shared by the screens. */

/** The repository's "owner/name", from its URL. */
export function repoLabel(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	return parts.slice(-2).join("/") || repoUrl;
}

/**
 * The locale that writes dates for the app's language: French is fr-FR
 * (02/11/2026 16:30), English and anything else en-US (11/2/26, 4:30 PM),
 * whatever the phone's region. Same rule as the desktop.
 */
export function dateLocale(language: string | null | undefined): string {
	const base = (language ?? "").trim().toLowerCase().split(/[-_]/)[0];
	return base === "fr" ? "fr-FR" : "en-US";
}

/** A date and time written in the app's language, or an empty string. */
export function formatDate(iso: string | null | undefined, language: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(dateLocale(language), { dateStyle: "short", timeStyle: "short" });
}


/**
 * How long ago, in the app's language: "just now", "5 min ago", "3 h ago",
 * "2 d ago", then the date itself after a week. Empty without a date.
 */
export function timeAgo(iso: string | null | undefined, t: TFunction, language: string, now = Date.now()): string {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.max(0, Math.floor((now - then) / 60_000));
	if (minutes < 1) return t("time.now");
	if (minutes < 60) return t("time.minutes", { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("time.hours", { count: hours });
	const days = Math.floor(hours / 24);
	if (days < 7) return t("time.days", { count: days });
	return formatDate(iso, language);
}
