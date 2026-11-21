/**
 * @vitest-environment node
 *
 * A project's forge settings against the remotes of its checkout: the remotes
 * read from git, the repository detected when none is saved, and a saved one
 * that names none of the project's remotes reported with the fixes offered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ output: "" as string | Error, calls: 0 }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: (_cmd: string, args: string[]) => {
		git.calls += 1;
		expect(args).toEqual(["remote", "-v"]);
		if (git.output instanceof Error) throw git.output;
		return git.output;
	},
}));
vi.mock("../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));

import {
	azureDevOpsBinding,
	detectedGitHubRepo,
	detectedGitLabProject,
	forgetGitRemotes,
	githubBinding,
	gitlabBinding,
	listGitRemotes,
	parseGitRemoteList,
	projectForgeBindings,
} from "../project-forge-binding";

const remotes = (...urls: string[]) => urls.map((url, i) => ({ name: i === 0 ? "origin" : `r${i}`, url }));

beforeEach(() => {
	git.output = "";
	git.calls = 0;
	forgetGitRemotes();
});

describe("parseGitRemoteList", () => {
	it("keeps one URL per remote, the fetch one, origin first", () => {
		expect(
			parseGitRemoteList(
				"upstream\thttps://github.com/up/x.git (fetch)\r\n" +
					"upstream\thttps://github.com/up/x.git (push)\n" +
					"origin\tgit@github.com:me/x.git (push)\n" +
					"origin\tgit@github.com:me/x.git (fetch)\n" +
					"pushonly\thttps://github.com/p/x.git (push)\n" +
					"garbage line\n",
			),
		).toEqual([
			{ name: "origin", url: "git@github.com:me/x.git" },
			{ name: "upstream", url: "https://github.com/up/x.git" },
			{ name: "pushonly", url: "https://github.com/p/x.git" },
		]);
	});
});

describe("listGitRemotes", () => {
	it("asks git once within the cache window, again once forgotten", () => {
		git.output = "origin\thttps://github.com/me/x.git (fetch)\n";
		expect(listGitRemotes("/p")).toEqual([{ name: "origin", url: "https://github.com/me/x.git" }]);
		expect(listGitRemotes("/p")).toHaveLength(1);
		expect(git.calls).toBe(1);

		forgetGitRemotes("/p");
		git.output = "";
		expect(listGitRemotes("/p")).toEqual([]);
		expect(git.calls).toBe(2);
	});

	it("answers no remote for a folder git refuses", () => {
		git.output = new Error("not a git repository");
		expect(listGitRemotes("/nope")).toEqual([]);
	});
});

describe("detection", () => {
	it("takes the first remote on the forge, origin first", () => {
		const list = remotes("https://gitlab.acme.dev/g/p.git", "https://github.com/me/x", "git@github.com:up/x.git");
		expect(detectedGitHubRepo(list)).toBe("me/x");
		expect(detectedGitLabProject(list, "gitlab.acme.dev")).toBe("g/p");
		expect(detectedGitLabProject(list, "gitlab.com")).toBeNull();
		expect(detectedGitHubRepo([])).toBeNull();
	});
});

describe("githubBinding", () => {
	it("matches a saved repository with one of the remotes, whatever its case", () => {
		const binding = githubBinding("Me/X", remotes("https://github.com/me/x.git"));
		expect(binding.status).toBe("matched");
		expect(binding.candidates).toEqual([{ label: "me/x", fix: { githubRepo: "me/x" } }]);
	});

	it("reports another project's repository as a mismatch, with the remote as the fix", () => {
		const binding = githubBinding(
			"krovomi/WorkPilot-AI",
			remotes("https://github.com/leub/dotnet.git", "https://github.com/leub/dotnet.git"),
		);
		expect(binding).toEqual({
			status: "mismatch",
			saved: "krovomi/WorkPilot-AI",
			candidates: [{ label: "leub/dotnet", fix: { githubRepo: "leub/dotnet" } }],
		});
	});

	it("reports a mismatch with no fix when the project lives on another forge", () => {
		const binding = githubBinding("krovomi/WorkPilot-AI", remotes("https://gitlab.com/g/p.git"));
		expect(binding.status).toBe("mismatch");
		expect(binding.candidates).toEqual([]);
	});

	it("says detected, unverified or none for the other cases", () => {
		expect(githubBinding("", remotes("https://github.com/me/x")).status).toBe("detected");
		expect(githubBinding("acme/shop", []).status).toBe("unverified");
		expect(githubBinding("  ", []).status).toBe("none");
	});
});

describe("gitlabBinding", () => {
	it("compares the project path on the configured instance", () => {
		const list = remotes("git@gitlab.acme.dev:team/app.git");
		expect(gitlabBinding("team/app", "gitlab.acme.dev", list).status).toBe("matched");
		expect(gitlabBinding("other/app", "gitlab.acme.dev", list).status).toBe("mismatch");
		expect(gitlabBinding("", "gitlab.acme.dev", list).candidates[0]?.fix).toEqual({
			gitlabProject: "team/app",
		});
	});

	it("cannot verify a numeric project id", () => {
		expect(gitlabBinding("1234", "gitlab.com", remotes("https://gitlab.com/g/p")).status).toBe(
			"unverified",
		);
	});
});

describe("azureDevOpsBinding", () => {
	const list = remotes("https://acme@dev.azure.com/acme/Shop/_git/api");

	it("matches organization, project and repository, whatever the case", () => {
		expect(
			azureDevOpsBinding(
				{
					azureDevOpsOrgUrl: "https://dev.azure.com/ACME/",
					azureDevOpsProject: "shop",
					azureDevOpsRepository: "API",
				},
				list,
			).status,
		).toBe("matched");
		// The organization as visualstudio.com names it is the same one.
		expect(
			azureDevOpsBinding(
				{ azureDevOpsOrgUrl: "https://acme.visualstudio.com", azureDevOpsProject: "Shop" },
				list,
			).status,
		).toBe("matched");
	});

	it("reports another repository, and offers the remote's three settings", () => {
		const binding = azureDevOpsBinding(
			{ azureDevOpsOrgUrl: "https://dev.azure.com/acme", azureDevOpsProject: "Shop", azureDevOpsRepository: "web" },
			list,
		);
		expect(binding.status).toBe("mismatch");
		expect(binding.saved).toBe("acme/Shop/web");
		expect(binding.candidates).toEqual([
			{
				label: "acme/Shop/api",
				fix: {
					azureDevOpsOrgUrl: "https://dev.azure.com/acme",
					azureDevOpsProject: "Shop",
					azureDevOpsRepository: "api",
				},
			},
		]);
	});

	it("says detected without a saved project, and ignores an organization URL it cannot read", () => {
		expect(azureDevOpsBinding({}, list).status).toBe("detected");
		expect(
			azureDevOpsBinding({ azureDevOpsOrgUrl: "not a url", azureDevOpsProject: "Shop" }, list).saved,
		).toBe("Shop");
		expect(
			azureDevOpsBinding({ azureDevOpsOrgUrl: "https://example.com/x", azureDevOpsProject: "Shop" }, list).status,
		).toBe("matched");
		expect(azureDevOpsBinding({}, [...list, ...list]).candidates).toHaveLength(1);
	});
});

describe("projectForgeBindings", () => {
	it("reads the three forges from the settings keys, normalized", () => {
		const bindings = projectForgeBindings(
			{
				GITHUB_REPO: "https://github.com/me/x.git",
				GITLAB_PROJECT: "team/app",
				GITLAB_INSTANCE_URL: "https://gitlab.acme.dev",
				AZURE_DEVOPS_PROJECT: "Shop",
			},
			remotes("https://github.com/me/x", "https://gitlab.acme.dev/team/app"),
			{
				githubRepo: (value) => value.replace("https://github.com/", "").replace(/\.git$/, ""),
				gitlabProject: (value) => value,
			},
		);
		expect(bindings.github.status).toBe("matched");
		expect(bindings.gitlab.status).toBe("matched");
		expect(bindings.azureDevOps.status).toBe("mismatch");
	});

	it("falls back to gitlab.com for a missing or unreadable instance URL", () => {
		const identity = { githubRepo: (v: string) => v, gitlabProject: (v: string) => v };
		const list = remotes("https://gitlab.com/g/p");
		expect(projectForgeBindings({}, list, identity).gitlab.status).toBe("detected");
		expect(projectForgeBindings({ GITLAB_INSTANCE_URL: "::" }, list, identity).gitlab.status).toBe("detected");
	});
});
