/**
 * The render loop's figures on one project (#379), kept on this computer.
 *
 * Two journals under `.workpilot/design-to-code/`, one JSON line each:
 * `loop-history.jsonl` gets a line per loop that ran (its status, the score
 * it kept, its corrections, its route), and `writes.jsonl` a line per write
 * that reached a review card (the card and the SHA-256 of each file as it was
 * written). Nothing leaves the machine: no telemetry, no server route (server
 * mode has no Import Design).
 *
 * "Accepted without retouch" is an approximation, read later: a write is
 * `kept` when every file in the project folder still has the hash it was
 * written with, `pending` when they only match on the card's branch (its
 * worktree is still there and nothing is merged into the folder yet), and
 * `retouched` otherwise. So a file changed after the merge for another reason
 * counts as retouched, a merge not pulled into this checkout counts as pending
 * (or retouched once its worktree is gone), and a discarded card as
 * retouched.
 *
 * Both files live in a project folder, which is not trusted: each path is
 * resolved inside the project (links included), each line is checked field
 * by field, and only the last lines are read.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import type {
	DesignLoopStats,
	DesignLoopStatus,
} from "../shared/types/design-to-code";
import { resolveWritableUnder } from "./security/renderer-path";
import { findTaskWorktree } from "./worktree-paths";

const FOLDER = ".workpilot/design-to-code";
export const LOOP_HISTORY = `${FOLDER}/loop-history.jsonl`;
export const WRITE_HISTORY = `${FOLDER}/writes.jsonl`;
/** Lines read back from each journal: the most recent ones. */
const MAX_LOOPS = 500;
const MAX_WRITES = 50;
/** Files of one write compared, and the size of a file read for its hash. */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
/** A journal larger than this is read from its end only. */
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

const RAN: readonly DesignLoopStatus[] = [
	"converged",
	"max_iterations",
	"budget",
	"stalled",
	"failed",
];
const ROUTE = /^[a-z][a-z.-]{0,39}$/;
const SPEC_ID = /^[\w.-]{1,120}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface LoopLine {
	at: string;
	status: DesignLoopStatus;
	best_score: number;
	iterations: number;
	route: string;
}

export interface WriteLine {
	at: string;
	specId: string;
	files: { path: string; sha256: string }[];
}

export function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Append one line, through one descriptor that never follows a link. */
function appendLine(projectDir: string, relative: string, line: object): void {
	const target = resolveWritableUnder(projectDir, relative);
	if (!target) return;
	mkdirSync(path.dirname(target), { recursive: true });
	// The folder is created now: check again that it stayed in the project.
	if (resolveWritableUnder(projectDir, relative) !== target) return;
	const fd = openSync(
		target,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_APPEND |
			(constants.O_NOFOLLOW ?? 0),
		0o644,
	);
	try {
		if (fstatSync(fd).isFile()) writeSync(fd, `${JSON.stringify(line)}\n`);
	} finally {
		closeSync(fd);
	}
}

/** The last `max` parsed lines of a journal ([] when it cannot be read). */
function readLines(projectDir: string, relative: string, max: number): unknown[] {
	const target = resolveWritableUnder(projectDir, relative);
	if (!target) return [];
	let text: string;
	try {
		const raw = readFileSync(target);
		text = raw.subarray(Math.max(0, raw.length - MAX_JOURNAL_BYTES)).toString("utf-8");
	} catch {
		return [];
	}
	const parsed: unknown[] = [];
	for (const line of text.split("\n").slice(-max - 1)) {
		if (!line.trim()) continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			/* a cut or hand-edited line is left out */
		}
	}
	return parsed.slice(-max);
}

/** The journal line of a loop report, or null when the loop did not run. */
export function loopLine(report: unknown, now: Date = new Date()): LoopLine | null {
	if (!isRecord(report)) return null;
	const status = report.status as DesignLoopStatus;
	const iterations = Array.isArray(report.iterations) ? report.iterations : [];
	if (!RAN.includes(status) || iterations.length === 0) return null;
	const best = Number.isInteger(report.best_iteration) ? (report.best_iteration as number) : 0;
	const kept = iterations[best];
	const score = isRecord(kept) ? kept.score : undefined;
	if (!finite(score)) return null;
	const route = typeof report.route === "string" && ROUTE.test(report.route) ? report.route : "";
	return {
		at: now.toISOString(),
		status,
		best_score: Math.min(1, Math.max(0, score)),
		// Version 0 is the generated code: the others are corrections.
		iterations: iterations.length - 1,
		route,
	};
}

