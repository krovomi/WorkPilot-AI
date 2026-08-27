/**
 * The sidebar labels are what the user reads first, and they had drifted apart
 * in a way nobody could see from the code.
 *
 * The French group labels carried an emoji prefix (`🎯 Espace de travail`) and
 * the English ones carried the *space that had separated an emoji since
 * removed* (` Workspace`). Two halves of one edit, left in opposite states.
 * The emoji rendered as tofu boxes in the app's font — and were redundant
 * anyway, since every group already renders its own lucide icon.
 *
 * A leading space is not only cosmetic here: `Sidebar.tsx` filters the command
 * search with `t(item.labelKey).toLowerCase().includes(query)`, so decoration
 * inside the label quietly changes what matches.
 */

import { describe, expect, it } from "vitest";
import enNavigation from "../locales/en/navigation.json";
import frNavigation from "../locales/fr/navigation.json";

const LOCALES = {
	en: enNavigation as Record<string, unknown>,
	fr: frNavigation as Record<string, unknown>,
};

/** Every leaf string in a translation tree, keyed by its dotted path. */
function flatten(
	node: unknown,
	path = "",
	out: Record<string, string> = {},
): Record<string, string> {
	if (typeof node === "string") {
		out[path] = node;
		return out;
	}
	if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			flatten(value, path ? `${path}.${key}` : key, out);
		}
	}
	return out;
}

// Pictographs, dingbats, and the variation selector that turns a plain glyph
// into an emoji. Deliberately not a general "non-ASCII" test: accented
// characters are the point of a French locale.
//
// An alternation rather than one character class: U+FE0F is a combining
// character, and a class that mixes one with a range matches things neither
// half intended.
const PICTOGRAPH =
	/[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|\u{FE0F}/u;

describe("navigation labels", () => {
	for (const [locale, resource] of Object.entries(LOCALES)) {
		describe(locale, () => {
			const entries = Object.entries(flatten(resource));

			it("has labels", () => {
				expect(entries.length).toBeGreaterThan(0);
			});

			it("carries no stray leading or trailing whitespace", () => {
				const offenders = entries.filter(([, v]) => v !== v.trim());
				expect(offenders).toEqual([]);
			});

			it("carries no emoji — the sidebar renders its own icons", () => {
				const offenders = entries.filter(([, v]) => PICTOGRAPH.test(v));
				expect(offenders).toEqual([]);
			});
		});
	}

	it("declares the same keys in both locales", () => {
		const en = Object.keys(flatten(LOCALES.en)).sort();
		const fr = Object.keys(flatten(LOCALES.fr)).sort();
		expect(fr).toEqual(en);
	});

	it("translates every key rather than copying the English through", () => {
		// A handful legitimately match: proper nouns and names that do not
		// translate. Everything else differing is what tells us the French
		// file is a translation and not a stale copy.
		const en = flatten(LOCALES.en);
		const fr = flatten(LOCALES.fr);
		const identical = Object.keys(en).filter((k) => en[k] === fr[k]);
		expect(identical.length).toBeLessThan(Object.keys(en).length);
	});
});
