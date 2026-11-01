/**
 * An analysis report, whatever its runner: its headline numbers and the
 * first items of its lists. Each runner prints its own shape (an
 * accessibility audit, missing translations, drifting docs, flaky tests,
 * debt items); the phone shows what they share rather than five layouts.
 */

import type { SavedReport } from "./types";

export interface DigestItem {
	/** Its place in the report's list: the runner's items carry no id of their own. */
	n: number;
	title: string;
	detail: string | null;
	level: string | null;
}

export interface Digest {
	figures: { label: string; value: string }[];
	lists: { label: string; total: number; items: DigestItem[] }[];
}

type Json = Record<string, unknown>;

const MAX_FIGURES = 12;
const MAX_ITEMS = 20;
const TITLE_KEYS = ["title", "message", "name", "test_name", "test", "key", "description", "file", "path", "id"];
const DETAIL_KEYS = ["description", "message", "suggestion", "recommendation", "file", "path", "location"];
const LEVEL_KEYS = ["severity", "level", "impact", "priority", "flakiness", "status"];

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** "missing_keys" → "Missing keys". */
export function humanize(key: string): string {
	const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function scalar(value: unknown): string | null {
	if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
	if (typeof value === "boolean") return value ? "✓" : "✗";
	if (typeof value === "string" && value.length <= 60) return value;
	return null;
}

function pick(item: Json, keys: string[], skip?: string): string | null {
	for (const key of keys) {
		const value = item[key];
		if (typeof value === "string" && value && value !== skip) return value.slice(0, 500);
		if (typeof value === "number" && key !== "id") return String(value);
	}
	return null;
}

function item(value: unknown, n: number): DigestItem {
	if (!isObject(value)) return { n, title: String(value).slice(0, 300), detail: null, level: null };
	const title = pick(value, TITLE_KEYS) ?? "—";
	return { n, title, detail: pick(value, DETAIL_KEYS, title), level: pick(value, LEVEL_KEYS) };
}

export function digest(report: unknown): Digest {
	const out: Digest = { figures: [], lists: [] };
	if (!isObject(report)) return out;
	const visit = (node: Json, prefix: string, depth: number) => {
		for (const [key, value] of Object.entries(node)) {
			const label = prefix ? `${prefix} · ${humanize(key)}` : humanize(key);
			const shown = scalar(value);
			if (shown !== null) {
				if (out.figures.length < MAX_FIGURES) out.figures.push({ label, value: shown });
			} else if (Array.isArray(value)) {
				if (value.length && value.some((v) => isObject(v) || typeof v === "string")) {
					out.lists.push({ label, total: value.length, items: value.slice(0, MAX_ITEMS).map(item) });
				}
			} else if (isObject(value) && depth < 1) {
				visit(value, humanize(key), depth + 1);
			}
		}
	};
	visit(report, "", 0);
	return out;
}

/** A saved report file, or null when it is not one. */
export function readSaved(text: string | null): SavedReport | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as SavedReport) : null;
	} catch {
		return null;
	}
}
