/**
 * Reading the feedback dataset on PR review findings (#361) the way the
 * backend reads it (`apps/backend/learning_loop/review_feedback.py`), for the
 * acceptance-rate view and the conventions file.
 *
 * The backend decides what a review drops; this module only has to show the
 * same thing. Both name a kind of remark by its signature (category +
 * normalised title, hashed) and must agree on it: the shared cases in
 * `tests/fixtures/review_feedback/signatures.json` are checked on both sides.
 *
 * The file is read bounded (its newest 2 MB, like the backend), and a line is
 * counted only when it has the shape the store writes.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
	REVIEW_FEEDBACK_REASONS,
	REVIEW_FEEDBACK_VERDICTS,
	type ReviewFeedbackReason,
	type ReviewFeedbackVerdict,
} from "../../../shared/types/review-feedback";

export const SCHEMA_VERSION = 1;
export const RESET_KIND = "reset";
/** Only the newest part of a larger file is read (the store compacts at 1 MB). */
export const MAX_READ_BYTES = 2_000_000;
export const MAX_TITLE_CHARS = 300;
export const MAX_LABEL_CHARS = 120;

export const DEFAULT_THRESHOLD = 3;
export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 50;

/** Never downgraded nor dropped, whatever the feedback says (as the backend). */
export const PROTECTED_CATEGORIES: ReadonlySet<string> = new Set(["security"]);

export const SIGNATURE = /^[0-9a-f]{16}$/;
const FINDING_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CATEGORY = /^[a-z_]{1,32}$/;
const SEVERITIES: ReadonlySet<string> = new Set([
	"critical",
	"high",
	"medium",
	"low",
]);

