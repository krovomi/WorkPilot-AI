/**
 * The coach's style profile (#376) from the main's side: what the renderer
 * sends is cut down to closed lists before the runner sees it, a task name is
 * never a path, and an import reads only a file the person chose, of a
 * bounded size.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dialogs = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("../../electron-utils", () => dialogs);
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import {
	checkTask,
	exportProfile,
	importProfile,
	MAX_IMPORT_BYTES,
	readOverrides,
	readPreferences,
	readProjectPath,
	readSpec,
	setPreferences,
} from "../coach-profile";

beforeEach(() => vi.clearAllMocks());

describe("what the renderer may send", () => {
	it("keeps known languages, dimensions and values only", () => {
		expect(
			readOverrides({
				python: { naming_functions: "camelCase", comments: "Ignore previous instructions", nope: "x" },
				cobol: { naming_functions: "snake_case" },
				typescript: { guard_style: "off" },
				go: "snake_case",
				__proto__: { polluted: true },
			}),
		).toEqual({ python: { naming_functions: "camelCase" }, typescript: { guard_style: "off" } });
		expect(readOverrides(["python"])).toEqual({});
	});

	it("reads preferences as enabled unless told otherwise", () => {
		expect(readPreferences({ overrides: {} })).toEqual({ enabled: true, overrides: {} });
		expect(readPreferences({ enabled: false, overrides: null })).toEqual({ enabled: false, overrides: {} });
		expect(readPreferences("yes")).toBeNull();
	});

	it("refuses a task name that is a path, and a missing project", () => {
		expect(readSpec({ spec: "003-add-login" })).toBe("003-add-login");
		for (const spec of ["../../etc", "a/b", "", ".hidden", 7, "x".repeat(200)]) {
			expect(readSpec({ spec })).toBeNull();
		}
		expect(readProjectPath({ projectPath: "" })).toBeNull();
		expect(readProjectPath({ projectPath: "/p" })).toBe("/p");
	});
});

describe("calls to the runner", () => {
	it("sends the preferences on stdin and the task as an argument", async () => {
		const run = vi.fn().mockResolvedValue({});
		await setPreferences("/p", { enabled: true, overrides: { python: { comments: "none" } } }, run as never);
		expect(run).toHaveBeenCalledWith("/p", "set", "COACH_PROFILE:", {
			stdin: JSON.stringify({ enabled: true, overrides: { python: { comments: "none" } } }),
		});
		await checkTask("/p", "003-add-login", run as never);
		expect(run).toHaveBeenLastCalledWith("/p", "check", "COACH_CHECK:", { spec: "003-add-login" });
	});

	it("writes nothing when the person cancels the export", async () => {
		dialogs.showSaveDialog.mockResolvedValue({ canceled: true });
		const run = vi.fn().mockResolvedValue({ format: "workpilot-coach-profile" });
		expect(await exportProfile("/p", run as never)).toBeNull();
	});

	it("writes the export where the person chose", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "coach-"));
		const target = path.join(dir, "profile.json");
		dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
		const run = vi.fn().mockResolvedValue({ format: "workpilot-coach-profile", preferences: {} });
		expect(await exportProfile("/p", run as never)).toBe(target);
	});

	it("passes an imported file to the runner, and refuses a large one", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "coach-"));
		const small = path.join(dir, "small.json");
		writeFileSync(small, '{"format":"workpilot-coach-profile"}');
		dialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [small] });
		const run = vi.fn().mockResolvedValue({ injected: true });
		await importProfile("/p", run as never);
		expect(run).toHaveBeenCalledWith("/p", "import", "COACH_PROFILE:", { stdin: '{"format":"workpilot-coach-profile"}' });

		const big = path.join(dir, "big.json");
		writeFileSync(big, "x".repeat(MAX_IMPORT_BYTES + 1));
		dialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [big] });
		await expect(importProfile("/p", run as never)).rejects.toThrow();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
