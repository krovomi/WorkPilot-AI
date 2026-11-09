/**
 * The guardrails channels revalidate what the renderer sends, and read the
 * Python runner's answer — the one implementation the agents are held to.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: () => undefined },
	app: {
		isPackaged: false,
		getAppPath: () => "/app/frontend",
		getPath: () => require("node:os").tmpdir(),
	},
}));

vi.mock("../../python-env-manager.js", () => ({
	pythonEnvManager: { getPythonPath: () => "/usr/bin/python3" },
}));

import { checkedProjectPath, guardrailsRunnerArgs, parseRunnerOutput } from "../guardrails-handlers";

let project: string;

beforeEach(() => {
	project = mkdtempSync(path.join(tmpdir(), "guardrails-"));
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

describe("guardrailsRunnerArgs", () => {
	it("builds each command", () => {
		expect(guardrailsRunnerArgs("validate", { projectPath: project })).toEqual(["validate", "--project-path", project]);
		expect(
			guardrailsRunnerArgs("test", { projectPath: project, toolName: "Write", toolInput: { file_path: "a", content: "" } }),
		).toEqual(["test", "--project-path", project, "--tool", "Write", "--input", '{"file_path":"a","content":""}']);
		expect(guardrailsRunnerArgs("answer", { projectPath: project, requestId: "0123456789ab", approve: true }).at(-1)).toBe(
			"--approve",
		);
		expect(guardrailsRunnerArgs("answer", { projectPath: project, requestId: "0123456789ab" }).at(-1)).toBe("--refuse");
		expect(guardrailsRunnerArgs("check-diff", { projectPath: project }).slice(-2)).toEqual(["--ref", "HEAD"]);
	});

	it.each([
		["validate", { projectPath: "relative" }, /absolute path/],
		["validate", { projectPath: "/no/such/folder" }, /not a folder/],
		["test", { toolName: "Write; rm", toolInput: {} }, /invalid tool name/],
		["test", { toolName: "Write", toolInput: [] }, /must be an object/],
		["answer", { requestId: "../../x" }, /invalid request id/],
		["check-diff", { ref: "--output=/tmp/x" }, /Not a git ref/],
		["rm", {}, /unknown guardrails command/],
	])("refuses %s %#", (command, request, error) => {
		const withProject = "projectPath" in request ? request : { ...request, projectPath: project };
		expect(() => guardrailsRunnerArgs(command, withProject as Record<string, unknown>)).toThrow(error);
	});
});

describe("parseRunnerOutput", () => {
	it("reads the result line among other output", () => {
		expect(parseRunnerOutput('noise\nGUARDRAILS_RESULT:{"action":"deny"}\n')).toEqual({ action: "deny" });
	});

	it("throws the runner's error", () => {
		expect(() => parseRunnerOutput('GUARDRAILS_ERROR:"No pending request x"\n')).toThrow("No pending request x");
		expect(() => parseRunnerOutput("")).toThrow(/no answer/);
	});
});

describe("checkedProjectPath", () => {
	it("accepts an existing absolute folder only", () => {
		mkdirSync(path.join(project, "a"));
		writeFileSync(path.join(project, "f"), "");
		expect(checkedProjectPath(path.join(project, "a"))).toBe(path.join(project, "a"));
		expect(() => checkedProjectPath(path.join(project, "f"))).toThrow(/not a folder/);
		expect(() => checkedProjectPath(42)).toThrow(/absolute/);
	});
});