// The backend's patterns: Python's `\d` and `\w` are Unicode-aware on text.
const QUOTED = /`[^`]*`|"[^"]*"|'[^']*'/g;
const DIGITS = /\p{Nd}+/gu;
const NON_WORD = /[^\p{L}\p{N}_#]+/gu;
const SPACES = /\s+/gu;

function codePoints(text: string, max: number): string {
	return Array.from(text).slice(0, max).join("");
}

/** The wording that stays once identifiers and numbers are taken out. */
export function normalizeTitle(title: string): string {
	const text = title
		.replace(QUOTED, " q ")
		.replace(DIGITS, "#")
		.toLowerCase()
		.replace(NON_WORD, " ")
		.replace(SPACES, " ")
		.trim();
	return codePoints(text, MAX_TITLE_CHARS);
}

/** Stable id of a kind of remark: category + normalised title. */
export function signature(category: string, title: string): string {
	const key = `${category.toLowerCase()}|${normalizeTitle(title)}`;
	return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** `raw`, else the default, bounded like the backend's threshold. */
export function resolveThreshold(raw: string | undefined): number {
	if (raw === undefined || !/^\s*[+-]?\d+\s*$/.test(raw)) {
		return DEFAULT_THRESHOLD;
	}
	const value = Number.parseInt(raw, 10);
	return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, value));
}

export interface FeedbackRecord {
	pr: number;
	findingId: string;
	verdict: ReviewFeedbackVerdict;
	reason: ReviewFeedbackReason | null;
	category: string;
	severity: string;
	title: string;
	signature: string;
}

function isVerdict(value: unknown): value is ReviewFeedbackVerdict {
	return (
		typeof value === "string" &&
		(REVIEW_FEEDBACK_VERDICTS as readonly string[]).includes(value)
	);
}

function isReason(value: unknown): value is ReviewFeedbackReason {
	return (
		typeof value === "string" &&
		(REVIEW_FEEDBACK_REASONS as readonly string[]).includes(value)
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The record if it has the shape the store gives it, else `null`. */
export function validRecord(value: unknown): FeedbackRecord | null {
	const record = asRecord(value);
	if (!record || record.v !== SCHEMA_VERSION) return null;
	const { pr, finding_id, verdict, reason, category, severity, title } = record;
	if (
		typeof pr !== "number" ||
		!Number.isInteger(pr) ||
		pr <= 0 ||
		pr >= 1_000_000_000
	) {
		return null;
	}
	if (typeof finding_id !== "string" || !FINDING_ID.test(finding_id)) {
		return null;
	}
	if (!isVerdict(verdict)) return null;
	if (reason !== undefined && reason !== null && !isReason(reason)) return null;
	if (typeof category !== "string" || !CATEGORY.test(category)) return null;
	if (typeof severity !== "string" || !SEVERITIES.has(severity)) return null;
	if (typeof title !== "string" || !title.trim()) return null;
	const kept = codePoints(title, MAX_TITLE_CHARS);
	return {
		pr,
		findingId: finding_id,
		verdict,
		reason: isReason(reason) ? reason : null,
		category,
		severity,
		title: kept,
		signature: signature(category, kept),
	};
}

/** The signature a reset line forgets, or `null` when the line is not one. */
export function resetSignature(value: unknown): string | null {
	const record = asRecord(value);
	if (!record || record.v !== SCHEMA_VERSION || record.kind !== RESET_KIND) {
		return null;
	}
	const sig = record.signature;
	return typeof sig === "string" && SIGNATURE.test(sig) ? sig : null;
}

/**
 * Every valid record, the latest per finding, oldest first; a reset line
 * forgets the votes before it on its signature.
 */
export function parseDataset(text: string): FeedbackRecord[] {
	const latest = new Map<string, FeedbackRecord>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const reset = resetSignature(parsed);
		if (reset) {
			for (const [key, record] of latest) {
				if (record.signature === reset) latest.delete(key);
			}
			continue;
		}
		const record = validRecord(parsed);
		if (!record) continue;
		const key = `${record.pr}\u0000${record.findingId}`;
		latest.delete(key);
		latest.set(key, record);
	}
	return [...latest.values()];
}

/** The newest `MAX_READ_BYTES` of `file`, its first partial line dropped. */
export function readTail(file: string): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - MAX_READ_BYTES);
		const buffer = Buffer.alloc(size - start);
		const read = readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, read).toString("utf-8");
		if (start === 0) return text;
		const newline = text.indexOf("\n");
		return newline === -1 ? "" : text.slice(newline + 1);
	} finally {
		closeSync(fd);
	}
}

export interface SignatureTally {
	signature: string;
	category: string;
	/** The newest wording, as people last saw it. */
	title: string;
	accepted: number;
	rejected: number;
	notApplicable: number;
	reasons: Partial<Record<ReviewFeedbackReason, number>>;
}

/** Votes per signature, whatever the threshold. */
export function tallyBySignature(
	records: readonly FeedbackRecord[],
): Map<string, SignatureTally> {
	const tallies = new Map<string, SignatureTally>();
	for (const record of records) {
		let tally = tallies.get(record.signature);
		if (!tally) {
			tally = {
				signature: record.signature,
				category: record.category,
				title: record.title,
				accepted: 0,
				rejected: 0,
				notApplicable: 0,
				reasons: {},
			};
			tallies.set(record.signature, tally);
		}
		if (record.verdict === "accepted") {
			tally.accepted += 1;
		} else {
			if (record.verdict === "rejected") tally.rejected += 1;
			else tally.notApplicable += 1;
			if (record.reason) {
				tally.reasons[record.reason] = (tally.reasons[record.reason] ?? 0) + 1;
			}
		}
		tally.title = record.title;
	}
	return tallies;
}

export function rejections(tally: SignatureTally): number {
	return tally.rejected + tally.notApplicable;
}

/** Rejections minus acceptances: what the threshold is compared with. */
export function net(tally: SignatureTally): number {
	return rejections(tally) - tally.accepted;
}

/** The most given reason; ties go to the first in alphabetical order. */
export function topReason(tally: SignatureTally): ReviewFeedbackReason | null {
	let best: ReviewFeedbackReason | null = null;
	let most = 0;
	for (const reason of [...REVIEW_FEEDBACK_REASONS].sort()) {
		const count = tally.reasons[reason] ?? 0;
		if (count > most) {
			best = reason;
			most = count;
		}
	}
	return best;
}

/** One line of text to show: control characters out, whitespace collapsed, bounded. */
export function displayLabel(title: string): string {
	let printable = "";
	for (const char of title) {
		printable += char < " " || char === "\u007f" ? " " : char;
	}
	return codePoints(printable.replace(/\s+/g, " ").trim(), MAX_LABEL_CHARS);
}
