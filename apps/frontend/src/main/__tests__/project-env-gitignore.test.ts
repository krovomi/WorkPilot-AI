/**
 * A project's `.workpilot/.env` holds its tokens: git must ignore it, whether
 * or not the project went through `initializeProject` — settings saved from
 * the add-project dialog, or a `.workpilot/` renamed from a legacy
 * `.auto-claude/`, never did.
 *
 * Real git in a temp directory, no mocks: whether a path is ignored is git's
 * answer, global excludes and negations included.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureProjectEnvIgnored } from "../project-initializer";

let project: string;

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: project,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function isIgnored(file: string): boolean {
	try {
		git(["check-ignore", "-q", "--", file]);
		return true;
	} catch {
		return false;
	}
}

function writeGitignore(content: string): void {
	writeFileSync(path.join(project, ".gitignore"), content, "utf-8");
}

beforeEach(() => {
	project = mkdtempSync(path.join(tmpdir(), "wp-env-ignore-"));
	mkdirSync(path.join(project, ".workpilot", "specs"), { recursive: true });
	writeFileSync(path.join(project, ".workpilot", ".env"), "GITHUB_TOKEN=x\n");
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

describe("ensureProjectEnvIgnored", () => {
	it("adds the .env to a repository that does not ignore it", async () => {
		git(["init"]);
		writeGitignore("node_modules/\n.auto-claude/\n");

		expect(await ensureProjectEnvIgnored(project, ".workpilot")).toBe(true);

		expect(isIgnored(".workpilot/.env")).toBe(true);
		expect(readFileSync(path.join(project, ".gitignore"), "utf-8")).toContain(
			".auto-claude/\n",
		);
	});

	it("leaves .gitignore alone when the directory is already ignored", async () => {
		git(["init"]);
		writeGitignore(".workpilot/\n");

		expect(await ensureProjectEnvIgnored(project, ".workpilot")).toBe(false);

		expect(readFileSync(path.join(project, ".gitignore"), "utf-8")).toBe(
			".workpilot/\n",
		);
	});

	it("keeps committing specs possible: only the file is ignored", async () => {
		git(["init"]);
		writeGitignore(".workpilot/worktrees/\n");

		expect(await ensureProjectEnvIgnored(project, ".workpilot")).toBe(true);

		expect(isIgnored(".workpilot/.env")).toBe(true);
		expect(isIgnored(".workpilot/specs/001-task/spec.md")).toBe(false);
	});

	it("writes nothing outside a git repository", async () => {
		expect(await ensureProjectEnvIgnored(project, ".workpilot")).toBe(false);

		expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
	});
});
