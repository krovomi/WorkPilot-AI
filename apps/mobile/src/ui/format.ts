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
