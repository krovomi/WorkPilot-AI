import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: { handle: vi.fn() },
}));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonStaticRunnerEnv: vi.fn() }));

import type { CodeInsightsRequest } from "../../../shared/types/code-insights";
import { codeInsightsPayload, parseCodeInsightsOutput } from "../code-insights-handlers";

const req = (r: Partial<CodeInsightsRequest>) => r as CodeInsightsRequest;

describe("codeInsightsPayload", () => {
	it("passes the action, the text and a known-shaped language", () => {
		expect(JSON.parse(codeInsightsPayload(req({ action: "smells", text: "x", language: "csharp" })))).toEqual({
			action: "smells",
			text: "x",
			language: "csharp",
		});
		expect(JSON.parse(codeInsightsPayload(req({ action: "languages" })))).toEqual({ action: "languages" });
	});

	it("drops an empty language so the runner guesses it", () => {
		expect(JSON.parse(codeInsightsPayload(req({ action: "review", text: "diff", language: "" })))).toEqual({
			action: "review",
			text: "diff",
		});
	});

	it.each([
		[{ action: "rm" }, /Unknown code insights action/],
		[{ action: "smells" }, /text is required/],
		[{ action: "smells", text: "   " }, /text is required/],
		[{ action: "smells", text: "x", language: "--help" }, /Invalid language/],
		[{ action: "smells", text: "x", language: "C Sharp" }, /Invalid language/],
		[{ action: "review", text: "a".repeat(2 * 1024 * 1024 + 1) }, /exceeds 2 MB/],
	])("refuses %o", (request, message) => {
		expect(() => codeInsightsPayload(req(request as Partial<CodeInsightsRequest>))).toThrow(message);
	});
});

describe("parseCodeInsightsOutput", () => {
	it("reads the result line among other output", () => {
		expect(parseCodeInsightsOutput('noise\nCODE_INSIGHTS_RESULT:{"score":90}\n')).toEqual({
			result: { score: 90 },
			error: undefined,
		});
	});

	it("reports the runner's error and an unreadable result", () => {
		expect(parseCodeInsightsOutput("CODE_INSIGHTS_ERROR:Invalid language id\n").error).toBe("Invalid language id");
		expect(parseCodeInsightsOutput("CODE_INSIGHTS_RESULT:{oops\n").error).toMatch(/Unreadable/);
	});
});
