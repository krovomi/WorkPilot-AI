/**
 * Parse acceptance criteria coming from external trackers into the
 * `string[]` shape stored in `TaskMetadata.acceptanceCriteria`.
 *
 * Azure DevOps returns rich-text HTML; Jira returns either plain text or
 * Atlassian Document Format already flattened upstream. We strip block
 * tags into newlines, decode entities, drop leading bullet markers, and
 * return one trimmed criterion per non-empty line.
 */
export function parseAcceptanceCriteriaText(raw: string | undefined): string[] {
	if (!raw) return [];

	let text = raw
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/(?:li|p|div|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "");

	text = text
		.replaceAll("&nbsp;", " ")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");

	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*•\d.)\]]+\s*/, "").trim())
		.filter((line) => line.length > 0);
}

/**
 * Format an acceptance criteria list as a Markdown section appendable to
 * a task description. Returns an empty string if the list is empty so
 * callers can concatenate unconditionally.
 */
export function formatAcceptanceCriteriaMarkdown(criteria: string[]): string {
	if (!criteria || criteria.length === 0) return "";
	const lines = ["", "## Acceptance Criteria", ""];
	for (const criterion of criteria) {
		lines.push(`- ${criterion}`);
	}
	return lines.join("\n");
}
