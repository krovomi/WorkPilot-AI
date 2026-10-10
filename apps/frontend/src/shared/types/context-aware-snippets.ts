/**
 * Types shared by the context-aware snippets feature's three processes: the
 * main-process service, the preload bridge and the renderer store. They were
 * declared twice (store and service) and had already started to drift.
 */

export type SnippetType =
	| "component"
	| "function"
	| "class"
	| "hook"
	| "utility"
	| "api"
	| "test";

export const SNIPPET_TYPES: readonly SnippetType[] = [
	"component",
	"function",
	"class",
	"hook",
	"utility",
	"api",
	"test",
];

/**
 * Structured result of `context_aware_snippets_runner.py`. `context_used` is
 * what the runner actually read (stack, convention files, the sample file),
 * not what the model says it looked at.
 */
export interface ContextAwareSnippetResult {
	snippet: string;
	language: string;
	description: string;
	context_used: string[];
	adaptations: string[];
	reasoning: string;
}

/**
 * Phase codes the runner reports. Codes, not sentences: the renderer
 * translates them (`contextAwareSnippets:status.<code>`).
 */
export type ContextAwareSnippetsStatus = "context" | "generating" | "parsing";

/**
 * A failure, coded so the renderer can say it in the user's language.
 * `message` is the technical detail, shown underneath. Codes come from the
 * runner (`core.error_details` — `auth`, `rate_limit`, `quota`, `network`… —
 * and its own `empty_description`, `invalid_response`, `provider_error`), from
 * the main process (`runner_missing`, `python_missing`, `project_not_found`,
 * `invalid_input`, `spawn_failed`, `process_failed`) or from the renderer when
 * the request never reached the main process (`ipc_failed`).
 */
export interface ContextAwareSnippetsError {
	code: string;
	message: string;
}

/** What the renderer asks for. The project is named by id, never by path. */
export interface ContextAwareSnippetRequest {
	projectId: string;
	snippetType: SnippetType;
	description: string;
	/** Omitted: the runner detects the language from the project's files. */
	language?: string;
}

/** Answer of the generate call: the run started, or why it could not. */
export interface ContextAwareSnippetsStartResult {
	success: boolean;
	error?: ContextAwareSnippetsError;
}
