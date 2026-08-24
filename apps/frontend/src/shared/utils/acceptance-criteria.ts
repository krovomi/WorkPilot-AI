// Entities we decode when reading text out of tracker HTML. `amp` lives in
// the same table as the rest because decoding happens in ONE pass (see
// `decodeHtmlEntities`) — a chained decode would turn "&amp;lt;" into "<".
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	nbsp: " ",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	// Accented / typographic characters AzDO emits in French headings.
	agrave: "à",
	ccedil: "ç",
	eacute: "é",
	egrave: "è",
	ecirc: "ê",
	icirc: "î",
	iuml: "ï",
	ocirc: "ô",
	ugrave: "ù",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	ndash: "–",
	mdash: "—",
	hellip: "…",
};

const HTML_ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;

function codePointOr(cp: number, fallback: string): string {
	// Reject out-of-range values instead of letting fromCodePoint throw.
	return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff
		? String.fromCodePoint(cp)
		: fallback;
}

/**
 * Decode the HTML entities that show up in tracker rich text.
 *
 * Single pass on purpose: decoding named and numeric entities in separate
 * passes lets the output of one become the input of the next, so "&amp;lt;"
 * would wrongly collapse to "<". Unknown entities are left verbatim.
 */
export function decodeHtmlEntities(input: string): string {
	return input.replace(HTML_ENTITY, (whole, hex, dec, name) => {
		if (hex !== undefined) return codePointOr(Number.parseInt(hex, 16), whole);
		if (dec !== undefined) return codePointOr(Number(dec), whole);
		const decoded = NAMED_ENTITIES[String(name).toLowerCase()];
		return decoded === undefined ? whole : decoded;
	});
}

/**
 * Strip HTML tags until the result stops changing.
 *
 * A single `replace(/<[^>]+>/g, "")` pass is incomplete: on "<<a>script>" it
 * removes the inner "<a>" and *creates* "<script>" out of the leftovers.
 * Iterating to a fixed point is what makes the removal total — this is the
 * defect CodeQL reports as `js/incomplete-multi-character-sanitization`.
 */
export function stripHtmlTags(input: string): string {
	let previous: string;
	let current = input;
	do {
		previous = current;
		current = current.replace(/<[^>]+>/g, "");
	} while (current !== previous);
	return current;
}

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

	const text = decodeHtmlEntities(
		stripHtmlTags(
			raw
				.replace(/<\s*br\s*\/?>/gi, "\n")
				.replace(/<\/(?:li|p|div|h[1-6]|tr)>/gi, "\n"),
		),
	);

	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*•\d.)\]]+\s*/, "").trim())
		.filter((line) => line.length > 0);
}

/**
 * Remove the "Acceptance Criteria" section from an HTML description.
 *
 * Azure DevOps work items often store the AC list inside the description
 * field (as an "<h2>Critères d'acceptation</h2>…" subsection) AND in the
 * dedicated `acceptance_criteria` field. WorkPilot already surfaces the
 * dedicated field in its own UI section, so leaving them in the description
 * is just a duplicate the user sees twice.
 *
 * This trims the description at the first heading whose text matches one of
 * the common AC labels (FR + EN + variants). If no such heading is present,
 * the description is returned unchanged so non-AC descriptions are not
 * affected.
 */
// Label strings that mark the start of an AC section in an HTML description.
// Matched case-insensitively against the inner text of any h1-h6.
const AC_HEADING_LABELS: readonly RegExp[] = [
	/acceptance\s+criteria/i,
	/crit[èe]res?\s+d['’]acc[eé]pt[ai][ot][ino]n?/i, // "critère/critères d'acceptation/acceptance"
	/cas\s+d['’]usage/i,
	/sc[ée]narios?/i,
];

// Matches any opening heading tag through its closing tag; we extract the
// inner text once and test the small labels above against it.
const HEADING_BLOCK = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;

/**
 * Remove the "Acceptance Criteria" section from an HTML description.
 *
 * Azure DevOps work items often store the AC list inside the description
 * field (as an "<h2>Critères d'acceptation</h2>…" subsection) AND in the
 * dedicated `acceptance_criteria` field. WorkPilot already surfaces the
 * dedicated field in its own UI section, so leaving them in the description
 * is just a duplicate the user sees twice.
 *
 * This trims the description at the first heading whose text matches one
 * of the common AC labels (FR + EN + variants). If no such heading is
 * present, the description is returned unchanged so non-AC descriptions
 * are not affected.
 */
export function stripAcceptanceCriteriaSection(html: string): string {
	if (!html) return html;

	// 1) HTML heading path (AzDO rich-text descriptions, Jira ADF→HTML).
	HEADING_BLOCK.lastIndex = 0;
	let match: RegExpExecArray | null = HEADING_BLOCK.exec(html);
	while (match !== null) {
		// No DOMParser here: this module is imported by the Electron MAIN
		// process (project-store.ts, azure-devops-handlers.ts), which is plain
		// Node — `DOMParser` is undefined there and the call throws at runtime.
		// The jsdom test env and `"lib": ["DOM"]` both hide that, so it has to
		// stay DOM-free by construction.
		const innerText = decodeHtmlEntities(stripHtmlTags(match[1]))
			.replace(/\s+/g, " ")
			.trim();
		if (AC_HEADING_LABELS.some((re) => re.test(innerText))) {
			return html.slice(0, match.index).trimEnd();
		}
		match = HEADING_BLOCK.exec(html);
	}

	// 2) Markdown heading path (descriptions already flattened to markdown,
	// or imports that concatenated "## Acceptance Criteria" manually).
	const lines = html.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const mdMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
		if (!mdMatch) continue;
		const heading = mdMatch[1].replace(/[*_`]+/g, "").trim();
		if (AC_HEADING_LABELS.some((re) => re.test(heading))) {
			return lines.slice(0, i).join("\n").trimEnd();
		}
	}

	return html;
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
