import type { TaskLogEntry } from "../types";

/** The text fields of an entry a search looks at, in display order. */
function searchableFields(entry: TaskLogEntry): (string | undefined)[] {
	return [
		entry.content,
		entry.tool_name,
		entry.tool_input,
		entry.detail,
		entry.subphase,
	];
}

/**
 * True when a log entry matches the search query. Searches the human-visible
 * text fields: message content, tool name/input, expandable detail and the
 * subphase label. The comparison is case-insensitive; an empty query matches
 * everything.
 *
 * @param entry - The log entry to test.
 * @param query - The search query. May be any case; it is lower-cased
 *   internally, so callers can pass either a raw or an already-lower-cased
 *   string.
 */
export function entryMatchesQuery(entry: TaskLogEntry, query: string): boolean {
	const q = query.toLowerCase();
	if (!q) return true;
	return searchableFields(entry).some(
		(field) => field?.toLowerCase().includes(q) ?? false,
	);
}

// ---------------------------------------------------------------------------
// Search options (case, whole word, regular expression)
// ---------------------------------------------------------------------------

export interface LogSearchOptions {
	/** Raw text typed by the user; surrounding spaces are ignored. */
	query: string;
	/** Match the exact case ("Error" does not find "error"). */
	caseSensitive?: boolean;
	/** Match whole words only ("test" does not find "tests"). */
	wholeWord?: boolean;
	/** Read the query as a JavaScript regular expression. */
	regex?: boolean;
}

/** Tests text against a search, and locates its hits for highlighting. */
export interface LogMatcher {
	test(text: string): boolean;
	/** [start, end) offsets of every non-empty hit, in order. */
	ranges(text: string): [number, number][];
}

export interface LogMatcherResult {
	/** Null when the query is empty (nothing to search for). */
	matcher: LogMatcher | null;
	/** The reason the regular expression does not compile, else null. */
	error: string | null;
}

/** Highlight ranges kept per text field, so a pathological regex stays cheap. */
const MAX_RANGES = 500;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matcher that never matches: what an invalid regular expression finds. */
export const NEVER_MATCHER: LogMatcher = {
	test: () => false,
	ranges: () => [],
};

/**
 * Compile the search options into a matcher. Plain text is escaped, so only
 * `regex: true` reads metacharacters. `wholeWord` uses Unicode letter classes,
 * so accented words (« réussi ») are whole words too, not only ASCII ones.
 */
export function buildLogMatcher(options: LogSearchOptions): LogMatcherResult {
	const query = options.query.trim();
	if (!query) return { matcher: null, error: null };

	let source = options.regex ? query : escapeRegExp(query);
	let flags = options.caseSensitive ? "g" : "gi";
	if (options.wholeWord) {
		source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
		flags += "u";
	}

	let global: RegExp;
	let single: RegExp;
	try {
		global = new RegExp(source, flags);
		single = new RegExp(source, flags.replace("g", ""));
	} catch (err) {
		return {
			matcher: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	return {
		error: null,
		matcher: {
			test: (text) => single.test(text),
			ranges: (text) => {
				const out: [number, number][] = [];
				global.lastIndex = 0;
				for (const m of text.matchAll(global)) {
					if (m[0].length === 0 || m.index === undefined) continue;
					out.push([m.index, m.index + m[0].length]);
					if (out.length >= MAX_RANGES) break;
				}
				return out;
			},
		},
	};
}

/** True when any searchable field of the entry matches. */
export function entryMatches(entry: TaskLogEntry, matcher: LogMatcher): boolean {
	return searchableFields(entry).some(
		(field) => field !== undefined && field !== "" && matcher.test(field),
	);
}

// ---------------------------------------------------------------------------
// Entry kinds (the "Type" filter)
// ---------------------------------------------------------------------------

/**
 * What the "Type" filter offers. Backend entry types are grouped the way they
 * read on screen: tool start/end are one tool call, and success/info/phase
 * boundaries are all status lines.
 */
export type LogEntryKind = "text" | "tool" | "error" | "warning" | "status";

export const LOG_ENTRY_KINDS: readonly LogEntryKind[] = [
	"text",
	"tool",
	"error",
	"warning",
	"status",
];

export function entryKind(entry: TaskLogEntry): LogEntryKind {
	switch (entry.type) {
		case "tool_start":
		case "tool_end":
			return "tool";
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "success":
		case "info":
		case "phase_start":
		case "phase_end":
			return "status";
		default:
			return "text";
	}
}

/**
 * Keep the entries whose kind is selected and, when a matcher is given, that
 * match it. `kinds: null` keeps every kind.
 */
export function filterLogEntries(
	entries: TaskLogEntry[],
	kinds: ReadonlySet<LogEntryKind> | null,
	matcher: LogMatcher | null,
): TaskLogEntry[] {
	if (!kinds && !matcher) return entries;
	return entries.filter(
		(e) =>
			(!kinds || kinds.has(entryKind(e))) && (!matcher || entryMatches(e, matcher)),
	);
}
