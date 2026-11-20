/**
 * A URL read from a file or a runner, as a link the app may render: an
 * http(s) URL in its parsed form, or null for anything else (another
 * protocol, or not a URL at all).
 */
export function webLink(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}
