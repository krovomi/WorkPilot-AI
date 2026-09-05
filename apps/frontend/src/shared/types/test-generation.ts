/**
 * Test generation — live pipeline events and structured failures.
 *
 * Shared by the main process (which parses the Python runner's stdout), the
 * preload bridge and the renderer, so all three agree on the shape of a
 * failure. Before this existed an error was a bare string that the UI dropped
 * on the floor: a run could die on a 401 and the user saw a red step with no
 * text at all.
 */

/** Pipeline steps, in the order the runner walks them. */
export type TestGenStageId = "detect" | "read" | "generate" | "write" | "done";

/** A live pipeline-stage event streamed during generation. */
export interface TestGenStageEvent {
	type: "stage";
	stage: TestGenStageId;
	/** Terminal status of the stage. Absent means "entered / in progress". */
	status?: "done" | "failed";
	/** Pre-rendered chip text. Fallback only — prefer the structured fields. */
	detail?: string;
	language?: string;
	framework?: string;
	path?: string;
	tests?: number;
	/** Line count of the source that was read (stage "read"). */
	lines?: number;
}

/**
 * What went wrong, in the terms the user can act on.
 *
 * `code` drives the title and the remediation hint shown in the UI, so it is a
 * closed union rather than a free string: a code with no copy would render a
 * blank panel. Anything unrecognised must map to `"unknown"`, which has copy of
 * its own.
 */
export type TestGenErrorCode =
	| "auth"
	| "rate_limit"
	| "quota"
	| "network"
	| "timeout"
	| "provider_unavailable"
	| "empty_response"
	| "file_not_found"
	| "write_failed"
	| "parse_failed"
	| "invalid_input"
	| "backend_missing"
	| "runner_crashed"
	| "no_output"
	| "unknown";

/** Every code the UI has copy for — used to validate what crosses the bridge. */
export const TEST_GEN_ERROR_CODES: readonly TestGenErrorCode[] = [
	"auth",
	"rate_limit",
	"quota",
	"network",
	"timeout",
	"provider_unavailable",
	"empty_response",
	"file_not_found",
	"write_failed",
	"parse_failed",
	"invalid_input",
	"backend_missing",
	"runner_crashed",
	"no_output",
	"unknown",
];

export interface TestGenerationError {
	/** One sentence, already human-readable. Always present. */
	message: string;
	code: TestGenErrorCode;
	/** The pipeline step that failed, when known. */
	stage?: TestGenStageId;
	/** Traceback tail / provider diagnostic / stderr. Redacted, foldable. */
	details?: string;
	provider?: string;
	model?: string;
	/** Runner exit code, when the process died rather than reported. */
	exitCode?: number;
	/** When the failure was observed, for the copied report. */
	at?: number;
}

/** Narrow an unknown code to one the UI has copy for. */
export function toTestGenErrorCode(value: unknown): TestGenErrorCode {
	return TEST_GEN_ERROR_CODES.includes(value as TestGenErrorCode)
		? (value as TestGenErrorCode)
		: "unknown";
}

/**
 * Accept either channel of the runner protocol.
 *
 * The runner reports each failure twice — structured, then message-only — and
 * older builds send only the string. Normalising here means the store, the
 * panel and the task-detail generator all see one shape.
 */
export function normalizeTestGenerationError(
	input: unknown,
	fallbackMessage: string,
): TestGenerationError {
	if (typeof input === "string") {
		return { message: input.trim() || fallbackMessage, code: "unknown" };
	}
	if (input && typeof input === "object") {
		const raw = input as Record<string, unknown>;
		const message =
			typeof raw.message === "string" && raw.message.trim()
				? raw.message.trim()
				: fallbackMessage;
		const error: TestGenerationError = {
			message,
			code: toTestGenErrorCode(raw.code),
		};
		if (typeof raw.stage === "string") {
			error.stage = raw.stage as TestGenStageId;
		}
		for (const key of ["details", "provider", "model"] as const) {
			const value = raw[key];
			if (typeof value === "string" && value.trim()) error[key] = value.trim();
		}
		if (typeof raw.exitCode === "number") error.exitCode = raw.exitCode;
		error.at = typeof raw.at === "number" ? raw.at : Date.now();
		return error;
	}
	return { message: fallbackMessage, code: "unknown", at: Date.now() };
}
