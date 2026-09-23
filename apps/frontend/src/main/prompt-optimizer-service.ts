import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_ID_MAP } from "../shared/constants";
import type {
	PromptOptimizerAgentType,
	PromptOptimizerError,
	PromptOptimizerResult,
	PromptOptimizerStatus,
} from "../shared/types/prompt-optimizer";

export type { PromptOptimizerResult } from "../shared/types/prompt-optimizer";

export const PROMPT_OPTIMIZER_RUNNER = path.join(
	"runners",
	"prompt_optimizer_runner.py",
);

/**
 * Configuration for a prompt optimization request
 */
export interface PromptOptimizeRequest {
	projectDir: string;
	prompt: string;
	agentType: PromptOptimizerAgentType;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Where and how to run the runner. Resolved by the IPC handler, which owns
 * Electron (settings, Python environment, credentials); the service only
 * spawns and parses, which is what keeps it testable.
 */
export interface PromptOptimizerRuntime {
	pythonPath: string;
	backendPath: string;
	env: Record<string, string>;
}

/** One stdout line of the runner, classified. */
export type RunnerLine =
	| { kind: "status"; status: PromptOptimizerStatus }
	| { kind: "delta"; text: string }
	| { kind: "result"; result: PromptOptimizerResult }
	| { kind: "error"; error: PromptOptimizerError }
	| { kind: "log"; text: string };

const STATUS_MARKER = "__STATUS__:";
const DELTA_MARKER = "__DELTA__:";
const RESULT_MARKER = "__OPTIMIZED_PROMPT__:";
const ERROR_MARKER = "__ERROR__:";

const KNOWN_STATUSES: readonly PromptOptimizerStatus[] = [
	"context",
	"generating",
	"parsing",
];

/**
 * The runner's protocol (`apps/backend/runners/prompt_optimizer_runner.py`),
 * one line at a time. A malformed marker line is logged rather than trusted:
 * a half-parsed result is worse than the error the close handler will raise.
 */
export function parseRunnerLine(line: string): RunnerLine | null {
	const trimmed = line.replace(/\r$/, "");
	if (!trimmed.trim()) return null;

	try {
		if (trimmed.startsWith(STATUS_MARKER)) {
			const code = trimmed.slice(STATUS_MARKER.length).trim();
			return KNOWN_STATUSES.includes(code as PromptOptimizerStatus)
				? { kind: "status", status: code as PromptOptimizerStatus }
				: { kind: "log", text: trimmed };
		}
		if (trimmed.startsWith(DELTA_MARKER)) {
			const text = JSON.parse(trimmed.slice(DELTA_MARKER.length));
			return typeof text === "string" ? { kind: "delta", text } : null;
		}
		if (trimmed.startsWith(RESULT_MARKER)) {
			const raw = JSON.parse(trimmed.slice(RESULT_MARKER.length));
			if (typeof raw?.optimized !== "string" || !raw.optimized.trim()) {
				return { kind: "log", text: trimmed };
			}
			return {
				kind: "result",
				result: {
					optimized: raw.optimized,
					changes: Array.isArray(raw.changes) ? raw.changes.map(String) : [],
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
 * Service for AI-powered prompt optimization
 *
 * Spawns the Python prompt_optimizer_runner.py process and streams output
 * back to the renderer via events.
 *
 * Events emitted:
 * - 'status' (status: PromptOptimizerStatus) — Phase of the run
 * - 'stream-chunk' (chunk: string) — Raw model text as it arrives
 * - 'error' (error: PromptOptimizerError) — Coded, translatable failure
 * - 'complete' (result: PromptOptimizerResult) — Structured result
 */
export class PromptOptimizerService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;

	isRunning(): boolean {
		return this.activeProcess !== null;
	}

	/**
	 * Cancel any active optimization. Silent: the caller asked for it, so no
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
	 * Run prompt optimization
	 */
	optimize(
		request: PromptOptimizeRequest,
		runtime: PromptOptimizerRuntime,
	): void {
		this.cancel();

		const runnerPath = path.join(runtime.backendPath, PROMPT_OPTIMIZER_RUNNER);
		if (!existsSync(runnerPath)) {
			this.emit("error", {
				code: "runner_missing",
				message: runnerPath,
			} satisfies PromptOptimizerError);
			return;
		}

		// The prompt goes through a file: a long prompt on the command line hits
		// Windows' 32k limit, and quoting is one more thing to get wrong.
		const workDir = mkdtempSync(path.join(tmpdir(), "workpilot-prompt-"));
		const promptFile = path.join(workDir, "prompt.txt");
		writeFileSync(promptFile, request.prompt, "utf-8");
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
			request.projectDir,
			"--prompt-file",
			promptFile,
			"--agent-type",
			request.agentType,
		];
		if (request.model) {
			args.push("--model", MODEL_ID_MAP[request.model] || request.model);
		}
		if (request.thinkingLevel) {
			args.push("--thinking-level", request.thinkingLevel);
		}

		this.emit("status", "context" satisfies PromptOptimizerStatus);

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
			} satisfies PromptOptimizerError);
			return;
		}
		this.activeProcess = proc;

		let buffer = "";
		let stderrTail = "";
		let result: PromptOptimizerResult | null = null;
		let reportedError: PromptOptimizerError | null = null;

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
					console.warn("[PromptOptimizer]", parsed.text);
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
				console.error("[PromptOptimizer] stderr:", stderrTail);
			}
			this.emit("error", {
				code: "process_failed",
				message: `exit ${code ?? "?"}${stderrTail.trim() ? ` — ${stderrTail.trim().split("\n").slice(-3).join(" ")}` : ""}`,
			} satisfies PromptOptimizerError);
		});

		proc.on("error", (err) => {
			cleanup();
			if (this.activeProcess !== proc) return;
			this.activeProcess = null;
			this.emit("error", {
				code: "spawn_failed",
				message: err.message,
			} satisfies PromptOptimizerError);
		});
	}
}

// Singleton instance
export const promptOptimizerService = new PromptOptimizerService();
