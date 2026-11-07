/**
 * `useSettingsStore()` without a selector subscribes to the whole store: the
 * component re-renders on every settings change, profile test or loading flag.
 * Sixteen components did (plan of 29 October, Q4); they now pick their fields
 * with a selector, `useShallow` when they pick several.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_DIR = join(__dirname, "..", "..");
const SOURCE = /\.(ts|tsx)$/;
const TEST = /(__tests__|\.test\.|\.spec\.)/;

function sources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...sources(full));
		} else if (SOURCE.test(entry) && !TEST.test(full)) {
			found.push(full);
		}
	}
	return found;
}

function wholeStoreReads(text: string): number {
	return (text.match(/useSettingsStore\(\s*\)/g) ?? []).length;
}

describe("settings store subscriptions", () => {
	it("counts a call without a selector, not one with", () => {
		expect(wholeStoreReads("const { a } = useSettingsStore();")).toBe(1);
		expect(wholeStoreReads("useSettingsStore(\n)")).toBe(1);
		expect(wholeStoreReads("useSettingsStore((s) => s.settings)")).toBe(0);
		expect(wholeStoreReads("useSettingsStore.getState()")).toBe(0);
	});

	it("no renderer component reads the whole settings store", () => {
		const offenders = sources(RENDERER_DIR)
			.filter((file) => wholeStoreReads(readFileSync(file, "utf-8")) > 0)
			.map((file) => relative(RENDERER_DIR, file));
		expect(offenders).toEqual([]);
	});
});
