/**
 * The generational tests runner's requests are checked in the main process:
 * the renderer names a mode, a label and a detected command's id, never a
 * command line.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app" },
	ipcMain: { handle: vi.fn() },
	dialog: {},
	BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));
vi.mock("../../electron-utils", () => ({ showOpenDialog: vi.fn() }));

import {
	checkGenRunRequest,
	GEN_REPORT_MAX_BYTES,
	genRunnerArgs,
	readGenRunnerOutput,
	readReportFile,
} from "../gen-tests-run-handlers";

describe("checkGenRunRequest", () => {
	it("keeps a valid capture", () => {
		expect(checkGenRunRequest({ projectPath: "/p", mode: "capture", label: "v1.2_rc-1" })).toEqual({
			projectPath: "/p",
			mode: "capture",
			label: "v1.2_rc-1",
			commandId: "auto",
		});
	});

	it.each([
		[{ mode: "capture", label: "v1" }, "projectPath"],
		[{ projectPath: "/p", mode: "delete", label: "v1" }, "mode"],
		[{ projectPath: "/p", mode: "capture", label: "../v1" }, "label"],
		[{ projectPath: "/p", mode: "capture", label: "-rf" }, "label"],
		[{ projectPath: "/p", mode: "compare", label: "v1", commandId: "rm -rf /" }, "command"],
	])("refuses %j", (raw, word) => {
		expect(() => checkGenRunRequest(raw)).toThrow(new RegExp(word));
	});
});

describe("genRunnerArgs", () => {
	it("passes the label as the value of its option", () => {
		expect(
			genRunnerArgs({ projectPath: "/p", mode: "compare", label: "v1", commandId: "cargo" }),
		).toEqual(["--project-path", "/p", "--mode", "compare", "--baseline", "v1", "--command-id", "cargo"]);
	});
});

describe("readGenRunnerOutput", () => {
	it("reads the result line among other output", () => {
		const out = 'warning: x\nGEN_RESULT:{"label":"v1","command":"go test ./..."}\n';
		expect(readGenRunnerOutput(out, 0)).toEqual({ success: true, label: "v1", command: "go test ./..." });
	});

	it("gives the runner's error, with its newlines", () => {
		const out = `GEN_ERROR:${JSON.stringify("no_results: mvn test (exit code 1)\n[ERROR] build")}\n`;
		expect(readGenRunnerOutput(out, 1)).toEqual({
			success: false,
			error: "no_results: mvn test (exit code 1)\n[ERROR] build",
		});
	});

	it("never trusts a result of a runner that failed", () => {
		expect(readGenRunnerOutput('GEN_RESULT:{"label":"v1"}', 1)).toEqual({
			success: false,
			error: "runner_failed: exit code 1",
		});
	});
});

describe("readReportFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "gen-report-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a report", async () => {
		const file = path.join(dir, "r.trx");
		writeFileSync(file, "<TestRun/>");
		expect(await readReportFile(file)).toBe("<TestRun/>");
	});

	it("refuses a report larger than the archive takes, and a folder", async () => {
		const file = path.join(dir, "big.xml");
		writeFileSync(file, Buffer.alloc(GEN_REPORT_MAX_BYTES + 1, 0x41));
		expect(await readReportFile(file)).toBeNull();
		expect(await readReportFile(dir)).toBeNull();
	});
});
