import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backendReloadArgs } from "./backend-reload-args";

describe("backendReloadArgs", () => {
	let backendDir: string;

	beforeEach(() => {
		backendDir = mkdtempSync(path.join(tmpdir(), "wp-reload-"));
	});

	afterEach(() => {
		rmSync(backendDir, { recursive: true, force: true });
	});

	it("does not watch anything in a packaged app", () => {
		mkdirSync(path.join(backendDir, ".venv"));
		expect(backendReloadArgs(backendDir, false)).toEqual([]);
	});

	it("excludes the backend venv by its absolute path when it exists", () => {
		mkdirSync(path.join(backendDir, ".venv"));
		const args = backendReloadArgs(backendDir, true);
		expect(args).toEqual([
			"--reload",
			"--reload-dir",
			backendDir,
			"--reload-exclude",
			path.resolve(backendDir, ".venv"),
		]);
		expect(path.isAbsolute(args[4])).toBe(true);
	});

	// uvicorn globs an absolute exclude that is not an existing directory and
	// dies with "Non-relative patterns are unsupported" before serving.
	it("passes no exclude when the backend has no venv of its own", () => {
		expect(backendReloadArgs(backendDir, true)).toEqual([
			"--reload",
			"--reload-dir",
			backendDir,
		]);
	});

	it("passes no exclude when .venv is a file, not a directory", () => {
		writeFileSync(path.join(backendDir, ".venv"), "", "utf-8");
		expect(backendReloadArgs(backendDir, true)).not.toContain(
			"--reload-exclude",
		);
	});

	it("never passes a wildcard, which Windows python.exe would expand", () => {
		mkdirSync(path.join(backendDir, ".venv"));
		for (const arg of backendReloadArgs(backendDir, true)) {
			expect(arg).not.toMatch(/[*?[]/);
		}
	});
});
