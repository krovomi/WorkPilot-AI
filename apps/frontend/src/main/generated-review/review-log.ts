/**
 * The log of a generated-code card: what each page run did, in the card's
 * `task_logs.json`.
 *
 * A Kanban task gets its log from the pipeline (`task_logger/`). A card a
 * page opened never runs that pipeline, so it had no log at all: its Logs tab
 * and the Pixel Office bubble stayed on "waiting for logs" for good. Each run
 * that commits now adds its own entries to the coding phase, in the same file
 * and the same shape, so every reader of task logs (the task panel, the Pixel
 * Office, the server's log feed) shows them with nothing special to know.
 *
 * Only what the page itself saw goes in: its stage lines, the files of the
 * commit and the commit message. No prompt, no generated code, no
 * environment (S1).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TaskLogEntry, TaskLogPhase, TaskLogs } from "../../shared/types";

/** One run's log is bounded: the file is read whole by every log view. */
export const MAX_RUN_LOG_LINES = 400;
const MAX_LINE = 2000;

const LABELS = {
	en: { file: "Wrote", commit: "Commit", none: "No file changed" },
	fr: { file: "Écrit", commit: "Commit", none: "Aucun fichier modifié" },
} as const;

export interface ReviewRunLog {
	/** What the run produced, one line (the subtask's description). */
	readonly summary: string;
	readonly commitMessage: string;
	/** Files of the commit, relative to the worktree. */
	readonly files: readonly string[];
	/** The page's own progress lines, oldest first. */
	readonly lines?: readonly string[];
	readonly language: "en" | "fr";
	/** Where the entries are recorded (the card's main spec folder). */
	readonly specDir: string;
	readonly specId: string;
	readonly now?: Date;
}

function emptyPhase(phase: TaskLogPhase) {
	return { phase, status: "pending" as const, started_at: null, completed_at: null, entries: [] };
}

function readLogs(file: string, specId: string, now: string): TaskLogs {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TaskLogs>;
		if (parsed && typeof parsed === "object" && parsed.phases) {
			return {
				spec_id: typeof parsed.spec_id === "string" ? parsed.spec_id : specId,
				created_at: typeof parsed.created_at === "string" ? parsed.created_at : now,
				updated_at: now,
				phases: {
					planning: parsed.phases.planning ?? emptyPhase("planning"),
					coding: parsed.phases.coding ?? emptyPhase("coding"),
					validation: parsed.phases.validation ?? emptyPhase("validation"),
				},
			};
		}
	} catch {
		// No log yet, or one we cannot read: start a new one.
	}
	return {
		spec_id: specId,
		created_at: now,
		updated_at: now,
		phases: {
			planning: emptyPhase("planning"),
			coding: emptyPhase("coding"),
			validation: emptyPhase("validation"),
		},
	};
}

function clip(text: string): string {
	const flat = text.replace(/\s+$/u, "");
	return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

/** Add one run to the card's log. Never throws: the commit is what matters. */
export function appendReviewRunLog(run: ReviewRunLog): boolean {
	const file = path.join(run.specDir, "task_logs.json");
	const now = (run.now ?? new Date()).toISOString();
	const labels = LABELS[run.language];
	try {
		const logs = readLogs(file, run.specId, now);
		const entry = (type: TaskLogEntry["type"], content: string): TaskLogEntry => ({
			timestamp: now,
			type,
			content: clip(content),
			phase: "coding",
		});
		const entries: TaskLogEntry[] = [entry("phase_start", run.summary)];
		const lines = (run.lines ?? [])
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(-MAX_RUN_LOG_LINES);
		for (const line of lines) entries.push(entry("text", line));
		if (run.files.length === 0) entries.push(entry("info", labels.none));
		for (const changed of run.files) entries.push(entry("info", `${labels.file} ${changed}`));
		const separator = run.language === "fr" ? " : " : ": ";
		entries.push(entry("success", `${labels.commit}${separator}${run.commitMessage}`));
		entries.push(entry("phase_end", run.summary));

		const coding = logs.phases.coding;
		logs.phases.coding = {
			...coding,
			status: "completed",
			started_at: coding.started_at ?? now,
			completed_at: now,
			entries: [...(coding.entries ?? []), ...entries],
		};
		writeFileSync(file, JSON.stringify(logs, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}
