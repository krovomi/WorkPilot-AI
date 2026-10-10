import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_ID_MAP } from "../shared/constants";
import type {
	ContextAwareSnippetResult,
	ContextAwareSnippetsError,
	ContextAwareSnippetsStatus,
	SnippetType,
} from "../shared/types/context-aware-snippets";

export type { ContextAwareSnippetResult } from "../shared/types/context-aware-snippets";

export const CONTEXT_AWARE_SNIPPETS_RUNNER = path.join(
	"runners",
	"context_aware_snippets_runner.py",
);

/**
 * One generation, as the main process hands it to the runner: the project is
 * a path here, resolved by the IPC handler from the id the renderer sent.
 */
export interface ContextAwareSnippetJob {
	projectDir: string;
	snippetType: SnippetType;
	description: string;
	language?: string;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Where and how to run the runner. Resolved by the IPC handler, which owns
 * Electron (settings, Python environment, credentials); the service only
 * spawns and parses, which is what keeps it testable.
 */
export interface ContextAwareSnippetsRuntime {
	pythonPath: string;
	backendPath: string;
	env: Record<string, string>;
}

/** One stdout line of the runner, classified. */
export type RunnerLine =
	| { kind: "status"; status: ContextAwareSnippetsStatus }
	| { kind: "delta"; text: string }
	| { kind: "result"; result: ContextAwareSnippetResult }
	| { kind: "error"; error: ContextAwareSnippetsError }
	| { kind: "log"; text: string };

const STATUS_MARKER = "__STATUS__:";
const DELTA_MARKER = "__DELTA__:";
const RESULT_MARKER = "__SNIPPET__:";
const ERROR_MARKER = "__ERROR__:";

const KNOWN_STATUSES: readonly ContextAwareSnippetsStatus[] = [
	"context",
	"generating",
	"parsing",
];

const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.map(String).filter((item) => item.trim().length > 0)
		: [];

/**
 * The runner's protocol (`apps/backend/runners/context_aware_snippets_runner.py`),
 * one line at a time. A malformed marker line is logged rather than trusted:
 * a half-parsed result is worse than the error the close handler will raise.
 */
export function parseRunnerLine(line: string): RunnerLine | null {
	const trimmed = line.replace(/\r$/, "");
	if (!trimmed.trim()) return null;

	try {
		if (trimmed.startsWith(STATUS_MARKER)) {
			const code = trimmed.slice(STATUS_MARKER.length).trim();
			return KNOWN_STATUSES.includes(code as ContextAwareSnippetsStatus)
				? { kind: "status", status: code as ContextAwareSnippetsStatus }
				: { kind: "log", text: trimmed };
		}
		if (trimmed.startsWith(DELTA_MARKER)) {
			const text = JSON.parse(trimmed.slice(DELTA_MARKER.length));
			return typeof text === "string" ? { kind: "delta", text } : null;
		}
		if (trimmed.startsWith(RESULT_MARKER)) {
			const raw = JSON.parse(trimmed.slice(RESULT_MARKER.length));
			if (typeof raw?.snippet !== "string" || !raw.snippet.trim()) {
				return { kind: "log", text: trimmed };
			}
			return {
				kind: "result",
				result: {
					snippet: raw.snippet,
					language: typeof raw.language === "string" ? raw.language : "",
					description:
						typeof raw.description === "string" ? raw.description : "",
					context_used: strings(raw.context_used),
					adaptations: strings(raw.adaptations),
					reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
				},
			};
		}
		if (trimmed.startsWith(ERROR_MARKER)) {
			const raw = JSON.parse(trimmed.slice(ERROR_MARKER.length));
			return {
				kind: "error",
				error: {
					code: typeof raw?.code === "string" ? raw.code : "generic",
					message: typeof raw?.message === "string" ? raw.message : "",
				},
			};
		}
	} catch {
		return { kind: "log", text: trimmed };
	}
	return { kind: "log", text: trimmed };
}

/**
 * Service for context-aware snippet generation.
 *
 * Spawns `context_aware_snippets_runner.py` and streams its output back as
 * events. It used to spawn a bare `python`, guess the backend's location,
 * read OAuth tokens out of `settings.json` itself and split stdout on chunk
 * boundaries — so a marker cut in two by the pipe was lost.
 *
 * Events emitted:
 * - 'status' (status: ContextAwareSnippetsStatus) — Phase of the run
 * - 'stream-chunk' (chunk: string) — Raw model text as it arrives
 * - 'error' (error: ContextAwareSnippetsError) — Coded, translatable failure
 * - 'complete' (result: ContextAwareSnippetResult) — Structured result
 */
export class ContextAwareSnippetsService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;

