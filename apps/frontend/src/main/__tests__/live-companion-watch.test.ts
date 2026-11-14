/**
 * What the Live Companion watches and reads.
 *
 * chokidar 4+ (the app ships 6) has no glob support: the companion passed it
 * `**\/*.ts`-style patterns, watched nothing and never saw a change. It now
 * watches the folder through the predicate under test here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildIgnoredPredicate,
	DEFAULT_IGNORE_PATTERNS,
	DEFAULT_WATCH_PATTERNS,
	detectLanguage,
	isLegacyWatchPatterns,
	readChangeContent,
} from "../live-companion-watch";

const file = { isFile: () => true };
const dir = { isFile: () => false };

describe("buildIgnoredPredicate", () => {
	const root = path.resolve("/work/project");
	const ignored = buildIgnoredPredicate(
		root,
		DEFAULT_WATCH_PATTERNS,
		DEFAULT_IGNORE_PATTERNS,
	);
	const at = (relative: string) => path.join(root, relative);

	it.each([
		"src/app.ts",
		"Pages/Index.razor",
		"Controllers/HomeController.cs",
		"app/src/main/kotlin/Main.kt",
		"ios/App/AppDelegate.swift",
		"lib/main.dart",
		"src/lib.rs",
		"cmd/main.go",
		"src/Main.java",
		"public/index.php",
		"app/models/user.rb",
		"src/app/app.component.html",
		"components/Card.vue",
		"apps/backend/main.py",
	])("watches %s", (relative) => {
		expect(ignored(at(relative), file)).toBe(false);
	});

	it.each([
		"node_modules/react/index.js",
		".git/HEAD",
		".workpilot/worktrees/tasks/001/src/app.ts",
		"bin/Debug/app.dll",
		"obj/project.assets.json",
		"target/debug/main.rs",
		".dart_tool/package_config.json",
		"ios/Pods/Foo/Foo.swift",
		".next/server/page.js",
		"vendor/autoload.php",
		"dist/bundle.min.js",
		"README.md",
		"image.png",
	])("ignores %s", (relative) => {
		expect(ignored(at(relative), file)).toBe(true);
	});

	it("never descends into an ignored folder, and walks the others", () => {
		expect(ignored(at("node_modules"), dir)).toBe(true);
		expect(ignored(at("src/bin"), undefined)).toBe(true);
		expect(ignored(at("src"), dir)).toBe(false);
		expect(ignored(root, dir)).toBe(false);
	});

	it("reads the user's own patterns", () => {
		const own = buildIgnoredPredicate(root, ["**/*.sql"], ["**/migrations/**"]);
		expect(own(at("db/schema.sql"), file)).toBe(false);
		expect(own(at("db/migrations/001.sql"), file)).toBe(true);
		expect(own(at("src/app.ts"), file)).toBe(true);
	});
});

describe("isLegacyWatchPatterns", () => {
	it("recognises the defaults frozen in configs written before this fix", () => {
		expect(
			isLegacyWatchPatterns([
				"**/*.ts",
				"**/*.tsx",
				"**/*.js",
				"**/*.jsx",
				"**/*.py",
				"**/*.rs",
				"**/*.go",
				"**/*.java",
				"**/*.cs",
				"**/*.rb",
				"**/*.php",
				"**/*.vue",
				"**/*.svelte",
			]),
		).toBe(true);
		expect(isLegacyWatchPatterns(["**/*.ts"])).toBe(false);
		expect(isLegacyWatchPatterns(undefined)).toBe(false);
	});
});

describe("detectLanguage", () => {
	it("names the stacks the app supports", () => {
		expect(detectLanguage("a/Index.razor")).toBe("Razor (Blazor)");
		expect(detectLanguage("lib/main.dart")).toBe("Dart");
		expect(detectLanguage("Main.KT")).toBe("Kotlin");
		expect(detectLanguage("notes.txt")).toBe("Unknown");
	});
});

describe("readChangeContent", () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });

	beforeEach(() => {
		repo = mkdtempSync(path.join(os.tmpdir(), "wp-companion-"));
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		git("config", "commit.gpgsign", "false");
		mkdirSync(path.join(repo, "src"));
		writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("sends the git diff of a tracked file", () => {
		writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		const content = readChangeContent(repo, "src/a.ts", "modified");
		expect(content.kind).toBe("diff");
		expect(content.text).toContain("+export const a = 2;");
	});

	it("sends nothing for a tracked file saved without a change", () => {
		expect(readChangeContent(repo, "src/a.ts", "modified").text).toBe("");
	});

	it("sends the head of a new or untracked file", () => {
		writeFileSync(path.join(repo, "src", "b.py"), "def b():\n    return 1\n");
		for (const change of ["created", "modified"]) {
			const content = readChangeContent(repo, "src/b.py", change);
			expect(content.kind).toBe("file");
			expect(content.text).toContain("def b():");
		}
	});

	it("sends nothing for a deletion or a binary file", () => {
		writeFileSync(path.join(repo, "src", "c.ts"), Buffer.from([0x61, 0x00, 0x62]));
		expect(readChangeContent(repo, "src/c.ts", "created").text).toBe("");
		expect(readChangeContent(repo, "src/a.ts", "deleted").text).toBe("");
	});
});
