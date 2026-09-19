import { describe, expect, it } from "vitest";
import type { I18nEntry } from "../../../../../preload/api/modules/phase35-features-api";
import {
	addKey,
	applyDraft,
	buildOperations,
	countChanges,
	deleteKey,
	emptyDraft,
	filterRows,
	keyError,
	looksUntranslated,
	placeholdersOf,
	renameKey,
	revertValue,
	setValue,
} from "../drafts";

const LOCALES = ["en", "fr"];

function entries(): I18nEntry[] {
	return [
		{
			key: "buttons.save",
			values: { en: "Save", fr: "Enregistrer" },
			placeholder_mismatch: false,
		},
		{
			key: "buttons.undo",
			values: { en: "Undo", fr: null },
			placeholder_mismatch: false,
		},
		{
			key: "greeting",
			values: { en: "Hello {{name}}", fr: "Bonjour {{nom}}" },
			placeholder_mismatch: true,
		},
	];
}

describe("applyDraft", () => {
	it("returns the loaded entries untouched when nothing was edited", () => {
		const rows = applyDraft(entries(), emptyDraft(), LOCALES, "en");
		expect(rows.map((r) => r.key)).toEqual([
			"buttons.save",
			"buttons.undo",
			"greeting",
		]);
		expect(rows.every((r) => r.dirtyLocales.length === 0)).toBe(true);
	});

	it("applies an edit and marks only that cell dirty", () => {
		const draft = setValue(emptyDraft(), "buttons.save", "fr", "Sauver");
		const [row] = applyDraft(entries(), draft, LOCALES, "en");
		expect(row.values.fr).toBe("Sauver");
		expect(row.values.en).toBe("Save");
		expect(row.dirtyLocales).toEqual(["fr"]);
	});

	it("does not mark a cell dirty when it was typed back to its loaded value", () => {
		const draft = setValue(emptyDraft(), "buttons.save", "fr", "Enregistrer");
		const [row] = applyDraft(entries(), draft, LOCALES, "en");
		expect(row.dirtyLocales).toEqual([]);
	});

	it("keeps a missing value distinct from an empty one", () => {
		const rows = applyDraft(entries(), emptyDraft(), LOCALES, "en");
		expect(rows[1].values.fr).toBeNull();
		const filled = applyDraft(
			entries(),
			setValue(emptyDraft(), "buttons.undo", "fr", ""),
			LOCALES,
			"en",
		);
		expect(filled[1].values.fr).toBe("");
	});

	it("drops a deleted key and appends an added one", () => {
		let draft = deleteKey(emptyDraft(), "buttons.undo");
		draft = addKey(draft, "buttons.redo", { en: "Redo", fr: "Rétablir" });
		const rows = applyDraft(entries(), draft, LOCALES, "en");
		expect(rows.map((r) => r.key)).toEqual([
			"buttons.save",
			"greeting",
			"buttons.redo",
		]);
		expect(rows.at(-1)?.isNew).toBe(true);
	});

	it("shows a renamed key under its new name and remembers the old one", () => {
		const draft = renameKey(emptyDraft(), "buttons.save", "actions.save");
		const [row] = applyDraft(entries(), draft, LOCALES, "en");
		expect(row.key).toBe("actions.save");
		expect(row.originalKey).toBe("buttons.save");
		expect(row.isRenamed).toBe(true);
	});

	it("recomputes the placeholder mismatch instead of trusting the load", () => {
		// The entry arrives flagged; the edit that fixes it must clear the flag.
		const before = applyDraft(entries(), emptyDraft(), LOCALES, "en");
		expect(before[2].placeholderMismatch).toBe(true);

		const draft = setValue(emptyDraft(), "greeting", "fr", "Bonjour {{name}}");
		const after = applyDraft(entries(), draft, LOCALES, "en");
		expect(after[2].placeholderMismatch).toBe(false);
	});

	it("does not flag a locale that has no value yet", () => {
		const rows = applyDraft(
			[
				{
					key: "k",
					values: { en: "Hi {{name}}", fr: null },
					placeholder_mismatch: false,
				},
			],
			emptyDraft(),
			LOCALES,
			"en",
		);
		expect(rows[0].placeholderMismatch).toBe(false);
	});
});

