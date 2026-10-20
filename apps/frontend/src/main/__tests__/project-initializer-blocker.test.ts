/**
 * What stops an initialization, and whether the UI can tell.
 *
 * `initializeProject` refuses for four different reasons and used to say so in
 * one English sentence. The settings screen could then only print it: two of
 * the four are one click away from being fixed, and the user was left reading
 * "Git repository has no commits. Please make an initial commit first." with
 * no way to act on it inside the app. The reason now travels as a value, and
 * these tests pin each one to the situation that produces it.
 *
 * Real git in a temp directory, no mocks. Every branch here is a decision
 * about the state of a repository on disk; a mocked `git` would only prove
 * that the mock says what the test told it to.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../project-initializer";

let project: string;

function run(args: string[]) {
	execFileSync("git", args, { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
}

/** A repository with nothing committed yet. */
function initRepo() {
	run(["init"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "Test"]);
}

/** …and one with a first commit. */
function commit() {
	writeFileSync(path.join(project, "README.md"), "# test\n", "utf-8");
	run(["add", "-A"]);
	run(["commit", "-m", "Initial commit"]);
}

beforeEach(() => {
	project = mkdtempSync(path.join(tmpdir(), "wp-init-"));
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

describe("initializeProject — the reason it refused", () => {
	it("a folder that is not a repository is reported as such", () => {
		const result = initializeProject(project);
		expect(result.success).toBe(false);
		expect(result.blocker).toBe("not-a-git-repo");
	});

	it("a repository with no commit is a different blocker", () => {
		// The distinction is the point: one needs `git init`, the other only a
		// first commit, and the recovery card offers the right steps for each.
		initRepo();

		const result = initializeProject(project);
		expect(result.success).toBe(false);
		expect(result.blocker).toBe("no-commits");
	});

	it("a missing folder is not offered a git repair", () => {
		const result = initializeProject(path.join(project, "gone"));
		expect(result.success).toBe(false);
		expect(result.blocker).toBe("path-missing");
	});

	it("an already-initialized project says so instead of failing blankly", () => {
		initRepo();
		commit();
		mkdirSync(path.join(project, ".workpilot"));

		const result = initializeProject(project);
		expect(result.success).toBe(false);
		expect(result.blocker).toBe("already-initialized");
	});

	it("a buildable repository carries no blocker at all", () => {
		initRepo();
		commit();

		const result = initializeProject(project);
		expect(result.success).toBe(true);
		expect(result.blocker).toBeUndefined();
		expect(existsSync(path.join(project, ".workpilot", "specs"))).toBe(true);
	});
});
