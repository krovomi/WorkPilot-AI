import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { MODEL_ID_MAP } from "../shared/constants";
import type { AppSettings } from "../shared/types";

const SENTINEL = "__ARCH_VIZ_RESULT__:";

/** One thing the runtime needs, and the sentence that fixes it when it is missing. */
export interface ArchifyCondition {
	name: string;
	ok: boolean;
	detail: string;
	remedy: string;
	blocking: boolean;
}

export interface ArchifyReadiness {
	ok: boolean;
	node: string | null;
	archifyRoot: string | null;
	conditions: ArchifyCondition[];
}

/** The baseline model of a project, when one has been authored. */
export interface ArchitectureBaseline {
	path: string;
	artifact?: string;
	title?: string;
	components?: number;
	connections?: number;
	revision?: string | null;
	error?: string;
}

/**
 * The six states a task's architecture delta can be in.
 *
 * Five of them are not "here is a delta", and that ratio is the design: the
 * tab renders nothing at all for `not-significant` and for a mapped delta whose
 * counters are all zero.
 */
export type ArchitectureDeltaState =
	| "mapped"
	| "not-significant"
	| "no-baseline"
	| "unreliable-ids"
	| "runtime-missing"
	| "failed";

export interface ArchitectureDeltaSummary {
	components?: Record<string, number>;
	connections?: Record<string, number>;
	boundaries?: Record<string, number>;
	presentationChanged?: boolean;
	provenanceChanged?: boolean;
}

export interface ArchitectureDeltaStatus {
	status: ArchitectureDeltaState;
	reason: string;
	baselineRevision: string | null;
	headRevision: string | null;
	summary: ArchitectureDeltaSummary;
	continuity: {
		reliable?: boolean;
		ratio?: number;
		kept?: number;
		total?: number;
		lost?: string[];
	};
	artifact: string | null;
	receipt: string | null;
	generatedAt: string;
	hasChanges: boolean;
}

/** Whatever the runner emitted on its sentinel line, by action. */
export interface ArchitectureVisualizerResult {
	status: "success" | "error" | "cancelled";
	action?: "map" | "delta" | "doctor";
	error?: string;
	readiness?: ArchifyReadiness;
	baseline?: ArchitectureBaseline | null;
	archify?: string[];
	/** `map` only. */
	specPath?: string | null;
	artifactPath?: string | null;
	components?: number;
	connections?: number;
	title?: string;
	rounds?: number;
	diagnostics?: Array<Record<string, unknown>>;
	/**
	 * `delta` only — the record as it was written to disk.
	 *
	 * Nested rather than spread: the record carries its own `status` (one of the
	 * six delta states) and the envelope's `status` is transport-level
	 * success/error. Flattening them put two meanings on one key.
	 */
	delta?: ArchitectureDeltaStatus;
}

export interface ArchitectureMapRequest {
	projectDir: string;
	model?: string;
	thinkingLevel?: string;
}

