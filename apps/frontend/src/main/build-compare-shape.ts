/**
 * The shape of a comparison ("How you compare" in Build Analytics) as the
 * views draw it, checked again whatever sent it: the desktop's runner
 * (`build-compare.ts`) or the server (`server-workspace.ts`). Numbers are
 * finite, counts whole and not negative, labels cut, lists bounded.
 */

import {
	type BuildComparison,
	COMPARE_GROUPS,
	COMPARE_METRICS,
	type CompareGroup,
	type CompareMetric,
	type CompareGroupName,
	type CompareKindLine,
	type CompareMedians,
	type CompareProjectLine,
	type CompareWindow,
	HIGHER_IS_BETTER,
} from "../shared/types/build-compare";

/** The person's other projects compared, as the runner reads at most. */
export const MAX_OTHERS = 50;
const MAX_NAME = 120;
const MAX_SEGMENT = 40;
/** Weeks of a sparkline and kinds of work, at most (the backend sends 8 and 10). */
const MAX_WEEKS = 12;
const MAX_KINDS = 16;
/** A kind names a translation key: a short identifier, nothing else. */
const KIND = /^[a-z][a-z_]{0,31}$/;

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

/** A figure: a median, at most 100 for the two given in percent. */
function figure(metric: CompareMetric, value: unknown): number | null {
	const found = median(value);
	return found !== null && HIGHER_IS_BETTER.has(metric) && found > 100 ? null : found;
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
	read: (metric: CompareMetric, value: unknown) => number | null = figure,
): CompareMedians {
	const out = {} as CompareMedians;
	for (const metric of COMPARE_METRICS) out[metric] = read(metric, raw[metric]);
	return out;
}

const trends = (_metric: CompareMetric, value: unknown) => trend(value);

/** A segment's bucket the project left, or null. */
function bucketFrom(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_SEGMENT) : null;
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
		top: isRecord(record.top) ? medians(record.top) : null,
		trend: isRecord(record.trend) ? medians(record.trend, trends) : null,
	};
}

function toKind(raw: unknown): CompareKindLine | null {
	if (!isRecord(raw) || typeof raw.kind !== "string" || !KIND.test(raw.kind)) return null;
	return { kind: raw.kind, ...toWindow(raw), group: toGroup(raw.group) };
}

function list(value: unknown, limit: number): unknown[] {
	return Array.isArray(value) ? value.slice(0, limit) : [];
}

function toLine(raw: unknown): CompareProjectLine | null {
	if (!isRecord(raw)) return null;
	return {
		...toWindow(raw),
		name: text(raw.name, MAX_NAME, "?"),
		stack: text(raw.stack, MAX_SEGMENT, "other"),
		size: text(raw.size, MAX_SEGMENT, "unknown"),
		team: text(raw.team, MAX_SEGMENT, "unknown"),
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
	const minTop = count(raw.min_top);
	return {
		window_days: Math.max(1, count(raw.window_days)),
		min_group: Math.max(1, count(raw.min_group)),
		min_top: minTop > 0 ? minTop : null,
		segment: {
			stack: text(segment.stack, MAX_SEGMENT, "other"),
			size: text(segment.size, MAX_SEGMENT, "unknown"),
			team: text(segment.team, MAX_SEGMENT, "unknown"),
			size_from: bucketFrom(segment.size_from),
			team_from: bucketFrom(segment.team_from),
		},
		recent: toWindow(raw.recent),
		previous: toWindow(raw.previous),
		trend: medians(isRecord(raw.trend) ? raw.trend : {}, trends),
		weeks: list(raw.weeks, MAX_WEEKS).map(toWindow),
		groups: Object.fromEntries(
			COMPARE_GROUPS.map((name) => [name, toGroup(groups[name])]),
		) as Record<CompareGroupName, CompareGroup>,
		kinds: list(raw.kinds, MAX_KINDS)
			.map(toKind)
			.filter((line): line is CompareKindLine => line !== null),
		projects: list(raw.projects, MAX_OTHERS + 1)
			.map(toLine)
			.filter((line): line is CompareProjectLine => line !== null),
	};
}

