/**
 * The project's dataset of feedback on PR review findings (#361):
 * `<project>/.workpilot/code_review_feedback.jsonl`, one JSON line per click.
 *
 * This module is its only writer. The backend reads it
 * (`apps/backend/learning_loop/review_feedback.py`) and turns repeated
 * rejections into learned suppressions; the line shape (`v: 1`) is shared.
 *
 * The renderer is not trusted (S6): it names a finding by id, never its
 * category, severity or title. Those are read here from the review the runner
 * saved (`.workpilot/github/pr/review_<n>.json`), so a compromised view cannot
 * teach the reviewer to drop a kind of finding that was never reviewed. Every
 * path is resolved inside the project, links included, and the file is
 * refused when it is a link.
 */

import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	REVIEW_FEEDBACK_NOTE_MAX,
	REVIEW_FEEDBACK_REASONS,
	REVIEW_FEEDBACK_VERDICTS,
	type ReviewFeedbackMap,
	type ReviewFeedbackReason,
	type ReviewFeedbackResult,
	type ReviewFeedbackVerdict,
} from "../../../shared/types/review-feedback";
import { resolveUnder, resolveWritableUnder } from "../../security/renderer-path";

export const FEEDBACK_RELATIVE_PATH = path.join(
	".workpilot",
	"code_review_feedback.jsonl",
);
export const SCHEMA_VERSION = 1;
/** Past this size the file is rewritten with its newest lines only. */
export const MAX_FILE_BYTES = 1_000_000;
export const KEEP_LINES_ON_COMPACT = 2_000;
const MAX_TITLE_CHARS = 300;

const FINDING_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CATEGORY = /^[a-z_]{1,32}$/;
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export interface ValidFeedback {
	prNumber: number;
	findingId: string;
	verdict: ReviewFeedbackVerdict;
	reason: ReviewFeedbackReason | null;
	note: string;
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

export function isPrNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value < 1_000_000_000
	);
}

/** Control characters out, whitespace collapsed, bounded. */
function cleanNote(value: string): string {
	let printable = "";
	for (const char of value) {
		// A control character sorts below the space; DEL is the one above.
		printable += char < " " || char === "\u007f" ? " " : char;
	}
	return printable.replace(/\s+/g, " ").trim();
}

/**
 * The renderer's arguments, checked one by one. `null` refuses the whole
 * call: an unknown verdict or reason, an id that is not an id, a note too long.
 * A reason only goes with a rejection; on an acceptance it is dropped.
 */
export function validateFeedback(
	prNumber: unknown,
	input: unknown,
): ValidFeedback | null {
	if (!isPrNumber(prNumber)) return null;
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return null;
	}
	const { findingId, verdict, reason, note } = input as Record<
		string,
		unknown
	>;
	if (typeof findingId !== "string" || !FINDING_ID.test(findingId)) return null;
	if (!isVerdict(verdict)) return null;
	if (reason !== undefined && reason !== null && !isReason(reason)) return null;
	if (note !== undefined && typeof note !== "string") return null;
	if (typeof note === "string" && note.length > REVIEW_FEEDBACK_NOTE_MAX) {
		return null;
	}
	const rejecting = verdict !== "accepted";
	return {
		prNumber,
		findingId,
		verdict,
		reason: rejecting && isReason(reason) ? reason : null,
		note: rejecting && typeof note === "string" ? cleanNote(note) : "",
	};
}

interface ReviewedFinding {
	category: string;
	severity: string;
	title: string;
}

/** The finding as the runner saved it, or `null` when it is not there. */
export function findReviewedFinding(
	projectPath: string,
	prNumber: number,
	findingId: string,
): ReviewedFinding | null {
	const reviewPath = resolveUnder(
		projectPath,
		path.join(".workpilot", "github", "pr", `review_${prNumber}.json`),
		"file",
	);
	if (!reviewPath) return null;
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(reviewPath, "utf-8"));
	} catch {
		return null;
	}
	const findings = (data as { findings?: unknown })?.findings;
	if (!Array.isArray(findings)) return null;
	for (const raw of findings) {
		if (typeof raw !== "object" || raw === null) continue;
		const finding = raw as Record<string, unknown>;
		if (finding.id !== findingId) continue;
		const { category, severity, title } = finding;
		if (
			typeof category !== "string" ||
			!CATEGORY.test(category) ||
			typeof severity !== "string" ||
			!SEVERITIES.has(severity) ||
			typeof title !== "string" ||
			!title.trim()
		) {
			return null;
		}
		return { category, severity, title: title.slice(0, MAX_TITLE_CHARS) };
	}
	return null;
}

/** The dataset's path in the project, or `null` when it would leave it or is a link. */
export function feedbackFilePath(projectPath: string): string | null {
	// The link is refused before it is resolved: resolving it would name its
	// target, which may be any file of the project.
	try {
		if (
			lstatSync(path.join(projectPath, FEEDBACK_RELATIVE_PATH)).isSymbolicLink()
		) {
			return null;
		}
	} catch {
		// Not created yet.
	}
	return resolveWritableUnder(projectPath, FEEDBACK_RELATIVE_PATH);
}

function compact(file: string): void {
	const lines = readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim());
	const kept = lines.slice(-KEEP_LINES_ON_COMPACT);
	// A new name each time, created only if nothing is there yet.
	const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	writeFileSync(temp, `${kept.join("\n")}\n`, { encoding: "utf-8", flag: "wx" });
	renameSync(temp, file);
}

/** Append one validated line. The verdicts of the PR come back for the view. */
export function recordFeedback(
	projectPath: string,
	feedback: ValidFeedback,
	now: () => Date = () => new Date(),
): ReviewFeedbackResult {
	const finding = findReviewedFinding(
		projectPath,
		feedback.prNumber,
		feedback.findingId,
	);
	if (!finding) return { success: false, error: "not_found" };
	const file = feedbackFilePath(projectPath);
	if (!file) return { success: false, error: "write_failed" };
	const line = JSON.stringify({
		v: SCHEMA_VERSION,
		at: now().toISOString(),
		pr: feedback.prNumber,
		finding_id: feedback.findingId,
		verdict: feedback.verdict,
		reason: feedback.reason,
		note: feedback.note,
		category: finding.category,
		severity: finding.severity,
		title: finding.title,
	});
	try {
		// `.workpilot` was resolved above: a link out of the project is refused.
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, `${line}\n`, "utf-8");
		if (lstatSync(file).size > MAX_FILE_BYTES) compact(file);
	} catch {
		return { success: false, error: "write_failed" };
	}
	return { success: true, feedback: readFeedback(projectPath, feedback.prNumber) };
}

/** The latest verdict per finding of `prNumber`. Empty on anything unreadable. */
export function readFeedback(
	projectPath: string,
	prNumber: number,
): ReviewFeedbackMap {
	const result: ReviewFeedbackMap = {};
	const file = feedbackFilePath(projectPath);
	if (!file) return result;
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return result;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			record?.v === SCHEMA_VERSION &&
			record.pr === prNumber &&
			typeof record.finding_id === "string" &&
			FINDING_ID.test(record.finding_id) &&
			isVerdict(record.verdict)
		) {
			result[record.finding_id] = record.verdict;
		}
	}
	return result;
}
