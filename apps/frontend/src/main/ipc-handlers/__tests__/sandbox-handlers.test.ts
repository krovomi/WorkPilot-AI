/**
 * The sandbox channel revalidates what the renderer sends before any process starts.
 *
 * The renderer only offers projects and specs that exist; these tests keep the
 * main process from trusting it: a relative project path, a spec id that names
 * no spec folder, a path in place of an id, or a ref shaped like an option are
 * all refused here.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
	BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../python-env-manager.js", () => ({
	pythonEnvManager: { getPythonPath: () => "/usr/bin/python3" },
}));

vi.mock("../../services/credential-manager.js", () => ({
	credentialManager: { getEnvironmentVariables: () => ({}) },
}));

vi.mock("../github/utils/runner-env.js", () => ({
	getRunnerEnv: async () => ({}),
}));

import { buildSandboxArgs } from "../sandbox-handlers";

let project: string;

beforeEach(() => {
	project = mkdtempSync(path.join(tmpdir(), "sandbox-args-"));
	mkdirSync(path.join(project, ".workpilot", "specs", "001-orders"), { recursive: true });
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

describe("buildSandboxArgs", () => {
	it("reads the uncommitted changes when no spec is named", () => {
		expect(buildSandboxArgs("runner.py", { projectPath: project })).toEqual([
			"runner.py",
			"--project-path",
			project,
		]);
	});

	it("rehearses the plan of a spec of the project, on HEAD by default", () => {
		expect(buildSandboxArgs("runner.py", { projectPath: project, specId: "001-orders" })).toEqual([
			"runner.py",
			"--project-path",
			project,
			"--spec-dir",
			path.join(project, ".workpilot", "specs", "001-orders"),
			"--base-ref",
			"HEAD",
		]);
		expect(
			buildSandboxArgs("runner.py", { projectPath: project, specId: "001-orders", baseRef: " origin/develop " }).at(-1),
		).toBe("origin/develop");
	});

	it.each([
		[{}, "projectPath is required"],
		[{ projectPath: "relative/path" }, "projectPath is required"],
		[{ projectPath: "/no/such/folder/anywhere" }, "projectPath is not a folder"],
	])("refuses a bad project path %#", (request, message) => {
		expect(() => buildSandboxArgs("runner.py", request)).toThrow(message);
	});

	it.each(["002-ghost", "../001-orders", "a/b", ".."])("refuses spec id %s", (specId) => {
		expect(() => buildSandboxArgs("runner.py", { projectPath: project, specId })).toThrow(/No spec named/);
	});

	it.each(["--output=/tmp/x", "-c", "a b", "x;rm"])("refuses ref %s", (baseRef) => {
		expect(() => buildSandboxArgs("runner.py", { projectPath: project, specId: "001-orders", baseRef })).toThrow(
			/Not a git ref/,
		);
	});
});
