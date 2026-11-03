import { describe, expect, it } from "vitest";
import type { TaskLogEntry } from "../../types";
import {
	buildLogMatcher,
	entryKind,
	entryMatchesQuery,
	filterLogEntries,
	NEVER_MATCHER,
} from "../task-logs-search";

function makeEntry(partial: Partial<TaskLogEntry>): TaskLogEntry {
	return {
		timestamp: "2026-06-15T10:00:00Z",
		type: "text",
		content: "",
		phase: "coding",
		...partial,
	};
}

describe("entryMatchesQuery", () => {
	it("matches everything when the query is empty", () => {
		expect(entryMatchesQuery(makeEntry({ content: "anything" }), "")).toBe(true);
	});

	it("matches against the message content (case-insensitive)", () => {
		const entry = makeEntry({ content: "Creating Resources.resx" });
		expect(entryMatchesQuery(entry, "resources")).toBe(true);
		expect(entryMatchesQuery(entry, "RESOURCES")).toBe(true);
		expect(entryMatchesQuery(entry, "missing")).toBe(false);
	});

	it("matches against tool name, tool input, detail and subphase", () => {
		expect(
			entryMatchesQuery(makeEntry({ tool_name: "Grep" }), "grep"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ tool_input: "src/app.ts" }), "app.ts"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ detail: "Build succeeded" }), "succeeded"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ subphase: "CONTEXT GATHERING" }), "context"),
		).toBe(true);
	});

	it("returns false when no searchable field is present or matches", () => {
		expect(entryMatchesQuery(makeEntry({ content: "" }), "x")).toBe(false);
	});

	it("lower-cases the query so callers may pass raw or normalized input", () => {
		const entry = makeEntry({ content: "toto.txt created" });
		expect(entryMatchesQuery(entry, "TOTO")).toBe(true);
		expect(entryMatchesQuery(entry, "toto")).toBe(true);
	});
});

describe("buildLogMatcher", () => {
	it("returns no matcher for an empty or blank query", () => {
		expect(buildLogMatcher({ query: "   " })).toEqual({
			matcher: null,
			error: null,
		});
	});

	it("matches plain text case-insensitively and escapes metacharacters", () => {
		const { matcher } = buildLogMatcher({ query: "app.ts" });
		expect(matcher?.test("src/APP.ts")).toBe(true);
		// "." is literal, not "any character".
		expect(matcher?.test("src/appXts")).toBe(false);
	});

	it("respects case when asked", () => {
		const { matcher } = buildLogMatcher({ query: "Error", caseSensitive: true });
		expect(matcher?.test("Error: boom")).toBe(true);
		expect(matcher?.test("error: boom")).toBe(false);
	});

	it("matches whole words only, accented words included", () => {
		const { matcher } = buildLogMatcher({ query: "test", wholeWord: true });
		expect(matcher?.test("run the test now")).toBe(true);
		expect(matcher?.test("run the tests now")).toBe(false);
		const accented = buildLogMatcher({ query: "réussi", wholeWord: true });
		expect(accented.matcher?.test("build réussi.")).toBe(true);
		expect(accented.matcher?.test("build réussite")).toBe(false);
	});

	it("reads a regular expression and reports one that does not compile", () => {
		const { matcher } = buildLogMatcher({ query: "fail(ed|ure)", regex: true });
		expect(matcher?.test("build failure")).toBe(true);
		expect(matcher?.test("build fail")).toBe(false);
		const broken = buildLogMatcher({ query: "fail(", regex: true });
		expect(broken.matcher).toBeNull();
		expect(broken.error).toBeTruthy();
	});

	it("locates every hit for highlighting and skips empty matches", () => {
		const { matcher } = buildLogMatcher({ query: "ab" });
		expect(matcher?.ranges("ab-AB-ab")).toEqual([
			[0, 2],
			[3, 5],
			[6, 8],
		]);
		const empty = buildLogMatcher({ query: "x*", regex: true });
		expect(empty.matcher?.ranges("axxb")).toEqual([[1, 3]]);
	});

	it("never matches with NEVER_MATCHER", () => {
		expect(NEVER_MATCHER.test("anything")).toBe(false);
		expect(NEVER_MATCHER.ranges("anything")).toEqual([]);
	});
});

describe("entryKind / filterLogEntries", () => {
	it("groups backend entry types into the filter's kinds", () => {
		expect(entryKind(makeEntry({ type: "text" }))).toBe("text");
		expect(entryKind(makeEntry({ type: "tool_start" }))).toBe("tool");
		expect(entryKind(makeEntry({ type: "tool_end" }))).toBe("tool");
		expect(entryKind(makeEntry({ type: "error" }))).toBe("error");
		expect(entryKind(makeEntry({ type: "warning" }))).toBe("warning");
		expect(entryKind(makeEntry({ type: "success" }))).toBe("status");
		expect(entryKind(makeEntry({ type: "phase_end" }))).toBe("status");
	});

	it("keeps entries of the selected kinds that match the search", () => {
		const entries = [
			makeEntry({ type: "error", content: "build failed" }),
			makeEntry({ type: "text", content: "build started" }),
			makeEntry({ type: "error", content: "lint failed" }),
		];
		const { matcher } = buildLogMatcher({ query: "build" });
		expect(filterLogEntries(entries, null, null)).toBe(entries);
		expect(filterLogEntries(entries, new Set(["error"]), null)).toHaveLength(2);
		expect(
			filterLogEntries(entries, new Set(["error"]), matcher).map(
				(e) => e.content,
			),
		).toEqual(["build failed"]);
	});
});