	isRunning(): boolean {
		return this.activeProcess !== null;
	}

	/**
	 * Cancel any active generation. Silent: the caller asked for it, so no
	 * error event is emitted for the exit that follows.
	 */
	cancel(): boolean {
		const proc = this.activeProcess;
		if (!proc) return false;
		this.activeProcess = null;
		proc.kill();
		return true;
	}

	/**
	 * Run one generation. A run already in flight is superseded: its process is
	 * killed and nothing it prints afterwards reaches the renderer.
	 */
	generate(
		job: ContextAwareSnippetJob,
		runtime: ContextAwareSnippetsRuntime,
	): void {
		this.cancel();

		const runnerPath = path.join(
			runtime.backendPath,
			CONTEXT_AWARE_SNIPPETS_RUNNER,
		);
		if (!existsSync(runnerPath)) {
			this.emit("error", {
				code: "runner_missing",
				message: runnerPath,
			} satisfies ContextAwareSnippetsError);
			return;
		}

		// The description goes through a file: a long one on the command line
		// hits Windows' 32k limit, and one that starts with "-" would be read by
		// argparse as an option.
		const workDir = mkdtempSync(path.join(tmpdir(), "workpilot-snippet-"));
		const descriptionFile = path.join(workDir, "description.txt");
		writeFileSync(descriptionFile, job.description, "utf-8");
		const cleanup = () => {
			try {
				rmSync(workDir, { recursive: true, force: true });
			} catch {
				// A temp file left behind is not worth an error.
			}
		};

		const args = [
			runnerPath,
			"--project-dir",
			job.projectDir,
			"--snippet-type",
			job.snippetType,
			"--description-file",
			descriptionFile,
		];
		if (job.language) {
			args.push("--language", job.language);
		}
		if (job.model) {
			args.push("--model", MODEL_ID_MAP[job.model] || job.model);
		}
		if (job.thinkingLevel) {
			args.push("--thinking-level", job.thinkingLevel);
		}

		this.emit("status", "context" satisfies ContextAwareSnippetsStatus);

		let proc: ChildProcess;
		try {
			proc = spawn(runtime.pythonPath, args, {
				cwd: runtime.backendPath,
				env: { ...runtime.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
			});
		} catch (err) {
			cleanup();
			this.emit("error", {
				code: "spawn_failed",
				message: err instanceof Error ? err.message : String(err),
			} satisfies ContextAwareSnippetsError);
			return;
		}
		this.activeProcess = proc;

		let buffer = "";
		let stderrTail = "";
		let result: ContextAwareSnippetResult | null = null;
		let reportedError: ContextAwareSnippetsError | null = null;

		const handleLine = (line: string) => {
			if (this.activeProcess !== proc) return;
			const parsed = parseRunnerLine(line);
			if (!parsed) return;
			switch (parsed.kind) {
				case "status":
					this.emit("status", parsed.status);
					break;
				case "delta":
					this.emit("stream-chunk", parsed.text);
					break;
				case "result":
					result = parsed.result;
					break;
				case "error":
					reportedError = parsed.error;
					break;
				case "log":
					console.warn("[ContextAwareSnippets]", parsed.text);
					break;
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString("utf-8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderrTail = (stderrTail + data.toString("utf-8")).slice(-4000);
		});

		proc.on("close", (code) => {
			cleanup();
			if (buffer) handleLine(buffer);
			// Cancelled, or superseded by a newer run: nobody is waiting for this one.
			if (this.activeProcess !== proc) return;
			this.activeProcess = null;

			if (result) {
				this.emit("complete", result);
				return;
			}
			if (reportedError) {
				this.emit("error", reportedError);
				return;
			}
			if (stderrTail.trim()) {
				console.error("[ContextAwareSnippets] stderr:", stderrTail);
			}
			this.emit("error", {
				code: "process_failed",
				message: `exit ${code ?? "?"}${stderrTail.trim() ? ` — ${stderrTail.trim().split("\n").slice(-3).join(" ")}` : ""}`,
			} satisfies ContextAwareSnippetsError);
		});

		proc.on("error", (err) => {
			cleanup();
			if (this.activeProcess !== proc) return;
			this.activeProcess = null;
			this.emit("error", {
				code: "spawn_failed",
				message: err.message,
			} satisfies ContextAwareSnippetsError);
		});
	}
}

// Singleton instance
export const contextAwareSnippetsService = new ContextAwareSnippetsService();
