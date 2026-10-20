/**
 * Onboarding Agent API
 *
 * Renderer-side bridge to the onboarding agent runner.
 */

import type { OnboardingGuide } from "../../../shared/types/onboarding";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface OnboardingAgentRunOptions {
	projectPath: string;
}

/**
 * A generated string, as an i18n key plus its parameters.
 *
 * The onboarding package is produced by Python, so its prose cannot go through
 * `react-i18next` at the point it is written. It travels as a descriptor
 * instead and the page resolves it, which also means switching the app's
 * language re-renders the package without re-scanning the project.
 *
 * `key` is empty for a value that must not be translated — a path, a command,
 * a tool name; `fallback` is the English rendering, used as `defaultValue`.
 */
export interface OnboardingText {
	key: string;
	params: Record<string, unknown>;
	fallback: string;
}

export interface OnboardingTourStep {
	order: number;
	title: string;
	file_path: string;
	reason: string;
	suggested_questions: string[];
	category: "file" | "entrypoint" | "directory" | "command" | "doc";
	snippet?: string;
	reason_i18n?: OnboardingText | null;
	suggested_questions_i18n?: OnboardingText[];
}

export type OnboardingQuizCategory =
	| "stack"
	| "files"
	| "architecture"
	| "commands"
	| "conventions"
	| "general";

export type OnboardingDifficulty = "easy" | "medium" | "hard";

export interface OnboardingQuizQuestion {
	question: string;
	choices: string[];
	correct_index: number;
	rationale: string;
	category: OnboardingQuizCategory;
	difficulty: OnboardingDifficulty;
	question_i18n?: OnboardingText | null;
	rationale_i18n?: OnboardingText | null;
	/** One descriptor per entry of `choices`, in the same order. */
	choices_i18n?: OnboardingText[];
}

export interface OnboardingFirstTask {
	title: string;
	file_path: string;
	line: number;
	source_comment: string;
	category: "todo" | "tests" | "docs" | "explore";
	difficulty: OnboardingDifficulty;
	why: string;
	title_i18n?: OnboardingText | null;
	source_comment_i18n?: OnboardingText | null;
	why_i18n?: OnboardingText | null;
}

export interface OnboardingGlossaryTerm {
	term: string;
	occurrences: number;
	sources: string[];
	kind: "directory" | "type" | "module" | "identifier";
	definition: string;
	definition_i18n?: OnboardingText | null;
}

export interface OnboardingKeyFile {
	path: string;
	reason: string;
	category: string;
	lines: number;
	reason_i18n?: OnboardingText | null;
}

export interface OnboardingConvention {
	name: string;
	description: string;
	examples: string[];
	name_i18n?: OnboardingText | null;
	description_i18n?: OnboardingText | null;
}

export interface OnboardingCommand {
	label: string;
	command: string;
	category: "setup" | "run" | "test" | "lint" | "build" | "other";
	source: string;
	label_i18n?: OnboardingText | null;
}

export interface OnboardingArchitectureNode {
	path: string;
	role: string;
	file_count: number;
	languages: string[];
	role_i18n?: OnboardingText | null;
}

export interface OnboardingPackageStats {
	files?: number;
	code_files?: number;
	test_files?: number;
	directories?: number;
	languages?: number;
}

export interface OnboardingPackage {
	guide: {
		project_name: string;
		tech_stack: string[];
		key_files: OnboardingKeyFile[];
		entry_points: OnboardingKeyFile[];
		conventions: OnboardingConvention[];
		commands: OnboardingCommand[];
		architecture: OnboardingArchitectureNode[];
		sections: Record<string, string>;
		/** The prose of `sections`, line by line, translatable. */
		section_lines?: Record<string, OnboardingText[]>;
		stats: OnboardingPackageStats;
		estimated_reading_time_min: number;
	};
	tour: OnboardingTourStep[];
	quiz: OnboardingQuizQuestion[];
	first_tasks: OnboardingFirstTask[];
	glossary: OnboardingGlossaryTerm[];
}

export interface OnboardingAgentResult {
	guide: OnboardingGuide;
	package?: OnboardingPackage;
}

export interface OnboardingAgentEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; statusI18n?: OnboardingText; steps?: number };
}

export interface OnboardingAgentAPI {
	runOnboardingAgentScan: (
		options: OnboardingAgentRunOptions,
	) => Promise<OnboardingAgentResult>;
	cancelOnboardingAgentScan: () => Promise<boolean>;
	onOnboardingAgentEvent: (
		callback: (event: OnboardingAgentEvent) => void,
	) => () => void;
	onOnboardingAgentResult: (
		callback: (result: OnboardingAgentResult) => void,
	) => () => void;
	onOnboardingAgentError: (callback: (error: string) => void) => () => void;
}

export const createOnboardingAgentAPI = (): OnboardingAgentAPI => ({
	runOnboardingAgentScan: (options: OnboardingAgentRunOptions) =>
		invokeIpc<OnboardingAgentResult>("onboardingAgent:run", options),

	cancelOnboardingAgentScan: () =>
		invokeIpc<boolean>("onboardingAgent:cancel"),

	onOnboardingAgentEvent: (callback) =>
		createIpcListener<[OnboardingAgentEvent]>("onboarding-event", (payload) =>
			callback(payload),
		),

	onOnboardingAgentResult: (callback) =>
		createIpcListener<[OnboardingAgentResult]>("onboarding-result", (payload) =>
			callback(payload),
		),

	onOnboardingAgentError: (callback) =>
		createIpcListener<[string]>("onboarding-error", (payload) =>
			callback(payload),
		),
});
