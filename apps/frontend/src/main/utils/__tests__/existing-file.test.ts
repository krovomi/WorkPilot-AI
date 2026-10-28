import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readIfExists, updateExistingFile } from "../existing-file";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "existing-file-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readIfExists", () => {
	it("reads a file and answers null for a missing one", () => {
		const file = path.join(dir, "a.json");
		writeFileSync(file, "{}", "utf-8");
		expect(readIfExists(file)).toBe("{}");
		expect(readIfExists(path.join(dir, "missing.json"))).toBeNull();
	});
});

describe("updateExistingFile", () => {
	it("rewrites the file in place, shorter content included", () => {
		const file = path.join(dir, "plan.json");
		writeFileSync(file, '{"status":"human_review","long":"xxxxxxxx"}', "utf-8");
		expect(updateExistingFile(file, () => '{"status":"x"}')).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe('{"status":"x"}');
	});

	it("leaves the file untouched when update answers null", () => {
		const file = path.join(dir, "same.json");
		writeFileSync(file, "keep", "utf-8");
		expect(updateExistingFile(file, () => null)).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("keep");
	});

	it("creates nothing when the file is missing", () => {
		const file = path.join(dir, "missing.json");
		let called = false;
		expect(
			updateExistingFile(file, () => {
				called = true;
				return "x";
			}),
		).toBe(false);
		expect(called).toBe(false);
		expect(readIfExists(file)).toBeNull();
	});
});
