/**
 * Opening a folder in an IDE or a terminal: the folder comes from the
 * renderer and the launcher from settings, so neither may turn into code.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openPath: vi.fn() } }));

import {
	buildBatchLaunchArgs,
	buildCmdConsoleArgs,
	buildMacTerminalScript,
} from "../launch-args";
import { resolveCustomLauncher, resolveOpenableDir } from "../worktree-ide-terminal";

let root: string;
let project: string;
let outside: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-open-"));
	project = path.join(root, "project");
	outside = path.join(root, "outside");
	mkdirSync(path.join(project, ".workpilot", "worktrees", "tasks", "001"), {
		recursive: true,
	});
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(project, "README.md"), "x");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveOpenableDir", () => {
	it("accepts a folder inside a known project", () => {
		const worktree = path.join(project, ".workpilot", "worktrees", "tasks", "001");
		expect(resolveOpenableDir(worktree, [project])).toBeTruthy();
	});

	it.each([
		["a folder of no project", () => outside],
		["a traversal out of the project", () => path.join(project, "..", "outside")],
		["a file, not a folder", () => path.join(project, "README.md")],
		["a relative path", () => "project"],
		["a missing folder", () => path.join(project, "nope")],
		["a non-string", () => ({ toString: () => project })],
	])("refuses %s", (_label, target) => {
		expect(resolveOpenableDir(target(), [project])).toBeNull();
	});

	it("refuses a symlink inside the project that points outside", () => {
		const link = path.join(project, "escape");
		try {
			symlinkSync(outside, link, "dir");
		} catch {
			return; // symlinks need privileges on some Windows runners
		}
		expect(resolveOpenableDir(link, [project])).toBeNull();
	});
});

describe("resolveCustomLauncher", () => {
	it("accepts an absolute path to an existing file", () => {
		const launcher = path.join(root, "my-ide");
		writeFileSync(launcher, "");
		expect(resolveCustomLauncher(launcher)).toBeTruthy();
	});

	it.each([
		["undefined", undefined],
		["a bare command", "code"],
		["a missing file", "/definitely/not/here/ide"],
		["a command line", "/bin/sh -c id"],
	])("refuses %s", (_label, value) => {
		expect(resolveCustomLauncher(value)).toBeNull();
	});
});

describe("cmd.exe lines", () => {
	it("quotes the folder for a batch launcher", () => {
		expect(buildBatchLaunchArgs("code.cmd", "C:\\Repos\\a&calc")).toEqual([
			"/d",
			"/s",
			"/c",
			'"code.cmd "C:\\Repos\\a&calc""',
		]);
	});

	it("quotes the folder for a console", () => {
		expect(buildCmdConsoleArgs("C:\\Repos\\a&calc")).toEqual([
			"/d",
			"/s",
			"/k",
			'"cd /d "C:\\Repos\\a&calc""',
		]);
	});

	it.each([
		'C:\\Repos\\a" & calc & "',
		"C:\\Repos\\%COMSPEC%",
		"C:\\Repos\\a\r\ncalc",
	])("refuses %j, which quotes cannot protect", (dirPath) => {
		expect(buildBatchLaunchArgs("code.cmd", dirPath)).toBeNull();
		expect(buildCmdConsoleArgs(dirPath)).toBeNull();
	});
});

describe("buildMacTerminalScript", () => {
	it.each(["system", "iterm2"] as const)(
		"reads the folder from argv for %s, never from its source",
		(terminal) => {
			const script = buildMacTerminalScript(terminal);
			expect(script).toContain("on run argv");
			expect(script).toContain("quoted form of (item 1 of argv)");
			expect(script).not.toContain("'");
		},
	);
});
