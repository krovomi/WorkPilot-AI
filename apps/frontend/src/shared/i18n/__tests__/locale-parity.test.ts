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
 * (2) has known debt, listed below. The list may shrink; an entry added to it
 * is a namespace someone let drift.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES = path.resolve(import.meta.dirname, "..", "locales");
const SRC = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * Namespaces whose two locales are not yet key-for-key identical.
 *
 * `settings` carries ~290 keys that exist on one side only; all but the five
 * `accounts.toast.*` entries fixed alongside this test are unreferenced
 * leftovers, and deleting them is its own change. `dashboard` holds a single
 * `completed_plural` — an i18next v3 suffix that v25 never reads, part of a
 * wider dead-plural problem (73 keys across 15 files) also left for its own
 * change rather than rushed here.
 */
const KNOWN_DRIFT = new Set(["settings", "dashboard"]);

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
		const skip = KNOWN_DRIFT.has(ns);

		it.skipIf(skip)(`declares the same keys in en and fr — ${ns}`, () => {
			const en = [...load("en", file)].sort();
			const fr = [...load("fr", file)].sort();
			expect(fr).toEqual(en);
		});
	}
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
