/**
 * Personal Agent Coach — Types for agent performance coaching.
 */

export type TipCategory =
	| "prompt_engineering"
	| "cost_optimisation"
	| "workflow"
	| "error_prevention"
	| "performance"
	| "best_practice";

export type TipPriority = "high" | "medium" | "low";

export interface CoachTip {
	category: TipCategory;
	priority: TipPriority;
	title: string;
	description: string;
	evidence: string;
	action: string;
}

export interface AgentRunRecord {
	agentName: string;
	runId: string;
	success: boolean;
	durationS: number;
	tokensUsed: number;
	costUsd: number;
	errors: string[];
	retries: number;
	model: string;
	timestamp: string;
}

export interface CoachReport {
	tips: CoachTip[];
	totalRuns: number;
	successRate: number;
	avgCostUsd: number;
	totalCostUsd: number;
	mostUsedModel: string;
	mostFailingAgent: string;
	summary: string;
}

/** The dimensions of a personal style profile (#376), closed lists shared with the backend. */
export const STYLE_DIMENSIONS = {
	naming_functions: ["camelCase", "snake_case", "PascalCase"],
	naming_variables: ["camelCase", "snake_case", "PascalCase"],
	name_length: ["short", "descriptive"],
	comments: ["none", "minimal", "verbose"],
	doc_comments: ["documented", "undocumented"],
	comment_language: ["en", "fr"],
	function_length: ["short", "medium", "long"],
	imports: ["named", "default", "from_import", "module_import"],
	error_handling: ["exceptions", "result_types"],
	guard_style: ["early_return", "nested"],
	assertions: ["few", "many"],
	mocking: ["framework", "manual"],
} as const;

export type StyleDimension = keyof typeof STYLE_DIMENSIONS;

export const STYLE_LANGUAGES = [
	"python",
	"javascript",
	"typescript",
	"csharp",
	"java",
	"kotlin",
	"go",
	"rust",
	"ruby",
	"php",
	"swift",
	"dart",
	"scala",
	"cpp",
	"c",
	"fsharp",
] as const;

export type StyleLanguage = (typeof STYLE_LANGUAGES)[number];

/** What the history says about one dimension of one language. */
export interface StyleEntry {
	value: string;
	share: number;
	weight: number;
	state: "preferred" | "indifferent";
	source: "history" | "project" | "lint";
}

export interface StyleRate {
	merged: number;
	keptAsIs: number;
	rate: number | null;
}

export interface StyleProfile {
	version: number;
	builtAt: number;
	commits: { gold: number; accepted: number; corrected: number; team: number; agent: number };
	hasEmail: boolean;
	lint: string[];
	languages: Partial<Record<StyleLanguage, Partial<Record<StyleDimension, StyleEntry>>>>;
	metrics: { withCoach: StyleRate; withoutCoach: StyleRate; dimensionsPreferred: number };
}

/** A dimension's value set by hand, or "off" to give it to no agent. */
export type StyleOverrides = Partial<Record<StyleLanguage, Partial<Record<StyleDimension, string>>>>;

export interface StylePreferences {
	enabled: boolean;
	overrides: StyleOverrides;
}

export interface CoachProfileState {
	profile: StyleProfile | null;
	preferences: StylePreferences;
	/** What the agents are given: language → dimension → value. */
	effective: StyleOverrides;
	injected: boolean;
}

export interface StyleDeviation {
	language: StyleLanguage;
	dimension: StyleDimension;
	expected: string;
	found: string;
	count: number;
}

export interface CoachCheckResult {
	spec: string;
	deviations: StyleDeviation[];
}
