import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_ID_MAP } from "../../shared/constants";
import type {
	InsightsChatMessage,
	InsightsChatStatus,
	InsightsModelConfig,
	InsightsStreamChunk,
	InsightsToolUsage,
} from "../../shared/types";
import {
	createSDKRateLimitInfo,
	detectRateLimit,
} from "../rate-limit-detector";
import type { InsightsConfig } from "./config";
import { chunkForLine } from "./output-lines";

/**
 * Message processor result
 */
interface ProcessorResult {
	fullResponse: string;
	suggestedTask?: InsightsChatMessage["suggestedTask"];
	toolsUsed: InsightsToolUsage[];
}

/**
 * Python process executor for insights
 * Handles spawning and managing the Python insights runner process
 */
export class InsightsExecutor extends EventEmitter {
	private config: InsightsConfig;
	private activeSessions: Map<string, ChildProcess> = new Map();

	constructor(config: InsightsConfig) {
		super();
		this.config = config;
	}

	/**
	 * Check if a session is currently active
	 */
	isSessionActive(projectId: string): boolean {
		return this.activeSessions.has(projectId);
	}

	/**
	 * Cancel an active session
	 */
	cancelSession(projectId: string): boolean {
		const existingProcess = this.activeSessions.get(projectId);
		if (!existingProcess) return false;

		existingProcess.kill();
		this.activeSessions.delete(projectId);
		return true;
	}

	/**
	 * Execute insights query
	 */
	async execute(
		projectId: string,
		projectPath: string,
		message: string,
		conversationHistory: Array<{ role: string; content: string }>,
		modelConfig?: InsightsModelConfig,
		learningMode?: { enabled: boolean; level: string },
	): Promise<ProcessorResult> {
		// Cancel any existing session
		this.cancelSession(projectId);

		const autoBuildSource = this.config.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			throw new Error("WorkPilot AI source not found");
		}

		const runnerPath = path.join(
			autoBuildSource,
			"runners",
			"insights_runner.py",
		);
		if (!existsSync(runnerPath)) {
			throw new Error("insights_runner.py not found in auto-claude directory");
		}

		// Emit thinking status
		this.emit("status", projectId, {
			phase: "thinking",
			message: "Processing your message...",
		} as InsightsChatStatus);

		// Get process environment
		const processEnv = await this.config.getProcessEnv();

		// Write conversation history to temp file to avoid Windows command-line length limit
		const historyFile = path.join(
			os.tmpdir(),
			`insights-history-${projectId}-${Date.now()}.json`,
		);

		let historyFileCreated = false;
		try {
			writeFileSync(historyFile, JSON.stringify(conversationHistory), "utf-8");
			historyFileCreated = true;
		} catch (err) {
			console.error("[Insights] Failed to write history file:", err);
			throw new Error("Failed to write conversation history to temp file");
		}

		// Build command arguments
		const args = [
			runnerPath,
			"--project-dir",
			projectPath,
			"--message",
			message,
			"--history-file",
			historyFile,
		];

		// Add model config if provided
		if (modelConfig) {
			const modelId = MODEL_ID_MAP[modelConfig.model] || MODEL_ID_MAP.sonnet;
			args.push("--model", modelId);
			args.push("--thinking-level", modelConfig.thinkingLevel);
		}

		// Add Learning Mode parameters if enabled
		if (learningMode?.enabled) {
			args.push("--learning-mode");
			args.push("--explanation-level", learningMode.level || "intermediate");
		}

		// Spawn Python process
		const proc = spawn(this.config.getPythonPath(), args, {
			cwd: autoBuildSource,
			env: processEnv,
		});

		this.activeSessions.set(projectId, proc);

		return new Promise((resolve, reject) => {
			let fullResponse = "";
			let suggestedTask: InsightsChatMessage["suggestedTask"] | undefined;
			const toolsUsed: InsightsToolUsage[] = [];
			let allInsightsOutput = "";
			let stderrOutput = "";

			proc.stdout?.on("data", (data: Buffer) => {
				const text = data.toString("utf-8");
				// Collect output for rate limit detection (keep last 10KB)
				allInsightsOutput = (allInsightsOutput + text).slice(-10000);

				// Process output lines
				for (const line of text.split("\n")) {
					const chunk = chunkForLine(line);
					if (!chunk) continue;
					if (chunk.type === "task_suggestion") {
						suggestedTask = chunk.suggestedTask;
					} else if (chunk.type === "tool_start" && chunk.tool) {
						// Accumulate tool usage for persistence
						toolsUsed.push({
							name: chunk.tool.name,
							input: chunk.tool.input,
							timestamp: new Date(),
						});
					} else if (chunk.type === "text") {
						fullResponse += chunk.content;
					}
					this.emit("stream-chunk", projectId, chunk);
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				const text = data.toString("utf-8");
				// Collect stderr for rate limit detection and error reporting
				allInsightsOutput = (allInsightsOutput + text).slice(-10000);
				stderrOutput = (stderrOutput + text).slice(-2000);
				console.error("[Insights]", text);
			});

			proc.on("close", (code) => {
				this.activeSessions.delete(projectId);

				// Cleanup temp file
				if (historyFileCreated && existsSync(historyFile)) {
					try {
						unlinkSync(historyFile);
					} catch (cleanupErr) {
						console.error(
							"[Insights] Failed to cleanup history file:",
							cleanupErr,
						);
					}
				}

				// Check for rate limit if process failed
				if (code !== 0) {
					this.handleRateLimit(projectId, allInsightsOutput);
				}

				if (code === 0) {
					this.emit("stream-chunk", projectId, {
						type: "done",
					} as InsightsStreamChunk);

					this.emit("status", projectId, {
						phase: "complete",
					} as InsightsChatStatus);

					resolve({
						fullResponse: fullResponse.trim(),
						suggestedTask,
						toolsUsed,
					});
				} else {
					// Include stderr output in error message for debugging
					const stderrSummary = stderrOutput.trim()
						? `\n\nError output:\n${stderrOutput.slice(-500)}`
						: "";
					const error = `Process exited with code ${code}${stderrSummary}`;
					this.emit("stream-chunk", projectId, {
						type: "error",
						error,
					} as InsightsStreamChunk);

					this.emit("error", projectId, error);
					reject(new Error(error));
				}
			});

			proc.on("error", (err) => {
				this.activeSessions.delete(projectId);

				// Cleanup temp file
				if (historyFileCreated && existsSync(historyFile)) {
					try {
						unlinkSync(historyFile);
					} catch (cleanupErr) {
						console.error(
							"[Insights] Failed to cleanup history file:",
							cleanupErr,
						);
					}
				}

				this.emit("error", projectId, err.message);
				reject(err);
			});
		});
	}

	/**
	 * Handle rate limit detection
	 */
	private handleRateLimit(projectId: string, output: string): void {
		const rateLimitDetection = detectRateLimit(output);
		if (rateLimitDetection.isRateLimited) {
			console.warn("[Insights] Rate limit detected:", {
				projectId,
				resetTime: rateLimitDetection.resetTime,
				limitType: rateLimitDetection.limitType,
				suggestedProfile: rateLimitDetection.suggestedProfile?.name,
			});

			const rateLimitInfo = createSDKRateLimitInfo(
				"other",
				rateLimitDetection,
				{
					projectId,
				},
			);
			this.emit("sdk-rate-limit", rateLimitInfo);
		}
	}
}
