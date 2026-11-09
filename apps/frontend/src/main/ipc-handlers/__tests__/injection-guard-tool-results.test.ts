/**
 * The Injection Guard page's view of what the agents read (#388): flagged tool
 * results of every task, and the person's trusted sources, revalidated in main.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ALERTS_FILENAME,
	readToolResultAlerts,
	readTrustedSources,
	TRUSTED_SOURCES_FILE,
	validateTrustedSources,
	writeTrustedSources,
} from "../injection-guard-tool-results";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-guard-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeAlerts(dir: string, lines: string[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, ALERTS_FILENAME), `${lines.join("\n")}\n`, "utf-8");
}

const alert = (at: string, source: string, level = "suspect") =>
	JSON.stringify({ at, tool: "Read", source, level, findings: ["override"], action: "fenced" });

describe("validateTrustedSources", () => {
	it("keeps the well-formed entries once, in order", () => {
		expect(
			validateTrustedSources({
				sources: ["path:tests/*", "host:docs.python.org", "path:tests/*", "*", "path:*", "x:y", 3],
			}),
		).toEqual(["path:tests/*", "host:docs.python.org"]);
		expect(validateTrustedSources("path:a")).toEqual([]);
	});
});

describe("trusted sources", () => {
	it("writes the valid entries and reads them back", () => {
		expect(writeTrustedSources(root, ["command:gh issue", "bad"])).toEqual(["command:gh issue"]);
		expect(readTrustedSources(root)).toEqual(["command:gh issue"]);
		const saved = JSON.parse(readFileSync(path.join(root, TRUSTED_SOURCES_FILE), "utf-8"));
		expect(saved).toEqual({ sources: ["command:gh issue"] });
	});

	it("refuses to write through a link", () => {
		const elsewhere = mkdtempSync(path.join(tmpdir(), "wp-elsewhere-"));
		try {
			symlinkSync(elsewhere, path.join(root, ".workpilot"));
			expect(() => writeTrustedSources(root, ["path:a"])).toThrow();
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("neither reads nor writes a linked list", () => {
		const elsewhere = mkdtempSync(path.join(tmpdir(), "wp-elsewhere-"));
		try {
			const target = path.join(elsewhere, "sources.json");
			writeFileSync(target, JSON.stringify({ sources: ["path:x"] }));
			mkdirSync(path.join(root, ".workpilot"));
			symlinkSync(target, path.join(root, TRUSTED_SOURCES_FILE));
			expect(readTrustedSources(root)).toEqual([]);
			expect(() => writeTrustedSources(root, ["path:a"])).toThrow();
			expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ sources: ["path:x"] });
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("overwrites a longer list completely", () => {
		writeTrustedSources(root, ["path:tests/fixtures/very/long/folder/*", "host:docs.python.org"]);
		expect(writeTrustedSources(root, ["path:a"])).toEqual(["path:a"]);
		expect(readTrustedSources(root)).toEqual(["path:a"]);
	});

	it("reads nothing when there is no list", () => {
		expect(readTrustedSources(root)).toEqual([]);
	});
});

describe("readToolResultAlerts", () => {
	it("gathers every task's alerts, worktrees included, newest first, once each", () => {
		const main = path.join(root, ".workpilot", "specs", "001-a");
		const tree = path.join(root, ".workpilot", "worktrees", "tasks", "001-a", ".workpilot", "specs", "001-a");
		writeAlerts(main, [alert("2026-11-09T10:00:00+00:00", "path:a.md")]);
		writeAlerts(tree, [
			alert("2026-11-09T10:00:00+00:00", "path:a.md"),
			alert("2026-11-09T11:00:00+00:00", "host:evil.example", "blocked"),
			"not json",
			JSON.stringify({ at: "x", source: "y", level: "safe" }),
		]);
		const alerts = readToolResultAlerts(root);
		expect(alerts.map((a) => a.source)).toEqual(["host:evil.example", "path:a.md"]);
		expect(alerts[0]).toMatchObject({ spec: "001-a", level: "blocked", tool: "Read" });
	});

	it("is empty for a project without tasks", () => {
		expect(readToolResultAlerts(root)).toEqual([]);
	});
});
