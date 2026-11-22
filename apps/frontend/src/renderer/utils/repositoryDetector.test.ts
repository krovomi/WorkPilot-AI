/** @vitest-environment jsdom */
/**
 * A project's forge is turned on from its remote: GitHub, GitLab, Azure DevOps
 * or Bitbucket, the others off; an unknown remote changes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";
import { autoDetectAndUpdateProject } from "./repositoryDetector";

function install(provider: string) {
	const updateProjectEnv = vi.fn(async () => ({ success: true }));
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		checkGitStatus: vi.fn(async () => ({ success: true, data: { isGitRepo: true } })),
		readFile: vi.fn(async () => ({ success: false })),
		detectRepoProvider: vi.fn(async () => ({
			success: true,
			data: { provider, remoteUrl: "git@example:a/b.git" },
		})),
		updateProjectEnv,
	};
	return updateProjectEnv;
}

const project = { id: "p1", path: "/p" } as Project;

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("autoDetectAndUpdateProject", () => {
	it.each([
		["github", { githubEnabled: true, azureDevOpsEnabled: false }],
		["gitlab", { githubEnabled: false, gitlabEnabled: true, azureDevOpsEnabled: false }],
		["azure_devops", { githubEnabled: false, azureDevOpsEnabled: true }],
		["bitbucket", { githubEnabled: false, azureDevOpsEnabled: false, bitbucketEnabled: true }],
	])("turns %s on from its remote", async (provider, expected) => {
		const updateProjectEnv = install(provider);
		const result = await autoDetectAndUpdateProject(project);
		expect(result.success).toBe(true);
		expect(updateProjectEnv).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ ...expected, jiraEnabled: false }),
		);
	});

	it("changes nothing for an unknown remote", async () => {
		const updateProjectEnv = install("unknown");
		expect(await autoDetectAndUpdateProject(project)).toEqual({
			success: false,
			error: "Unknown repository provider",
		});
		expect(updateProjectEnv).not.toHaveBeenCalled();
	});
});
