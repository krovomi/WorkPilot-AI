/**
 * Languages the test generator writes tests for, in the order the TDD picker
 * lists them. Mirrors `SUPPORTED_LANGUAGES` in
 * `apps/backend/test_generation/stacks.py`; `tests/test_generation/test_stacks.py`
 * fails when the two drift.
 *
 * `framework` is only what the chip shows before the project is read: the
 * backend answers from the project's manifests, so a Kotlin project on Kotest
 * gets Kotest whatever this says.
 */
export interface TestStudioLanguage {
	id: string;
	label: string;
	framework: string;
	/** Dot colour on the chip — the language's usual brand hue. */
	color: string;
}

export const TEST_STUDIO_LANGUAGES: readonly TestStudioLanguage[] = [
	{ id: "typescript", label: "TypeScript", framework: "Vitest · Jest", color: "#3178c6" },
	{ id: "javascript", label: "JavaScript", framework: "Jest · Mocha", color: "#e8c547" },
	{ id: "python", label: "Python", framework: "pytest", color: "#4b8bbe" },
	{ id: "csharp", label: "C# / .NET", framework: "xUnit · NUnit", color: "#9b6bdf" },
	{ id: "java", label: "Java", framework: "JUnit 5", color: "#e76f00" },
	{ id: "kotlin", label: "Kotlin", framework: "JUnit 5 · Kotest", color: "#a97bff" },
	{ id: "go", label: "Go", framework: "testing", color: "#00add8" },
	{ id: "rust", label: "Rust", framework: "cargo test", color: "#dea584" },
	{ id: "php", label: "PHP", framework: "PHPUnit · Pest", color: "#777bb4" },
	{ id: "ruby", label: "Ruby", framework: "RSpec", color: "#cc342d" },
	{ id: "swift", label: "Swift", framework: "XCTest", color: "#f05138" },
	{ id: "dart", label: "Dart / Flutter", framework: "flutter_test", color: "#40c4ff" },
	{ id: "c", label: "C", framework: "Unity", color: "#8e9aaf" },
	{ id: "cpp", label: "C++", framework: "GoogleTest", color: "#f34b7d" },
];

const BY_ID = new Map(TEST_STUDIO_LANGUAGES.map((lang) => [lang.id, lang]));

/** The language entry for an id the backend reported, if it is one we list. */
export function testStudioLanguage(id: string | undefined): TestStudioLanguage | undefined {
	return id ? BY_ID.get(id) : undefined;
}

/**
 * True for a language id the generator accepts. The main process checks the
 * renderer's value with it before the id becomes a runner argument.
 */
export function isTestStudioLanguage(value: unknown): value is string {
	return typeof value === "string" && BY_ID.has(value);
}

/** What a TDD run can be asked to specify. */
export const TDD_SNIPPET_TYPES = ["function", "class", "component", "api"] as const;
export type TddSnippetType = (typeof TDD_SNIPPET_TYPES)[number];
