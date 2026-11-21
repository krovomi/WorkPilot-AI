/**
 * The shape of a comparison ("How you compare" in Build Analytics) as the
 * views draw it, checked again whatever sent it: the desktop's runner
 * (`build-compare.ts`) or the server (`server-workspace.ts`). Numbers are
 * finite, counts whole and not negative, labels cut, lists bounded.
 */

import {
	type BuildComparison,
	COMPARE_METRICS,
	type CompareGroup,
	type CompareMedians,
	type CompareProjectLine,
	type CompareWindow,
} from "../shared/types/build-compare";

/** The person's other projects compared, as the runner reads at most. */
export const MAX_OTHERS = 50;
const MAX_NAME = 120;
const MAX_SEGMENT = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: 0;
}

/** A median: finite and not negative, or null. */
function median(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** A trend in percent: finite, possibly negative, or null. */
function trend(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown, limit: number, fallback: string): string {
	return typeof value === "string" && value.length > 0
		? value.slice(0, limit)
		: fallback;
}

function medians(
	raw: Record<string, unknown>,
	read: (value: unknown) => number | null = median,
): CompareMedians {
	const out = {} as CompareMedians;
	for (const metric of COMPARE_METRICS) out[metric] = read(raw[metric]);
	return out;
}

function toWindow(raw: unknown): CompareWindow {
	const record = isRecord(raw) ? raw : {};
	return { specs: count(record.specs), ...medians(record) };
}

function toGroup(raw: unknown): CompareGroup {
	const record = isRecord(raw) ? raw : {};
	return {
		projects: count(record.projects),
		medians: isRecord(record.medians) ? medians(record.medians) : null,
	};
}

function toLine(raw: unknown): CompareProjectLine | null {
	if (!isRecord(raw)) return null;
	return {
		...toWindow(raw),
		name: text(raw.name, MAX_NAME, "?"),
		stack: text(raw.stack, MAX_SEGMENT, "other"),
		size: text(raw.size, MAX_SEGMENT, "unknown"),
		current: raw.current === true,
	};
}

/** A comparison as the views draw it, or null for anything else. */
export function toBuildComparison(raw: unknown): BuildComparison | null {
	return isRecord(raw) ? comparisonFrom(raw) : null;
}

/** A comparison from an object already known to be one (a server's answer). */
export function comparisonFrom(raw: Record<string, unknown>): BuildComparison {
	const segment = isRecord(raw.segment) ? raw.segment : {};
	const groups = isRecord(raw.groups) ? raw.groups : {};
	const lines = Array.isArray(raw.projects) ? raw.projects : [];
	return {
		window_days: Math.max(1, count(raw.window_days)),
		min_group: Math.max(1, count(raw.min_group)),
		segment: {
			stack: text(segment.stack, MAX_SEGMENT, "other"),
			size: text(segment.size, MAX_SEGMENT, "unknown"),
		},
		recent: toWindow(raw.recent),
		previous: toWindow(raw.previous),
		trend: medians(isRecord(raw.trend) ? raw.trend : {}, trend),
		groups: {
			segment: toGroup(groups.segment),
			stack: toGroup(groups.stack),
			all: toGroup(groups.all),
		},
		projects: lines
			.slice(0, MAX_OTHERS + 1)
			.map(toLine)
			.filter((line): line is CompareProjectLine => line !== null),
	};
}

