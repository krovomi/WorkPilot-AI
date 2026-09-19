/**
 * The editor's unsaved state, without React.
 *
 * Everything here is a pure function over a `Draft` — what the user changed
 * since the namespace was loaded — and the `I18nEntry[]` the backend handed
 * over. The panel renders `applyDraft(...)` and saves `buildOperations(...)`,
 * so the two questions the feature turns on — *what does the table show* and
 * *what do we write* — are answered in one place and testable on their own.
 *
 * A draft is kept rather than mutating the loaded entries because a save can
 * be refused: if the files changed on disk, the panel reloads the namespace
 * and replays the same draft on top of the fresh entries. Editing the entries
 * in place would have thrown the user's work away at exactly the moment it
 * mattered.
 */

import type {
	I18nEntry,
	I18nOperation,
} from "../../../../preload/api/modules/phase35-features-api";

/** Everything changed since the load, keyed by the key as it was loaded. */
export interface Draft {
	/** originalKey → locale → value, for keys that already existed. */
	edits: Record<string, Record<string, string>>;
	/** key → locale → value, for keys created in this session. */
	added: Record<string, Record<string, string>>;
	/** originalKey → new key. */
	renames: Record<string, string>;
	/** Original keys marked for removal, across every locale. */
	deletes: string[];
}

/** One line of the table: the effective state of a key, after the draft. */
export interface Row {
	/** What the key is called now — the rename target when there is one. */
	key: string;
	/** What it was called at load time. The draft and the server agree on this. */
	originalKey: string;
	values: Record<string, string | null>;
	/** Locales whose cell differs from what was loaded. */
	dirtyLocales: string[];
	isNew: boolean;
	isRenamed: boolean;
	/** Recomputed from the current values, not the flag the load carried. */
	placeholderMismatch: boolean;
}

export type RowFilter = "all" | "missing" | "placeholder" | "mismatch";

export function emptyDraft(): Draft {
	return { edits: {}, added: {}, renames: {}, deletes: [] };
}

export function countChanges(draft: Draft): number {
	const edited = Object.values(draft.edits).reduce(
		(n, byLocale) => n + Object.keys(byLocale).length,
		0,
	);
	return (
		edited +
		Object.keys(draft.added).length +
		Object.keys(draft.renames).length +
		draft.deletes.length
	);
}

export function isDirty(draft: Draft): boolean {
	return countChanges(draft) > 0;
}

// ---------------------------------------------------------------------------
// Keys

/**
 * Mirrors `i18n_scaler/editor.py::validate_key`.
 *
 * Duplicated on purpose, and the duplication is the point: the backend's copy
 * is the one that protects the files, this one exists so a typo is answered
 * under the cursor instead of after a round trip. The backend still refuses
 * anything this lets through.
 */
export function keyError(key: string): "empty" | "shape" | "tooLong" | null {
	const trimmed = key.trim();
	if (!trimmed) return "empty";
	if (trimmed.length > 512) return "tooLong";
	if (!/^[^.\s][^.]*(?:\.[^.\s][^.]*)*$/.test(trimmed)) return "shape";
	return null;
}

