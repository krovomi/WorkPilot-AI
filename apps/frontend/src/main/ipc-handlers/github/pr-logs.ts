/**
 * The PR review log: parsing the runner's output into phases and entries,
 * redacting network data from it, and persisting it under .workpilot/github/.
 * Split out of pr-handlers.ts (audit lot L11, F36).
 */

import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../../shared/types";

/**
 * Sanitize network data before writing to file
 * Removes potentially dangerous characters and limits length
 */
export function sanitizeNetworkData(data: string, maxLength = 1000000): string {
	// Remove null bytes and other control characters except newlines/tabs/carriage returns
	// Using code points instead of escape sequences to avoid no-control-regex ESLint rule
	const controlCharsPattern = new RegExp(
		"[" +
			String.fromCharCode(
				0x00,
				0x01,
				0x02,
				0x03,
				0x04,
				0x05,
				0x06,
				0x07,
				0x08,
			) + // \x00-\x08
			String.fromCharCode(0x0b, 0x0c) + // \x0B, \x0C (skip \x0A which is newline)
			String.fromCharCode(
				0x0e,
				0x0f,
				0x10,
				0x11,
				0x12,
				0x13,
				0x14,
				0x15,
				0x16,
				0x17,
				0x18,
				0x19,
				0x1a,
				0x1b,
				0x1c,
				0x1d,
				0x1e,
				0x1f,
			) + // \x0E-\x1F
			String.fromCharCode(0x7f) + // \x7F (DEL)
			"]",
		"g",
	);
	let sanitized = data.replace(controlCharsPattern, "");

	// Limit length to prevent DoS
	if (sanitized.length > maxLength) {
		sanitized = sanitized.substring(0, maxLength);
	}

	return sanitized;
}

/**
 * Get the GitHub directory for a project
 */
export function getGitHubDir(project: Project): string {
	return path.join(project.path, ".workpilot", "github");
}

/**
 * PR log phase type
 */
export type PRLogPhase = "context" | "analysis" | "synthesis";

/**
 * PR log entry type
 */
export type PRLogEntryType =
	| "text"
	| "tool_start"
	| "tool_end"
	| "phase_start"
	| "phase_end"
	| "error"
	| "success"
	| "info";

/**
 * Single PR log entry
 */
export interface PRLogEntry {
	timestamp: string;
	type: PRLogEntryType;
	content: string;
	phase: PRLogPhase;
	source?: string;
	detail?: string;
	collapsed?: boolean;
}

/**
 * Phase log with entries
 */
export interface PRPhaseLog {
	phase: PRLogPhase;
	status: "pending" | "active" | "completed" | "failed";
	started_at: string | null;
	completed_at: string | null;
	entries: PRLogEntry[];
}

/**
 * Complete PR logs structure
 */
export interface PRLogs {
	pr_number: number;
	repo: string;
	created_at: string;
	updated_at: string;
	is_followup: boolean;
	phases: {
		context: PRPhaseLog;
		analysis: PRPhaseLog;
		synthesis: PRPhaseLog;
	};
}

/**
 * Parse a log line and extract source and content
 * Returns null if line is not a log line
 */