export interface ArchitectureDeltaRequest {
	projectDir: string;
	specDir: string;
	changedFiles?: string[];
	taskSummary?: string;
	/** Map the task even when the change looks architecturally inert. */
	force?: boolean;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Drives `runners/architecture_visualizer_runner.py`.
 *
 * Events:
 * - `status` (string)      — a phase the UI shows
 * - `stream-chunk` (string)— the runner's own log lines
 * - `error` (string)       — the run failed
 * - `complete` (result)    — the sentinel payload
 * - `delta-status` (status)— a task's delta finished; carries the record
 */
export class ArchitectureVisualizerService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;
	private pythonPath = "python";
	private autoBuildSourcePath: string | null = null;

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) this.pythonPath = pythonPath;
		if (autoBuildSourcePath) this.autoBuildSourcePath = autoBuildSourcePath;
	}

	private getAutoBuildSourcePath(): string | null {
		if (this.autoBuildSourcePath) return this.autoBuildSourcePath;
		const possiblePaths = [
			path.join(app.getPath("userData"), "..", "auto-claude"),
			path.join(process.cwd(), "apps", "backend"),
			// Packaged: extraResources copies apps/backend to resources/backend.
			path.join(process.resourcesPath ?? "", "backend"),
		];
		for (const p of possiblePaths) {
			if (
				p &&
				existsSync(path.join(p, "runners", "architecture_visualizer_runner.py"))
			) {
				this.autoBuildSourcePath = p;
				return p;
			}
		}
		return null;
	}

	cancel(): boolean {
		if (!this.activeProcess) return false;
		this.activeProcess.kill();
		this.activeProcess = null;
		return true;
	}

	get busy(): boolean {
		return this.activeProcess !== null;
	}

	/**
	 * Whether archify can run here, plus the project's baseline if it has one.
	 *
	 * Cheap by construction — the runner reads files and asks `node --version` —
	 * so the page and the task panel can call it on every open rather than
	 * discovering the problem after a spinner.
	 */
	async doctor(projectDir: string): Promise<ArchitectureVisualizerResult> {
		return this.runOnce(["--action", "doctor", "--project-dir", projectDir], {
			quiet: true,
		});
	}

	/** Author (or re-author) the project's baseline model and render it. */
	async map(request: ArchitectureMapRequest): Promise<void> {
		const args = ["--action", "map", "--project-dir", request.projectDir];
		this.appendModelArgs(args, request.model, request.thinkingLevel);
		this.emit("status", "Starting architecture mapping...");
		await this.run(args);
	}

	/** Author the "after" model for one task and compare it to the baseline. */
	async delta(request: ArchitectureDeltaRequest): Promise<void> {
		const args = [
			"--action",
			"delta",
			"--project-dir",
			request.projectDir,
			"--spec-dir",
			request.specDir,
		];
		if (request.changedFiles?.length) {
			args.push("--changed-files", request.changedFiles.join("\n"));
		}
		if (request.taskSummary) args.push("--task-summary", request.taskSummary);
		if (request.force) args.push("--force");
		this.appendModelArgs(args, request.model, request.thinkingLevel);
		this.emit("status", "Comparing this task against the baseline...");
		await this.run(args);
	}

	private appendModelArgs(
		args: string[],
		model?: string,
		thinkingLevel?: string,
	): void {
		if (model) args.push("--model", MODEL_ID_MAP[model] || model);
		if (thinkingLevel) args.push("--thinking-level", thinkingLevel);
	}

	private resolveRunner(): string | null {
		const sourcePath = this.getAutoBuildSourcePath();
		if (!sourcePath) return null;
		const runnerPath = path.join(
			sourcePath,
			"runners",
			"architecture_visualizer_runner.py",
		);
		return existsSync(runnerPath) ? runnerPath : null;
	}

	private async run(args: string[]): Promise<void> {
		this.cancel();
		const runnerPath = this.resolveRunner();
		if (!runnerPath) {
			this.emit(
				"error",
				"WorkPilot AI source not found. Cannot locate architecture_visualizer_runner.py",
			);
			return;
		}
		await this.executeProcess(
			[runnerPath, ...args],
			this.buildProcessEnvironment(),
			path.dirname(path.dirname(runnerPath)),
		);
	}

	/**
	 * Run without emitting on the shared event channels.
	 *
	 * The doctor is polled by two surfaces; routing it through `status` and
	 * `complete` would make every panel open look like a generation to whoever
	 * is watching the log pane.
	 */
	private async runOnce(
		args: string[],
		options: { quiet: boolean },
	): Promise<ArchitectureVisualizerResult> {
		const runnerPath = this.resolveRunner();
		if (!runnerPath) {
			return {
				status: "error",
				error: "architecture_visualizer_runner.py not found",
			};
		}
		return new Promise((resolve) => {
			const proc = spawn(this.pythonPath, [runnerPath, ...args], {
				cwd: path.dirname(path.dirname(runnerPath)),
				env: this.buildProcessEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString("utf-8");
			});
			proc.stderr?.on("data", (d: Buffer) => {
				stderr = (stderr + d.toString("utf-8")).slice(-2000);
			});
			proc.on("error", (err) =>
				resolve({ status: "error", error: err.message }),
			);
			proc.on("close", () => {
				const parsed = this.parseSentinel(stdout);
				if (parsed) {
					resolve(parsed);
					return;
				}
				if (!options.quiet) console.error("[ArchViz]", stderr);
				resolve({
					status: "error",
					error: stderr.slice(-400) || "the runner produced no result",
				});
			});
		});
	}

	private parseSentinel(text: string): ArchitectureVisualizerResult | null {
		for (const line of text.split("\n")) {
			if (!line.startsWith(SENTINEL)) continue;
			try {
				return JSON.parse(
					line.substring(SENTINEL.length),
				) as ArchitectureVisualizerResult;
			} catch {
				// A truncated sentinel is a failed run, not a parse to retry.
			}
		}
		return null;
	}

	private buildProcessEnvironment(): Record<string, string> {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
		};
		try {
			const settingsPath = path.join(app.getPath("userData"), "settings.json");
			if (existsSync(settingsPath)) {
				const settings: AppSettings = JSON.parse(
					readFileSync(settingsPath, "utf-8"),
				);
				if (settings.globalClaudeOAuthToken)
					env.CLAUDE_OAUTH_TOKEN = settings.globalClaudeOAuthToken;
				if (settings.globalAnthropicApiKey)
					env.ANTHROPIC_API_KEY = settings.globalAnthropicApiKey;
			}
		} catch {
			/* settings are optional; the provider layer resolves its own auth */
		}
		return env;
	}

	private async executeProcess(
		args: string[],
		env: Record<string, string>,
		cwd: string,
	): Promise<void> {
		const proc = spawn(this.pythonPath, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.activeProcess = proc;

		let stderrOutput = "";
		let result: ArchitectureVisualizerResult | null = null;

		proc.stdout?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			for (const line of text.split("\n")) {
				if (line.startsWith(SENTINEL)) {
					try {
						result = JSON.parse(
							line.substring(SENTINEL.length),
						) as ArchitectureVisualizerResult;
					} catch {
						/* handled on close: no result means a failed run */
					}
				} else if (line.trim()) {
					// The runner's own lines are already written for a human.
					this.emit("status", line.trim());
					this.emit("stream-chunk", `${line}\n`);
				}
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderrOutput = (stderrOutput + data.toString("utf-8")).slice(-5000);
			console.error("[ArchViz]", data.toString("utf-8"));
		});

		proc.on("close", (code) => {
			this.activeProcess = null;
			if (!result) {
				this.emit(
					"error",
					`Architecture mapping failed (exit code ${code}). ${stderrOutput.slice(-500)}`,
				);
				return;
			}
			if (result.action === "delta" && result.delta) {
				// A delta that found nothing is a successful run with nothing to
				// show, so the record goes out either way and the UI decides.
				this.emit("delta-status", result.delta);
			}
			if (result.status === "error") {
				this.emit("error", result.error || "Architecture mapping failed");
				return;
			}
			this.emit("complete", result);
		});

		proc.on("error", (err) => {
			this.activeProcess = null;
			this.emit(
				"error",
				`Failed to start architecture visualizer: ${err.message}`,
			);
		});
	}
}

export const architectureVisualizerService =
	new ArchitectureVisualizerService();
