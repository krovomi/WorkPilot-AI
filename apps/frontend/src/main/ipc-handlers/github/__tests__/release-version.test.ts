/**
 * @vitest-environment node
 *
 * The version the release dialog suggests, from a real git repository: the
 * commits since the last tag go to the suggester, the bump is read from the
 * versions it answers, and a package version that is not semver never turns
 * into "NaN".
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	suggest: vi.fn(),
}));
vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));
vi.mock("../../../changelog-service", () => ({
	changelogService: { suggestVersionFromCommits: state.suggest },
}));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { GitCommit, VersionSuggestion } from "../../../../shared/types";
import { registerSuggestVersion } from "../release-handlers";

type Result = { success: boolean; error?: string; data?: VersionSuggestion };
const suggest = (projectId = "p"): Promise<Result> =>
	(
		ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result> }
	).invokeHandler(IPC_CHANNELS.RELEASE_SUGGEST_VERSION, {}, projectId);

let root: string;
// A git hook running this test sets GIT_INDEX_FILE and the author: none of
// it may reach the repository made here.
const gitEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
	GIT_AUTHOR_NAME: "Ana | Lima",
	GIT_AUTHOR_EMAIL: "ana@example.invalid",
	GIT_COMMITTER_NAME: "Ana | Lima",
	GIT_COMMITTER_EMAIL: "ana@example.invalid",
};
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe", env: gitEnv });
const commit = (subject: string) => git("commit", "--allow-empty", "-q", "-m", subject);
const pkg = (version: unknown) => writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));

registerSuggestVersion();

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-release-version-"));
	git("init", "-q");
	state.project = { id: "p", path: root };
	state.suggest.mockReset();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("RELEASE_SUGGEST_VERSION", () => {
	it("sends the commits since the last tag, a subject with a pipe kept whole", async () => {
		pkg("1.4.2");
		commit("chore: before the tag");
		git("tag", "v1.4.2");
		commit("feat: export | import");
		commit("fix: crash");
		state.suggest.mockResolvedValue({ version: "1.5.0", reason: "New features were added" });

		const result = await suggest();

		expect(result).toEqual({
			success: true,
			data: {
				suggestedVersion: "1.5.0",
				currentVersion: "1.4.2",
				bumpType: "minor",
				reason: "New features were added",
				commitCount: 2,
			},
		});
		const [projectPath, commits, current] = state.suggest.mock.calls[0] as [string, GitCommit[], string];
		expect(projectPath).toBe(root);
		expect(current).toBe("1.4.2");
		expect(commits.map((c) => c.subject)).toEqual(["fix: crash", "feat: export | import"]);
		expect(commits[0]).toMatchObject({ author: "Ana | Lima", authorEmail: "ana@example.invalid" });
		expect(commits[0].hash).toBe(commits[0].fullHash.slice(0, 7));
		expect(Number.isNaN(Date.parse(commits[0].date))).toBe(false);
	});

	it.each([
		["2.0.0", "Breaking change in the API", "major"],
		["1.5.0", "Breaking change in the API", "minor"],
		["1.4.3", "New feature, minor bump", "patch"],
		["not a version", "odd", "patch"],
	])("reads %j as a %s bump, whatever the reason says", async (version, reason, bumpType) => {
		pkg("1.4.2");
		commit("feat: x");
		state.suggest.mockResolvedValue({ version, reason });

		expect((await suggest()).data?.bumpType).toBe(bumpType);
	});

	it("takes every commit when there is no tag yet", async () => {
		pkg("0.1.0");
		commit("a");
		commit("b");
		state.suggest.mockResolvedValue({ version: "0.1.1", reason: "fixes" });

		expect((await suggest()).data?.commitCount).toBe(2);
	});

	it("suggests the next patch when nothing was committed since the tag", async () => {
		pkg("1.4.2-beta.1");
		commit("release");
		git("tag", "v1.4.2-beta.1");

		expect((await suggest()).data).toEqual({
			suggestedVersion: "1.4.3",
			currentVersion: "1.4.2-beta.1",
			bumpType: "patch",
			reason: "No new commits since last release",
			commitCount: 0,
		});
		expect(state.suggest).not.toHaveBeenCalled();
	});

	it.each([
		["no package.json", undefined],
		["a version that is not a string", 3],
		["an empty version", ""],
		["a broken package.json", "{broken"],
	])("counts from 0.0.0 with %s", async (_, version) => {
		if (version === "{broken") writeFileSync(path.join(root, "package.json"), "{broken");
		else if (version !== undefined) pkg(version);

		expect((await suggest()).data).toMatchObject({ suggestedVersion: "0.0.1", currentVersion: "0.0.0" });
	});

	it("falls back to the next patch when the suggester fails, and never answers NaN", async () => {
		pkg("2.1");
		commit("feat: x");
		state.suggest.mockRejectedValue(new Error("no provider"));

		expect((await suggest()).data).toEqual({
			suggestedVersion: "2.1.1",
			currentVersion: "2.1",
			bumpType: "patch",
			reason: "Fallback suggestion (AI analysis unavailable)",
			commitCount: 0,
		});

		pkg("3");
		expect((await suggest()).data?.suggestedVersion).toBe("3.0.1");
		pkg("v2.1.9");
		expect((await suggest()).data?.suggestedVersion).toBe("2.1.10");
	});

	it("counts a package version that is not one from 0.0.0", async () => {
		pkg("workspace");
		commit("feat: x");
		state.suggest.mockResolvedValueOnce({ version: "1.0.0", reason: "Invalid current version, resetting to 1.0.0" });
		expect((await suggest()).data).toMatchObject({ suggestedVersion: "1.0.0", bumpType: "major" });

		state.suggest.mockRejectedValueOnce(new Error("no provider"));
		expect((await suggest()).data).toMatchObject({ suggestedVersion: "0.0.1", currentVersion: "workspace" });
	});

	it("answers an unknown project, and a folder that is not a repository", async () => {
		state.project = undefined;
		expect(await suggest("nope")).toEqual({ success: false, error: "Project not found" });

		rmSync(path.join(root, ".git"), { recursive: true, force: true });
		state.project = { id: "p", path: root };
		pkg("1.0.0");
		expect((await suggest()).data).toMatchObject({ suggestedVersion: "1.0.1", commitCount: 0 });
	});
});
