/**
 * Accessibility Agent — Types for WCAG compliance scanning.
 */

export type WcagLevel = "A" | "AA" | "AAA";

export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";

export interface A11yViolation {
	ruleId: string;
	description: string;
	severity: A11ySeverity;
	wcagLevel: WcagLevel;
	wcagCriteria: string;
	file: string;
	line: number;
	element: string;
	suggestion: string;
	/** What the rule measured: a ratio, a size, the heading levels (#391). */
	detail?: string;
	/** Inside markup that may not render (v-if, *ngIf, {cond && …}). */
	conditional?: boolean;
	/** On a component imported from a package. */
	external?: boolean;
	/** The id of its one-click fix, or "" when none can be derived. */
	fixId?: string;
	fix?: { attribute: string; value: string } | null;
	/** Found in the running app (dynamic scan), not in the source. */
	dynamic?: boolean;
}

export interface A11yCriterionScore {
	criterion: string;
	name: string;
	level: WcagLevel | "";
	count: number;
	score: number;
}

export interface A11yPageScore {
	file: string;
	count: number;
	score: number;
}

export interface A11yHistoryEntry {
	at: string;
	score: number;
	targetLevel: WcagLevel;
	violations: number;
	filesScanned: number;
}

export interface A11yReport {
	filesScanned: number;
	targetLevel: WcagLevel;
	violations: A11yViolation[];
	passedRules: string[];
	summary: string;
	/** 0-100, the same formula for every scan so scans compare over time. */
	score?: number;
	criteria?: A11yCriterionScore[];
	pages?: A11yPageScore[];
	pagesWithoutLang?: string[];
	history?: A11yHistoryEntry[];
}

/** The dynamic scan of the running app (App Emulator or a localhost URL). */
export interface A11yDynamicReport {
	url: string;
	violations: A11yViolation[];
	focusStops: number;
}

export interface A11yFixRequest {
	projectPath: string;
	fixIds: string[];
	/** The language a page-lang fix declares. */
	pageLang: string;
	/** Ask the active model for alt texts instead of deriving them. */
	aiAlt: boolean;
}

export interface A11yFixOutcome {
	applied: { fixId: string; ruleId: string; file: string; line: number; attribute: string; value: string }[];
	/** Fixes asked for that the review branch no longer has (the code differs). */
	missing: string[];
	review: import("./generated-review").GeneratedReview | null;
	aiAlt: number;
}

export type A11yExportFormat = "html" | "csv" | "pdf";
