/**
 * Flaky Test Detective — Types for flaky test analysis.
 */

export type FlakyCause =
	| "timing"
	| "test_order"
	| "network"
	| "shared_state"
	| "concurrency"
	| "resource_leak"
	| "randomness"
	| "environment"
	| "unknown";

export type FlakyConfidence = "high" | "medium" | "low";

/** The test commands the detective knows how to make write a report. */
export const FLAKY_COMMAND_IDS = [
	"dotnet",
	"pytest",
	"vitest",
	"jest",
	"maven",
	"gradle",
	"go",
] as const;
export type FlakyCommandId = (typeof FLAKY_COMMAND_IDS)[number];

/** Bounds of a run request, checked again in the main process. */
export const FLAKY_MIN_RUNS = 2;
export const FLAKY_MAX_RUNS = 20;

export interface DetectedTestCommand {
	id: FlakyCommandId;
	label: string;
	command: string;
}

export interface FlakyTest {
	testName: string;
	totalRuns: number;
	failures: number;
	flakinessRate: number;
	probableCause: FlakyCause;
	confidence: FlakyConfidence;
	errorPatterns: string[];
	suggestedFix: string;
}

export interface FlakyReport {
	totalTests: number;
	flakyCount: number;
	flakyTests: FlakyTest[];
	/** English summary, kept for older readers; the view words it itself. */
	summary: string;
	/** Older reports (and the server's last saved one) may lack the rest. */
	summaryCode?: "no_reports" | "no_flaky" | "flaky";
	mode?: "scan" | "run";
	runCount?: number;
	reportCount?: number;
	minRuns?: number;
	command?: string;
	alwaysFailing?: string[];
	detectedCommands?: DetectedTestCommand[];
}

export interface FlakyRunOptions {
	projectPath: string;
	/** scan: read existing reports (default); run: run the suite N times. */
	mode?: "scan" | "run";
	runs?: number;
	/**
	 * A command the runner detects; "auto" (default) takes the first one. The
	 * renderer names a command, it never sends a command line.
	 */
	commandId?: FlakyCommandId | "auto";
}

export interface FlakyDetectResult {
	commands: DetectedTestCommand[];
	/** A server project: its tests run on the server, the command is detected there. */
	remote: boolean;
}

/** One finished run, as the progress events report it. */
export interface FlakyRunProgress {
	run: number;
	passed: number;
	failed: number;
	exitCode: number | null;
	timedOut: boolean;
	durationS: number;
}
