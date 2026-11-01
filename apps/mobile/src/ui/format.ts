/** Small text helpers shared by the screens. */

/** The repository's "owner/name", from its URL. */
export function repoLabel(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	return parts.slice(-2).join("/") || repoUrl;
}

/** A date as the device's locale writes it, or an empty string. */
export function formatDate(iso: string | null | undefined, locale: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}