/** `{{count}}` and `{count}` — the same shapes `scaler.py` extracts. */
export function placeholdersOf(value: string): string[] {
	const found = new Set<string>();
	for (const m of value.matchAll(/\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g)) {
		found.add(m[1]);
	}
	return [...found].sort();
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// Deriving the table

/**
 * The rows to render: the loaded entries with the draft applied, then the
 * keys added in this session.
 *
 * `referenceLocale` decides whose interpolation variables the rest are
 * compared against, and the mismatch is recomputed here rather than read off
 * the entry — otherwise the warning would still be showing after the edit
 * that fixed it.
 */
export function applyDraft(
	entries: I18nEntry[],
	draft: Draft,
	locales: string[],
	referenceLocale: string,
): Row[] {
	const deleted = new Set(draft.deletes);
	const rows: Row[] = [];

	for (const entry of entries) {
		if (deleted.has(entry.key)) continue;
		const overrides = draft.edits[entry.key] ?? {};
		const values: Record<string, string | null> = {};
		const dirtyLocales: string[] = [];
		for (const locale of locales) {
			if (locale in overrides) {
				values[locale] = overrides[locale];
				if (overrides[locale] !== (entry.values[locale] ?? null)) {
					dirtyLocales.push(locale);
				}
			} else {
				values[locale] = entry.values[locale] ?? null;
			}
		}
		const renamed = draft.renames[entry.key];
		rows.push({
			key: renamed ?? entry.key,
			originalKey: entry.key,
			values,
			dirtyLocales,
			isNew: false,
			isRenamed: Boolean(renamed),
			placeholderMismatch: mismatches(values, locales, referenceLocale),
		});
	}

	for (const [key, byLocale] of Object.entries(draft.added)) {
		const values: Record<string, string | null> = {};
		for (const locale of locales) {
			values[locale] = locale in byLocale ? byLocale[locale] : null;
		}
		rows.push({
			key,
			originalKey: key,
			values,
			dirtyLocales: Object.keys(byLocale),
			isNew: true,
			isRenamed: false,
			placeholderMismatch: mismatches(values, locales, referenceLocale),
		});
	}

	return rows;
}

function mismatches(
	values: Record<string, string | null>,
	locales: string[],
	referenceLocale: string,
): boolean {
	const reference = values[referenceLocale];
	if (reference == null) return false;
	const expected = placeholdersOf(reference);
	return locales.some((locale) => {
		if (locale === referenceLocale) return false;
		const value = values[locale];
		return value != null && !sameSet(placeholdersOf(value), expected);
	});
}

// ---------------------------------------------------------------------------
// Filtering

export function filterRows(
	rows: Row[],
	options: {
		query: string;
		filter: RowFilter;
		locales: string[];
	},
): Row[] {
	const query = options.query.trim().toLowerCase();
	return rows.filter((row) => {
		if (options.filter === "missing") {
			if (!options.locales.some((l) => row.values[l] == null)) return false;
		} else if (options.filter === "placeholder") {
			if (!options.locales.some((l) => looksUntranslated(row.values[l], l))) {
				return false;
			}
		} else if (options.filter === "mismatch") {
			if (!row.placeholderMismatch) return false;
		}
		if (!query) return true;
		if (row.key.toLowerCase().includes(query)) return true;
		return options.locales.some((l) =>
			(row.values[l] ?? "").toLowerCase().includes(query),
		);
	});
}

/**
 * The `[FR] …` marker `scaler.py` writes for an untranslated key, and the
 * empty string. Kept in step with `I18nAutoScaler._looks_like_placeholder`,
 * minus the strategies the editor cannot see from a single value.
 */
export function looksUntranslated(
	value: string | null | undefined,
	locale: string,
): boolean {
	if (value == null) return false;
	if (value === "") return true;
	if (value === "__TRANSLATE_ME__") return true;
	return value.startsWith(`[${locale.toUpperCase()}] `);
}

// ---------------------------------------------------------------------------
// Mutating the draft
//
// Each returns a new draft. Which bucket an edit lands in depends on how the
// key got here: a key created in this session is edited inside `added`, so it
// still saves as one `add` rather than an `add` plus a `set` of the same value.

export function setValue(
	draft: Draft,
	originalKey: string,
	locale: string,
	value: string,
): Draft {
	if (originalKey in draft.added) {
		return {
			...draft,
			added: {
				...draft.added,
				[originalKey]: { ...draft.added[originalKey], [locale]: value },
			},
		};
	}
	return {
		...draft,
		edits: {
			...draft.edits,
			[originalKey]: { ...(draft.edits[originalKey] ?? {}), [locale]: value },
		},
	};
}

/** Drop one cell's override, returning it to whatever was loaded. */
export function revertValue(
	draft: Draft,
	originalKey: string,
	locale: string,
): Draft {
	const byLocale = draft.edits[originalKey];
	if (!byLocale || !(locale in byLocale)) return draft;
	const { [locale]: _dropped, ...rest } = byLocale;
	const edits = { ...draft.edits };
	if (Object.keys(rest).length) edits[originalKey] = rest;
	else delete edits[originalKey];
	return { ...draft, edits };
}

export function addKey(
	draft: Draft,
	key: string,
	values: Record<string, string>,
): Draft {
	return { ...draft, added: { ...draft.added, [key]: { ...values } } };
}

/**
 * Remove a key. One that was only ever a draft leaves no trace; one that
 * exists on disk is recorded so the save deletes it from every locale.
 */
export function deleteKey(draft: Draft, originalKey: string): Draft {
	if (originalKey in draft.added) {
		const { [originalKey]: _dropped, ...added } = draft.added;
		return { ...draft, added };
	}
	if (draft.deletes.includes(originalKey)) return draft;
	const { [originalKey]: _edits, ...edits } = draft.edits;
	const { [originalKey]: _rename, ...renames } = draft.renames;
	return {
		...draft,
		edits,
		renames,
		deletes: [...draft.deletes, originalKey],
	};
}

/**
 * Take back a pending deletion.
 *
 * A deleted key stays listed in the table, struck through, until the save —
 * so the way back is a button next to it rather than Discard, which would
 * throw away every other edit as well.
 */
export function restoreKey(draft: Draft, originalKey: string): Draft {
	if (!draft.deletes.includes(originalKey)) return draft;
	return { ...draft, deletes: draft.deletes.filter((k) => k !== originalKey) };
}

export function renameKey(
	draft: Draft,
	originalKey: string,
	newKey: string,
): Draft {
	if (originalKey in draft.added) {
		const { [originalKey]: values, ...added } = draft.added;
		return { ...draft, added: { ...added, [newKey]: values } };
	}
	if (newKey === originalKey) {
		const { [originalKey]: _dropped, ...renames } = draft.renames;
		return { ...draft, renames };
	}
	return { ...draft, renames: { ...draft.renames, [originalKey]: newKey } };
}

// ---------------------------------------------------------------------------
// Saving

/**
 * The operations to send, in the order the backend must apply them.
 *
 * Deletes first so a key being replaced frees its path; then renames, so the
 * `set`s that follow can name the key by its new path; then the additions;
 * then the value edits. A `set` on a renamed key carries the new name for
 * exactly that reason — sending the old one would create a second key and
 * leave the renamed one untouched.
 */
export function buildOperations(draft: Draft): I18nOperation[] {
	const operations: I18nOperation[] = [];

	for (const key of draft.deletes) {
		operations.push({ op: "delete", key });
	}
	for (const [key, newKey] of Object.entries(draft.renames)) {
		operations.push({ op: "rename", key, new_key: newKey });
	}
	for (const [key, values] of Object.entries(draft.added)) {
		operations.push({ op: "add", key, values });
	}
	for (const [key, values] of Object.entries(draft.edits)) {
		if (!Object.keys(values).length) continue;
		operations.push({ op: "set", key: draft.renames[key] ?? key, values });
	}
	return operations;
}