describe("draft bookkeeping", () => {
	it("counts each changed cell, addition, rename and deletion once", () => {
		let draft = setValue(emptyDraft(), "buttons.save", "fr", "Sauver");
		draft = setValue(draft, "buttons.save", "en", "Store");
		draft = addKey(draft, "new.key", { en: "New" });
		draft = renameKey(draft, "greeting", "hello");
		draft = deleteKey(draft, "buttons.undo");
		expect(countChanges(draft)).toBe(5);
	});

	it("reverting the last cell of a key drops the key from the draft", () => {
		let draft = setValue(emptyDraft(), "buttons.save", "fr", "Sauver");
		draft = revertValue(draft, "buttons.save", "fr");
		expect(countChanges(draft)).toBe(0);
		expect(draft.edits["buttons.save"]).toBeUndefined();
	});

	it("edits a key added in this session in place, not as a separate set", () => {
		let draft = addKey(emptyDraft(), "new.key", { en: "New" });
		draft = setValue(draft, "new.key", "fr", "Nouveau");
		expect(draft.edits).toEqual({});
		expect(draft.added["new.key"]).toEqual({ en: "New", fr: "Nouveau" });
		expect(buildOperations(draft)).toEqual([
			{ op: "add", key: "new.key", values: { en: "New", fr: "Nouveau" } },
		]);
	});

	it("deleting a key that only ever existed as a draft leaves no operation", () => {
		let draft = addKey(emptyDraft(), "new.key", { en: "New" });
		draft = deleteKey(draft, "new.key");
		expect(countChanges(draft)).toBe(0);
		expect(buildOperations(draft)).toEqual([]);
	});

	it("deleting an edited key drops its pending edits", () => {
		let draft = setValue(emptyDraft(), "buttons.save", "fr", "Sauver");
		draft = deleteKey(draft, "buttons.save");
		expect(buildOperations(draft)).toEqual([
			{ op: "delete", key: "buttons.save" },
		]);
	});

	it("renaming back to the original name clears the rename", () => {
		let draft = renameKey(emptyDraft(), "greeting", "hello");
		draft = renameKey(draft, "greeting", "greeting");
		expect(countChanges(draft)).toBe(0);
	});
});

describe("buildOperations", () => {
	it("orders deletes, renames, adds, then sets", () => {
		let draft = setValue(emptyDraft(), "buttons.save", "fr", "Sauver");
		draft = addKey(draft, "new.key", { en: "New" });
		draft = renameKey(draft, "greeting", "hello");
		draft = deleteKey(draft, "buttons.undo");
		expect(buildOperations(draft).map((o) => o.op)).toEqual([
			"delete",
			"rename",
			"add",
			"set",
		]);
	});

	it("a set on a renamed key carries the new name", () => {
		// Sending the old one would create a second key and leave the rename
		// holding the stale value.
		let draft = renameKey(emptyDraft(), "greeting", "hello");
		draft = setValue(draft, "greeting", "fr", "Salut");
		const ops = buildOperations(draft);
		expect(ops).toEqual([
			{ op: "rename", key: "greeting", new_key: "hello" },
			{ op: "set", key: "hello", values: { fr: "Salut" } },
		]);
	});

	it("produces nothing for a clean draft", () => {
		expect(buildOperations(emptyDraft())).toEqual([]);
	});
});

describe("keyError", () => {
	it.each([
		["buttons.save", null],
		["a", null],
		["a.b.c.d", null],
		["", "empty"],
		["   ", "empty"],
		["a..b", "shape"],
		[".leading", "shape"],
		["trailing.", "shape"],
		["a. spaced", "shape"],
	])("%s → %s", (key, expected) => {
		expect(keyError(key)).toBe(expected);
	});

	it("refuses a key longer than the backend accepts", () => {
		expect(keyError("a".repeat(513))).toBe("tooLong");
	});
});

describe("placeholdersOf", () => {
	it("reads both brace styles and de-duplicates", () => {
		expect(placeholdersOf("Hi {{name}}, you have {count} of {{name}}")).toEqual([
			"count",
			"name",
		]);
	});

	it("returns nothing for plain text", () => {
		expect(placeholdersOf("Bonjour")).toEqual([]);
	});
});

describe("looksUntranslated", () => {
	it.each([
		[null, "fr", false],
		["", "fr", true],
		["__TRANSLATE_ME__", "fr", true],
		["[FR] Save", "fr", true],
		["[FR] Save", "en", false],
		["Enregistrer", "fr", false],
	])("%s in %s → %s", (value, locale, expected) => {
		expect(looksUntranslated(value, locale)).toBe(expected);
	});
});

describe("filterRows", () => {
	const rows = () => applyDraft(entries(), emptyDraft(), LOCALES, "en");

	it("keeps everything by default", () => {
		expect(
			filterRows(rows(), { query: "", filter: "all", locales: LOCALES }),
		).toHaveLength(3);
	});

	it("missing keeps only rows a locale has no value for", () => {
		const out = filterRows(rows(), {
			query: "",
			filter: "missing",
			locales: LOCALES,
		});
		expect(out.map((r) => r.key)).toEqual(["buttons.undo"]);
	});

	it("mismatch keeps only rows whose variables diverge", () => {
		const out = filterRows(rows(), {
			query: "",
			filter: "mismatch",
			locales: LOCALES,
		});
		expect(out.map((r) => r.key)).toEqual(["greeting"]);
	});

	it("searches keys and values, case-insensitively", () => {
		expect(
			filterRows(rows(), {
				query: "enregis",
				filter: "all",
				locales: LOCALES,
			}).map((r) => r.key),
		).toEqual(["buttons.save"]);
		expect(
			filterRows(rows(), { query: "BUTTONS", filter: "all", locales: LOCALES })
				.length,
		).toBe(2);
	});

	it("combines a filter with a search", () => {
		const out = filterRows(rows(), {
			query: "undo",
			filter: "missing",
			locales: LOCALES,
		});
		expect(out.map((r) => r.key)).toEqual(["buttons.undo"]);
	});
});
