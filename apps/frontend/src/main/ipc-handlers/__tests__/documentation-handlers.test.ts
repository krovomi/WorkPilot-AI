import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	BrowserWindow: { getAllWindows: () => [] },
	ipcMain: { handle: vi.fn() },
}));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import type { DocumentationRequest } from "../../../shared/types/documentation";
import { documentationArgs } from "../documentation-handlers";

const req = (r: Partial<DocumentationRequest>) => r as DocumentationRequest;

describe("documentationArgs", () => {
	it("passes the project and the action, and the path for file actions", () => {
		expect(documentationArgs(req({ projectPath: "/p", action: "project" }))).toEqual([
			"--project-path",
			"/p",
			"--action",
			"project",
		]);
		expect(documentationArgs(req({ projectPath: "/p", action: "coverage", path: "src/a.cs" }))).toEqual([
			"--project-path",
			"/p",
			"--action",
			"coverage",
			"--path=src/a.cs",
		]);
	});

	it("allows a README of the project root", () => {
		expect(documentationArgs(req({ projectPath: "/p", action: "readme", path: "" }))).toContain("--path=");
	});

	it.each([
		[{ projectPath: "", action: "project" }, /projectPath/],
		[{ projectPath: "-x", action: "project" }, /projectPath/],
		[{ projectPath: "/p", action: "rm" }, /Unknown documentation action/],
		[{ projectPath: "/p", action: "coverage" }, /path is required/],
		[{ projectPath: "/p", action: "coverage", path: "--help" }, /must not start/],
	])("refuses %o", (request, error) => {
		expect(() => documentationArgs(req(request as Partial<DocumentationRequest>))).toThrow(error);
	});
});