export function parseLogLine(
	line: string,
): { source: string; content: string; isError: boolean } | null {
	// Match patterns like [Context], [AI], [Orchestrator], [Followup], [DEBUG ...], [ParallelFollowup], [BotDetector], [ParallelOrchestrator]
	const patterns = [
		/^\[Context\]\s*(.*)$/,
		/^\[AI\]\s*(.*)$/,
		/^\[Orchestrator\]\s*(.*)$/,
		/^\[Followup\]\s*(.*)$/,
		/^\[ParallelFollowup\]\s*(.*)$/,
		/^\[ParallelOrchestrator\]\s*(.*)$/,
		/^\[BotDetector\]\s*(.*)$/,
		/^\[PR Review Engine\]\s*(.*)$/,
		/^\[DEBUG\s+(\w+)\]\s*(.*)$/,
		/^\[ERROR\s+(\w+)\]\s*(.*)$/,
	];

	// Check for specialist agent logs first (Agent:agent-name format)
	const agentMatch = line.match(/^\[Agent:([\w-]+)\]\s*(.*)$/);
	if (agentMatch) {
		return {
			source: `Agent:${agentMatch[1]}`,
			content: agentMatch[2],
			isError: false,
		};
	}

	// Check for parallel SDK specialist logs (Specialist:name format)
	const specialistMatch = line.match(/^\[Specialist:([\w-]+)\]\s*(.*)$/);
	if (specialistMatch) {
		return {
			source: `Specialist:${specialistMatch[1]}`,
			content: specialistMatch[2],
			isError: false,
		};
	}

	for (const pattern of patterns) {
		const match = line.match(pattern);
		if (match) {
			const isDebugOrError =
				pattern.source.includes("DEBUG") || pattern.source.includes("ERROR");
			if (isDebugOrError && match.length >= 3) {
				// Skip debug messages that only show message types (not useful)
				if (match[2].match(/^Message #\d+: \w+Message/)) {
					return null;
				}
				return {
					source: match[1],
					content: match[2],
					isError: pattern.source.includes("ERROR"),
				};
			}
			const source = line.match(/^\[(\w+(?:\s+\w+)*)\]/)?.[1] || "Unknown";
			return {
				source,
				content: match[1] || line,
				isError: false,
			};
		}
	}

	// Check for PR progress messages [PR #XXX] [YY%] message
	const prProgressMatch = line.match(/^\[PR #\d+\]\s*\[\s*(\d+)%\]\s*(.*)$/);
	if (prProgressMatch) {
		return {
			source: "Progress",
			content: `[${prProgressMatch[1]}%] ${prProgressMatch[2]}`,
			isError: false,
		};
	}

	// Check for progress messages [XX%]
	const progressMatch = line.match(/^\[(\d+)%\]\s*(.*)$/);
	if (progressMatch) {
		return {
			source: "Progress",
			content: `[${progressMatch[1]}%] ${progressMatch[2]}`,
			isError: false,
		};
	}

	// Match final summary lines (Status:, Summary:, Findings:, etc.)
	const summaryPatterns = [
		/^(Status|Summary|Findings|Verdict|Is Follow-up|Resolved|Still Open|New Issues):\s*(.*)$/,
		/^PR #\d+ (Follow-up )?Review Complete$/,
		/^={10,}$/,
		/^-{10,}$/,
		// Markdown headers (## Summary, ### Resolution Status, etc.)
		/^#{1,4}\s+.+$/,
		// Bullet points with content (- ✅ **Resolved**, - **Blocking Issues**, etc.)
		/^[-*]\s+.+$/,
		// Indented bullet points for findings (  - [MEDIUM] ..., . [LOW] ...)
		/^\s+[-.*]\s+\[.+$/,
		// Lines with bold text at start (**Why NEEDS_REVISION:**, **Recommended Actions:**)
		/^\*\*.+\*\*:?\s*$/,
		// Numbered list items (1. Add DANGEROUS_FLAGS...)
		/^\d+\.\s+.+$/,
		// File references (File: apps/backend/...)
		/^\s+File:\s+.+$/,
	];
	for (const pattern of summaryPatterns) {
		const match = line.match(pattern);
		if (match) {
			return {
				source: "Summary",
				content: line,
				isError: false,
			};
		}
	}

	return null;
}

/**
 * Determine the phase from source
 */
export function getPhaseFromSource(source: string): PRLogPhase {
	// Context phase: gathering PR data, commits, files, feedback
	// Note: "Followup" is context gathering for follow-up reviews (comparing commits, finding changes)
	const contextSources = ["Context", "BotDetector", "Followup"];
	// Analysis phase: AI agents analyzing code
	const analysisSources = [
		"AI",
		"Orchestrator",
		"ParallelOrchestrator",
		"ParallelFollowup",
		"orchestrator",
		"PRReview", // Worktree creation and PR-specific analysis
		"ClientCache", // SDK client cache operations
	];
	// Synthesis phase: final summary and results
	// Note: "Progress" logs are redundant (shown in progress bar) but kept for completeness
	const synthesisSources = ["PR Review Engine", "Summary", "Progress"];

	if (contextSources.includes(source)) return "context";
	if (analysisSources.includes(source)) return "analysis";
	// Specialist agents (Agent:xxx and Specialist:xxx) are part of analysis phase
	if (source.startsWith("Agent:")) return "analysis";
	if (source.startsWith("Specialist:")) return "analysis";
	if (synthesisSources.includes(source)) return "synthesis";
	return "synthesis"; // Default to synthesis for unknown sources
}

/**
 * Create empty PR logs structure
 */
export function createEmptyPRLogs(
	prNumber: number,
	repo: string,
	isFollowup: boolean,
): PRLogs {
	const now = new Date().toISOString();
	const createEmptyPhase = (phase: PRLogPhase): PRPhaseLog => ({
		phase,
		status: "pending",
		started_at: null,
		completed_at: null,
		entries: [],
	});

	return {
		pr_number: prNumber,
		repo,
		created_at: now,
		updated_at: now,
		is_followup: isFollowup,
		phases: {
			context: createEmptyPhase("context"),
			analysis: createEmptyPhase("analysis"),
			synthesis: createEmptyPhase("synthesis"),
		},
	};
}

/**
 * Get PR logs file path
 */
export function getPRLogsPath(project: Project, prNumber: number): string {
	return path.join(getGitHubDir(project), "pr", `logs_${prNumber}.json`);
}

/**
 * Load PR logs from disk
 */
export function loadPRLogs(project: Project, prNumber: number): PRLogs | null {
	const logsPath = getPRLogsPath(project, prNumber);

	try {
		const rawData = fs.readFileSync(logsPath, "utf-8");
		const sanitizedData = sanitizeNetworkData(rawData);
		return JSON.parse(sanitizedData) as PRLogs;
	} catch {
		return null;
	}
}

/**
 * Save PR logs to disk
 */
export function savePRLogs(project: Project, logs: PRLogs): void {
	const logsPath = getPRLogsPath(project, logs.pr_number);
	const prDir = path.dirname(logsPath);

	if (!fs.existsSync(prDir)) {
		fs.mkdirSync(prDir, { recursive: true });
	}

	logs.updated_at = new Date().toISOString();
	fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2), "utf-8");
}

/**
 * Add a log entry to PR logs
 * Returns true if the phase status changed (for triggering immediate save)
 */
export function addLogEntry(logs: PRLogs, entry: PRLogEntry): boolean {
	const phase = logs.phases[entry.phase];
	let statusChanged = false;

	// Start the phase if it was pending
	if (phase.status === "pending") {
		phase.status = "active";
		phase.started_at = entry.timestamp;
		statusChanged = true;
	}

	phase.entries.push(entry);
	return statusChanged;
}

/**
 * PR Log Collector - collects logs during review
 * Saves incrementally to disk so frontend can stream logs in real-time
 */
export class PRLogCollector {
	private logs: PRLogs;
	private project: Project;
	private currentPhase: PRLogPhase = "context";
	private entryCount: number = 0;
	private saveInterval: number = 3; // Save every N entries for real-time streaming

	constructor(
		project: Project,
		prNumber: number,
		repo: string,
		isFollowup: boolean,
	) {
		this.project = project;
		this.logs = createEmptyPRLogs(prNumber, repo, isFollowup);
		// Save initial empty logs so frontend sees the structure immediately
		this.save();
	}

	processLine(line: string): void {
		const parsed = parseLogLine(line);
		if (!parsed) return;

		const phase = getPhaseFromSource(parsed.source);

		// Track phase transitions - mark previous phases as complete (only if they were active)
		if (phase !== this.currentPhase) {
			// When moving to a new phase, mark the previous phase as complete
			// Only mark complete if the phase was actually active (received log entries)
			// This prevents marking phases as "completed" if they were skipped
			if (
				this.currentPhase === "context" &&
				(phase === "analysis" || phase === "synthesis")
			) {
				if (this.logs.phases.context.status === "active") {
					this.markPhaseComplete("context", true);
				}
			}
			if (this.currentPhase === "analysis" && phase === "synthesis") {
				if (this.logs.phases.analysis.status === "active") {
					this.markPhaseComplete("analysis", true);
				}
			}
			this.currentPhase = phase;
		}

		const entry: PRLogEntry = {
			timestamp: new Date().toISOString(),
			type: parsed.isError ? "error" : "text",
			content: parsed.content,
			phase,
			source: parsed.source,
		};

		const phaseStatusChanged = addLogEntry(this.logs, entry);
		this.entryCount++;

		// Save immediately if phase status changed (so frontend sees phase activation)
		// OR save periodically for real-time streaming (every N entries)
		if (phaseStatusChanged || this.entryCount % this.saveInterval === 0) {
			this.save();
		}
	}

	markPhaseComplete(phase: PRLogPhase, success: boolean): void {
		const phaseLog = this.logs.phases[phase];
		phaseLog.status = success ? "completed" : "failed";
		phaseLog.completed_at = new Date().toISOString();
		// Save immediately so frontend sees the status change
		this.save();
	}

	save(): void {
		savePRLogs(this.project, this.logs);
	}

	finalize(success: boolean): void {
		// Mark active phases as completed based on success status
		// Pending phases with no entries should stay pending (they never ran)
		for (const phase of ["context", "analysis", "synthesis"] as PRLogPhase[]) {
			const phaseLog = this.logs.phases[phase];
			if (phaseLog.status === "active") {
				this.markPhaseComplete(phase, success);
			}
			// Note: Pending phases stay pending - they never received any log entries
			// This is correct behavior for follow-up reviews where some phases may be skipped
		}
		this.save();
	}
}
