/**
 * 75 keys were called through `t()` that existed in neither locale.
 *
 * Nine of them rendered the key itself to the user — `common:noProjectSelected`
 * on the empty state a new user meets first, `taskReview:pr.files.changedFiles`
 * under the file count, `tasks:plan.saveError` in a toast. The rest passed a
 * hardcoded English `defaultValue`, so they looked fine in English and shipped
 * English to French users, which is the project's i18n rule broken quietly
 * rather than loudly.
 *
 * Nothing could catch it: `lint`, `typecheck` and the test suite never open the
 * locale files, and `navigation-labels.test.ts` — the one test that did — covers
 * a single namespace out of 91.
 *
 * So this checks the two things that actually hurt:
 *   1. every key the source calls exists in both locales;
 *   2. EN and FR declare the same keys, namespace by namespace.
 *
 * (2) had known debt when this test was written — `settings` and `dashboard`
 * were exempted. Both are now at parity and the exemption list is gone, so a
 * namespace that drifts fails here instead of being written down.
 *
 * (3) checks that a plural is declared the way i18next v25 reads it. The v3
 * `_plural` suffix parses fine and is never looked up, so a key carrying it
 * silently renders its singular for every count — 73 keys did.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES = path.resolve(import.meta.dirname, "..", "locales");
const SRC = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * `i18nAgent:issueType.missing_plural` is not a plural form: it labels the
 * issue type the i18n agent itself calls `missing_plural`
 * (`shared/types/i18n-agent.ts`, `i18n_scanner.py`), reached through
 * ``t(`issueType.${issue.issueType}`)``. Renaming it would break that label.
 */
const NOT_A_PLURAL = new Set(["i18nAgent:issueType.missing_plural"]);

type Tree = Record<string, unknown>;

/** Every leaf path in a translation tree. */
function flatten(node: unknown, prefix = "", out: string[] = []): string[] {
	if (node && typeof node === "object" && !Array.isArray(node)) {
		for (const [key, value] of Object.entries(node as Tree)) {
			flatten(value, prefix ? `${prefix}.${key}` : key, out);
		}
	} else {
		out.push(prefix);
	}
	return out;
}

function load(locale: "en" | "fr", file: string): Set<string> {
	const raw = readFileSync(path.join(LOCALES, locale, file), "utf-8");
	return new Set(flatten(JSON.parse(raw)));
}

/** Source files that may call `t()`, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			sourceFiles(full, out);
		} else if (
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
			!entry.name.includes(".test.")
		) {
			out.push(full);
		}
	}
	return out;
}

const namespaces = readdirSync(path.join(LOCALES, "en")).filter((f) =>
	f.endsWith(".json"),
);

describe("locale parity", () => {
	it("ships the same namespaces in both locales", () => {
		const fr = readdirSync(path.join(LOCALES, "fr")).filter((f) =>
			f.endsWith(".json"),
		);
		expect(fr.sort()).toEqual([...namespaces].sort());
	});

	it("covers every namespace", () => {
		expect(namespaces.length).toBeGreaterThan(80);
	});

	for (const file of namespaces) {
		const ns = file.replace(/\.json$/, "");

		it(`declares the same keys in en and fr — ${ns}`, () => {
			const en = [...load("en", file)].sort();
			const fr = [...load("fr", file)].sort();
			expect(fr).toEqual(en);
		});
	}
});

describe("plural forms", () => {
	it("uses the suffixes i18next v25 actually reads", () => {
		// `_plural` is the i18next v3 spelling. v25 resolves a count through
		// Intl.PluralRules and looks up `_one`/`_other`, never `_plural`, then
		// falls back to the unsuffixed key — so the plural text is parsed,
		// shipped, translated, and never shown. It was on 73 keys.
		const stale: string[] = [];
		for (const locale of ["en", "fr"] as const) {
			for (const file of namespaces) {
				const ns = file.replace(/\.json$/, "");
				for (const key of load(locale, file)) {
					if (!key.endsWith("_plural")) continue;
					if (NOT_A_PLURAL.has(`${ns}:${key}`)) continue;
					stale.push(`${locale}/${ns}:${key}`);
				}
			}
		}
		expect(stale.sort()).toEqual([]);
	});

	it("always leaves something for count === 1 to resolve to", () => {
		// Measured against the installed i18next, not assumed:
		//
		//   base + `_other`   count 1 -> the base       (correct)
		//   `_other` alone    count 1 -> "the.key.name" (the key, to the user)
		//   base + `_plural`  count 5 -> the base       (the singular, always)
		//
		// So an unsuffixed key next to `_other` is a working singular and not a
		// half-finished migration — but `_other` on its own has nothing to fall
		// back to, and puts the key itself on screen.
		const unresolvable: string[] = [];
		for (const locale of ["en", "fr"] as const) {
			for (const file of namespaces) {
				const keys = load(locale, file);
				const ns = file.replace(/\.json$/, "");
				for (const key of keys) {
					if (!key.endsWith("_other")) continue;
					const base = key.slice(0, -"_other".length);
					if (!keys.has(`${base}_one`) && !keys.has(base)) {
						unresolvable.push(`${locale}/${ns}:${base}`);
					}
				}
			}
		}
		expect([...new Set(unresolvable)].sort()).toEqual([]);
	});
});

describe("translation keys used in the source", () => {
	// `t("namespace:some.key")`. Template literals and computed keys are out of
	// reach for a static scan and are deliberately not matched.
	const CALL = /\bt\(\s*['"]([a-zA-Z0-9_]+):([a-zA-Z0-9_.-]+)['"]/g;

	const byNamespace = new Map<string, { en: Set<string>; fr: Set<string> }>();
	for (const file of namespaces) {
		byNamespace.set(file.replace(/\.json$/, ""), {
			en: load("en", file),
			fr: load("fr", file),
		});
	}

	/** i18next resolves a count-bearing key through its plural suffixes. */
	function declares(keys: Set<string>, key: string): boolean {
		return (
			keys.has(key) ||
			keys.has(`${key}_one`) ||
			keys.has(`${key}_other`) ||
			keys.has(`${key}_plural`)
		);
	}

	const calls: { ns: string; key: string; file: string }[] = [];
	for (const file of sourceFiles(SRC)) {
		const text = readFileSync(file, "utf-8");
		for (const [, ns, key] of text.matchAll(CALL)) {
			if (!byNamespace.has(ns)) continue; // unknown namespace: not ours to judge
			calls.push({ ns, key, file: path.relative(SRC, file) });
		}
	}

	it("finds the call sites", () => {
		expect(calls.length).toBeGreaterThan(1000);
	});

	it("declares every key the source asks for, in both locales", () => {
		const missing = calls
			.filter(({ ns, key }) => {
				const entry = byNamespace.get(ns);
				if (!entry) return false;
				return !declares(entry.en, key) || !declares(entry.fr, key);
			})
			.map(({ ns, key, file }) => `${ns}:${key} (${file})`);

		expect([...new Set(missing)].sort()).toEqual([]);
	});
});