/** Record a loop that ran on the project. Never throws: figures are a bonus. */
export function recordLoop(projectDir: string, report: unknown): void {
	const line = loopLine(report);
	if (!line) return;
	try {
		appendLine(projectDir, LOOP_HISTORY, line);
	} catch {
		/* a read-only project keeps no figures */
	}
}

/** Record the hash of each file written on the card `specId`. Never throws. */
export function recordWrite(
	projectDir: string,
	specId: string,
	files: { path: string; content: string }[],
	now: Date = new Date(),
): void {
	if (!SPEC_ID.test(specId) || files.length === 0) return;
	const line: WriteLine = {
		at: now.toISOString(),
		specId,
		files: files.slice(0, MAX_FILES).map((f) => ({ path: f.path, sha256: sha256(f.content) })),
	};
	try {
		appendLine(projectDir, WRITE_HISTORY, line);
	} catch {
		/* a read-only project keeps no figures */
	}
}

function asLoop(value: unknown): LoopLine | null {
	if (!isRecord(value)) return null;
	const { status, best_score, iterations } = value;
	if (!RAN.includes(status as DesignLoopStatus)) return null;
	if (!finite(best_score) || best_score < 0 || best_score > 1) return null;
	if (!Number.isInteger(iterations) || (iterations as number) < 0) return null;
	return value as unknown as LoopLine;
}

function asWrite(value: unknown): WriteLine | null {
	if (!isRecord(value) || typeof value.specId !== "string" || !SPEC_ID.test(value.specId)) {
		return null;
	}
	if (!Array.isArray(value.files) || value.files.length === 0) return null;
	const files = value.files.slice(0, MAX_FILES);
	const valid = files.every(
		(f) => isRecord(f) && typeof f.path === "string" && f.path && typeof f.sha256 === "string" && SHA256.test(f.sha256),
	);
	return valid ? (value as unknown as WriteLine) : null;
}

/** Whether every file under `root` still has the hash it was written with. */
function unchangedUnder(root: string, files: WriteLine["files"]): boolean {
	return files.slice(0, MAX_FILES).every((file) => {
		const target = resolveWritableUnder(root, file.path);
		if (!target) return false;
		try {
			const content = readFileSync(target);
			return content.length <= MAX_FILE_BYTES && sha256(content) === file.sha256;
		} catch {
			return false;
		}
	});
}

const mean = (values: number[]): number | null =>
	values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** The project's figures, from its two journals. */
export function loopStats(projectDir: string | null): DesignLoopStats {
	const stats: DesignLoopStats = {
		loops: 0,
		converged: 0,
		averageScore: null,
		averageIterations: null,
		writes: 0,
		kept: 0,
		pending: 0,
		retouched: 0,
	};
	if (!projectDir) return stats;
	const loops = readLines(projectDir, LOOP_HISTORY, MAX_LOOPS)
		.map(asLoop)
		.filter((l): l is LoopLine => l !== null);
	const converged = loops.filter((l) => l.status === "converged");
	stats.loops = loops.length;
	stats.converged = converged.length;
	stats.averageScore = mean(loops.map((l) => l.best_score));
	stats.averageIterations = mean(converged.map((l) => l.iterations));

	const writes = readLines(projectDir, WRITE_HISTORY, MAX_WRITES)
		.map(asWrite)
		.filter((w): w is WriteLine => w !== null);
	stats.writes = writes.length;
	for (const write of writes) {
		if (unchangedUnder(projectDir, write.files)) {
			stats.kept += 1;
			continue;
		}
		const worktree = findTaskWorktree(projectDir, write.specId);
		if (worktree && unchangedUnder(worktree, write.files)) stats.pending += 1;
		else stats.retouched += 1;
	}
	return stats;
}
