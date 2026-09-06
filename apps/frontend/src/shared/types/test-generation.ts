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
 * Where a generated test file will be written.
 *
 * Resolved by the backend (`test_generation/layout.py`) from the project's real
 * layout — the `tests` directory beside the source root — before a generation
 * starts. `"needs_choice"` means no directory could be justified: the answer is
 * the user's, not the model's, and `candidates` are what to offer them.
 */
export type TestDestinationStatus = "resolved" | "needs_choice";

/** Why a directory is being offered, so the UI can label it. */
export type DestinationCandidateKind =
	| "existing_tests_dir"
	| "sibling_of_source_root"
	| "project_tests"
	| "source_dir";

/** Why the destination is what it is. Drives one line of localised copy. */
export type TestDestinationReason =
	| "explicit_directory"
	| "existing_test_file"
	| "existing_tests_dir"
	| "co_located_convention"
	| "no_tests_dir"
	| "no_source_root";

export interface DestinationCandidate {
	/** Absolute directory path. */
	path: string;
	kind: DestinationCandidateKind;
	/** False when picking it means creating the directory. */
	exists: boolean;
}

export interface TestDestination {
	/** Absolute directory. Filled in even when `status` is `needs_choice`: it
	 * carries the best candidate, so a caller that cannot ask still has one. */
	directory: string;
	fileName: string;
	/** `directory` + `fileName`, as the backend joined them. */
	path: string;
	status: TestDestinationStatus;
	reason: TestDestinationReason;
	projectRoot: string;
	sourceRoot: string | null;
	candidates: DestinationCandidate[];
	language?: string;
	testFramework?: string;
}

/**
 * Read the runner's snake_case payload into the camelCase shape the UI uses.
 *
 * Returns null for anything that is not a destination: the caller then carries
 * on without a chosen directory, which is the pre-change behaviour rather than
 * a blocked generation.
 */
export function parseTestDestination(input: unknown): TestDestination | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	const directory = typeof raw.directory === "string" ? raw.directory : "";
	const fileName = typeof raw.file_name === "string" ? raw.file_name : "";
	if (!directory || !fileName) return null;

	const candidates: DestinationCandidate[] = Array.isArray(raw.candidates)
		? raw.candidates.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const candidate = entry as Record<string, unknown>;
				if (typeof candidate.path !== "string" || !candidate.path) return [];
				return [
					{
						path: candidate.path,
						kind: (candidate.kind as DestinationCandidateKind) ?? "source_dir",
						exists: candidate.exists === true,
					},
				];
			})
		: [];

	return {
		directory,
		fileName,
		path: typeof raw.path === "string" ? raw.path : `${directory}/${fileName}`,
		status: raw.status === "needs_choice" ? "needs_choice" : "resolved",
		reason: (raw.reason as TestDestinationReason) ?? "existing_tests_dir",
		projectRoot: typeof raw.project_root === "string" ? raw.project_root : "",
		sourceRoot: typeof raw.source_root === "string" ? raw.source_root : null,
		candidates,
		language: typeof raw.language === "string" ? raw.language : undefined,
		testFramework:
			typeof raw.test_framework === "string" ? raw.test_framework : undefined,
	};
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
