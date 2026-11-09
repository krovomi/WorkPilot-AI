/**
 * "Initialize Git" on a machine where git has no author identity.
 *
 * A first start on a fresh computer: no `user.name` / `user.email`, and git
 * refuses the first commit ("Author identity unknown"). The button used to
 * fail with that raw message; the reason now travels as a blocker the UI
 * answers with a name/email form, and the identity entered is saved where
 * git's own message says to put it.
 *
 * Real git in temp directories. The global config points at a temp file and
 * `user.useConfigOnly` turns off git's guess from the host name, so "no
 * identity" holds on every CI runner, whatever its host name.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGitIdentity } from "../git-identity";
import { initializeGit } from "../project-initializer";

const SAVED_ENV = { ...process.env };
let root: string;
let project: string;
let globalConfig: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-git-identity-"));
	project = path.join(root, "app");
	execFileSync("git", ["init", "-q", project]);
	writeFileSync(path.join(project, "README.md"), "# app\n", "utf-8");
	globalConfig = path.join(root, "gitconfig");
	writeFileSync(globalConfig, "", "utf-8");
	for (const key of Object.keys(process.env)) {
		// Also what a hook inherits from `git -c user.name=… commit`.
		if (/^(GIT_(AUTHOR|COMMITTER)_|GIT_CONFIG|EMAIL$)/.test(key)) delete process.env[key];
	}
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "user.useConfigOnly",
		GIT_CONFIG_VALUE_0: "true",
	});
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	rmSync(root, { recursive: true, force: true });
});

function commits(): string {
	return execFileSync("git", ["log", "--format=%an <%ae>"], {
		cwd: project,
		encoding: "utf-8",
	}).trim();
}

describe("initializeGit without a git identity", () => {
	it("stops on a blocker the UI can answer, not on git's raw error", () => {
		const result = initializeGit(project);
		expect(result.success).toBe(false);
		expect(result.blocker).toBe("git-identity-missing");
		expect(result.error).not.toMatch(/Author identity unknown/);
	});

	it("saves the identity given as the global one, then commits with it", () => {
		const result = initializeGit(project, undefined, {
			name: "Jeanne Dupont",
			email: "jeanne@example.com",
		});
		expect(result).toEqual({ success: true });
		expect(commits()).toBe("Jeanne Dupont <jeanne@example.com>");
		// Global, so the agents' commits in worktrees have an author too.
		const saved = readFileSync(globalConfig, "utf-8");
		expect(saved).toContain("Jeanne Dupont");
		expect(saved).toContain("jeanne@example.com");
	});

	it("asks nothing when git already knows who commits", () => {
		execFileSync("git", ["config", "user.name", "Local"], { cwd: project });
		execFileSync("git", ["config", "user.email", "local@example.com"], {
			cwd: project,
		});
		expect(initializeGit(project)).toEqual({ success: true });
		expect(commits()).toBe("Local <local@example.com>");
	});
});

describe("parseGitIdentity — what the renderer sends is checked again", () => {
	it("keeps a plain name and email, trimmed", () => {
		expect(parseGitIdentity({ name: "  Léa Martin ", email: " lea@ex.fr " })).toEqual({
			name: "Léa Martin",
			email: "lea@ex.fr",
		});
	});

	it.each([
		[undefined],
		["not an object"],
		[{ name: "A", email: "no-at-sign" }],
		[{ name: "", email: "a@b.c" }],
		// A newline would write another config entry.
		[{ name: "A\n[core]", email: "a@b.c" }],
		[{ name: "A <x>", email: "a@b.c" }],
		[{ name: "A", email: 42 }],
		[{ name: "x".repeat(201), email: "a@b.c" }],
	])("refuses %j", (input) => {
		expect(parseGitIdentity(input)).toBeNull();
	});
});
