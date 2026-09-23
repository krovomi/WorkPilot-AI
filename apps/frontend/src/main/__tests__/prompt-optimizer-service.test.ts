/**
 * The line protocol of `prompt_optimizer_runner.py`, as the main process reads
 * it. The Python side is pinned by `tests/test_prompt_optimizer_runner.py`;
 * this is the other half of the same contract.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/constants", () => ({ MODEL_ID_MAP: {} }));

import { parseRunnerLine } from "../prompt-optimizer-service";

describe("parseRunnerLine", () => {
	it("reads a known status code", () => {
		expect(parseRunnerLine("__STATUS__:generating")).toEqual({
			kind: "status",
			status: "generating",
		});
	});

	it("keeps an unknown status out of the UI", () => {
		expect(parseRunnerLine("__STATUS__:something else")?.kind).toBe("log");
	});

	it("decodes a delta, newlines included", () => {
		expect(parseRunnerLine(`__DELTA__:${JSON.stringify("a\nb")}`)).toEqual({
			kind: "delta",
			text: "a\nb",
		});
	});

	it("reads a result and fills what the runner left out", () => {
		expect(
			parseRunnerLine('__OPTIMIZED_PROMPT__:{"optimized":"P"}'),
		).toEqual({
			kind: "result",
			result: { optimized: "P", changes: [], reasoning: "" },
		});
	});

	it("does not trust an empty result", () => {
		expect(parseRunnerLine('__OPTIMIZED_PROMPT__:{"optimized":"  "}')?.kind).toBe(
			"log",
		);
	});

	it("reads a coded error", () => {
		expect(
			parseRunnerLine('__ERROR__:{"message":"bad key","code":"auth"}'),
		).toEqual({ kind: "error", error: { code: "auth", message: "bad key" } });
	});

	it("treats a malformed marker line as a log line", () => {
		expect(parseRunnerLine("__OPTIMIZED_PROMPT__:{not json")?.kind).toBe("log");
	});

	it("ignores blank lines and strips a Windows line ending", () => {
		expect(parseRunnerLine("   ")).toBeNull();
		expect(parseRunnerLine("__STATUS__:context\r")).toEqual({
			kind: "status",
			status: "context",
		});
	});
});
