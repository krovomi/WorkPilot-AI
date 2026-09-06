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
 * Which test libraries the generated tests are written against.
 *
 * Resolved by the backend (`test_generation/libraries.py`) from the project's
 * own manifests — a solution that references FluentAssertions and Moq gets
 * tests written with them without anyone having to say so — and overridable by
 * the user, whose choice is what a project with nothing installed needs.
 */
export type LibraryCategory =
	| "framework"
	| "assertions"
	| "mocking"
	| "data"
	| "http"
	| "ui"
	| "snapshot"
	| "coverage";

export type PackageEcosystem = "nuget" | "npm" | "pypi" | "maven";

export interface TestLibrary {
	id: string;
	name: string;
	/** The package id as the ecosystem knows it (NuGet, npm, PyPI, Maven). */
	package: string;
	ecosystem: PackageEcosystem;
	language: string;
	category: LibraryCategory;
	/** One line on how to write with it — what the model is told. */
	usage: string;
	/** Pre-checked when the project references nothing at all. */
	recommended: boolean;
	/** True when the project already declares this package. */
	installed: boolean;
}

/** A chosen library the project does not reference yet. */
export interface MissingPackage {
	id: string;
	name: string;
	package: string;
	ecosystem: PackageEcosystem;
}

export interface TestLibrarySelection {
	language: string;
	/** Ids that will be written against. */
	selected: string[];
	/** Ids the project already declares. */
	installed: string[];
	/** True when the ids came from the user rather than from the project. */
	explicit: boolean;
	/** Everything on offer for this language, in display order. */
	libraries: TestLibrary[];
	missing: MissingPackage[];
	/** What would be run to add the missing ones, for display. */
	installCommands: string[];
}

/** One package-manager command that ran, and what it did. */
export interface PackageInstallStep {
	command: string[];
	ok: boolean;
	output: string;
}

export interface PackageInstallReport {
	ok: boolean;
	/** Library ids that landed. */
	installed: string[];
	steps: PackageInstallStep[];
	/** Ecosystems the app will not touch, as commands to run by hand. */
	manualCommands: string[];
	/** Why nothing ran, when nothing ran. */
	reason: string;
	/** The project file the packages were added to. */
	target: string;
}

/** Read the runner's snake_case library payload into the UI's shape. */
export function parseTestLibrarySelection(
	input: unknown,
): TestLibrarySelection | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	const asStrings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

	const libraries: TestLibrary[] = Array.isArray(raw.libraries)
		? raw.libraries.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const library = entry as Record<string, unknown>;
				if (typeof library.id !== "string") return [];
				return [
					{
						id: library.id,
						name: typeof library.name === "string" ? library.name : library.id,
						package:
							typeof library.package === "string" ? library.package : library.id,
						ecosystem: (library.ecosystem as PackageEcosystem) ?? "nuget",
						language: typeof library.language === "string" ? library.language : "",
						category: (library.category as LibraryCategory) ?? "framework",
						usage: typeof library.usage === "string" ? library.usage : "",
						recommended: library.recommended === true,
						installed: library.installed === true,
					},
				];
			})
		: [];

	const missing: MissingPackage[] = Array.isArray(raw.missing)
		? raw.missing.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const item = entry as Record<string, unknown>;
				if (typeof item.id !== "string") return [];
				return [
					{
						id: item.id,
						name: typeof item.name === "string" ? item.name : item.id,
						package: typeof item.package === "string" ? item.package : item.id,
						ecosystem: (item.ecosystem as PackageEcosystem) ?? "nuget",
					},
				];
			})
		: [];

	return {
		language: typeof raw.language === "string" ? raw.language : "unknown",
		selected: asStrings(raw.selected),
		installed: asStrings(raw.installed),
		explicit: raw.explicit === true,
		libraries,
		missing,
		installCommands: asStrings(raw.install_commands),
	};
}

/** Read the runner's snake_case install report into the UI's shape. */
export function parsePackageInstallReport(
	input: unknown,
): PackageInstallReport | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	const steps: PackageInstallStep[] = Array.isArray(raw.steps)
		? raw.steps.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const step = entry as Record<string, unknown>;
				return [
					{
						command: Array.isArray(step.command)
							? step.command.filter((c): c is string => typeof c === "string")
							: [],
						ok: step.ok === true,
						output: typeof step.output === "string" ? step.output : "",
					},
				];
			})
		: [];

	return {
		ok: raw.ok === true,
		installed: Array.isArray(raw.installed)
			? raw.installed.filter((v): v is string => typeof v === "string")
			: [],
		steps,
		manualCommands: Array.isArray(raw.manual_commands)
			? raw.manual_commands.filter((v): v is string => typeof v === "string")
			: [],
		reason: typeof raw.reason === "string" ? raw.reason : "",
		target: typeof raw.target === "string" ? raw.target : "",
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
