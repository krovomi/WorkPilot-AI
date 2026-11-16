/**
 * What the Browser Agent view may hand to its runner.
 *
 * The main process checks the renderer's values before it starts
 * `browser_agent_runner.py` (docs/rules/security.md, S6): a page address is an
 * `http:` or `https:` URL, a screenshot or baseline name is one file-name token
 * in the charset the runner keeps (`browser_agent/_naming.py`). The view
 * reduces a name the person types to that charset first (`toArtifactName`),
 * so "login page" is still captured, as `login_page`.
 */

/** Longest page address the runner receives. */
export const RUNNER_URL_MAX = 2048;

/** Longest artifact name, as the runner's `sanitize_name` keeps it. */
export const ARTIFACT_NAME_MAX = 128;

const ARTIFACT_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** The URL as the runner receives it, or null when it is not an http(s) URL. */
export function readRunnerUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value || value.length > RUNNER_URL_MAX) {
		return null;
	}
	if (hasControlCharacter(value)) return null;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return parsed.href;
}

/** Whether `value` is a name the runner receives as it is. */
export function isArtifactName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= ARTIFACT_NAME_MAX &&
		ARTIFACT_NAME.test(value)
	);
}

/** A typed name reduced to the runner's charset; empty when nothing is left. */
export function toArtifactName(raw: string): string {
	return raw
		.trim()
		.replaceAll(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^[-._]+/, "")
		.replace(/[._]+$/, "")
		.slice(0, ARTIFACT_NAME_MAX);
}
