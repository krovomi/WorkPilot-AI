import { describe, expect, it } from "vitest";
import {
	azureRepoOfRemote,
	gitRemotePath,
	githubRepoOfRemote,
	gitlabProjectOfRemote,
} from "./git-remote-repo";

describe("gitRemotePath", () => {
	it("reads the path of https, ssh and scp-like remotes", () => {
		expect(gitRemotePath("https://github.com/o/r.git")).toBe("o/r");
		expect(gitRemotePath("ssh://git@host:22/g/s/p.git")).toBe("g/s/p");
		expect(gitRemotePath("git@github.com:o/r.git")).toBe("o/r");
		expect(gitRemotePath("https://host/o/r/?x=1#y")).toBe("o/r");
		expect(gitRemotePath("https://host")).toBe("");
	});

	it("reads nothing from what is not a remote URL", () => {
		expect(gitRemotePath("/local/bare/repo")).toBe("");
		expect(gitRemotePath("")).toBe("");
	});
});

describe("githubRepoOfRemote", () => {
	it("names owner/repo of a github.com remote", () => {
		expect(githubRepoOfRemote("https://github.com/acme/shop.git")).toBe("acme/shop");
		expect(githubRepoOfRemote("git@github.com:acme/shop.git")).toBe("acme/shop");
		expect(githubRepoOfRemote("https://user@www.github.com/acme/shop")).toBe("acme/shop");
	});

	it("names nothing off github.com, or with another path shape", () => {
		expect(githubRepoOfRemote("https://github.com.evil.example/acme/shop")).toBeNull();
		expect(githubRepoOfRemote("https://evil.example/github.com/acme/shop")).toBeNull();
		expect(githubRepoOfRemote("https://gitlab.com/acme/shop")).toBeNull();
		expect(githubRepoOfRemote("https://github.com/acme")).toBeNull();
		expect(githubRepoOfRemote("https://github.com/acme/shop/extra")).toBeNull();
		expect(githubRepoOfRemote("https://github.com/acme/..")).toBeNull();
		expect(githubRepoOfRemote("https://github.com/ac me/shop")).toBeNull();
	});
});

describe("gitlabProjectOfRemote", () => {
	it("names the project path of a remote on the instance, subgroups included", () => {
		expect(gitlabProjectOfRemote("git@gitlab.com:g/sub/p.git")).toBe("g/sub/p");
		expect(gitlabProjectOfRemote("https://gitlab.acme.dev/g/p.git", "gitlab.acme.dev")).toBe("g/p");
		expect(gitlabProjectOfRemote("https://gitlab.acme.dev/g/p", "GitLab.Acme.Dev:8443")).toBe("g/p");
	});

	it("names nothing on another host, without a project or with a hostile path", () => {
		expect(gitlabProjectOfRemote("https://github.com/g/p")).toBeNull();
		expect(gitlabProjectOfRemote("https://gitlab.com.evil.example/g/p")).toBeNull();
		expect(gitlabProjectOfRemote("https://gitlab.com/g")).toBeNull();
		expect(gitlabProjectOfRemote("https://gitlab.com/g/../p")).toBeNull();
		expect(gitlabProjectOfRemote("https://gitlab.com/g/p", "")).toBeNull();
	});
});

describe("azureRepoOfRemote", () => {
	it("reads dev.azure.com, ssh and visualstudio.com remotes", () => {
		expect(azureRepoOfRemote("https://acme@dev.azure.com/acme/My%20Project/_git/api")).toEqual({
			orgUrl: "https://dev.azure.com/acme",
			project: "My Project",
			repository: "api",
		});
		expect(azureRepoOfRemote("git@ssh.dev.azure.com:v3/acme/Proj/api")).toEqual({
			orgUrl: "https://dev.azure.com/acme",
			project: "Proj",
			repository: "api",
		});
		expect(azureRepoOfRemote("https://acme.visualstudio.com/DefaultCollection/Proj/_git/api")).toEqual({
			orgUrl: "https://acme.visualstudio.com",
			project: "Proj",
			repository: "api",
		});
		expect(azureRepoOfRemote("https://acme.visualstudio.com/Proj/_git/api")?.project).toBe("Proj");
	});

	it("reads nothing from another host or another path shape", () => {
		expect(azureRepoOfRemote("https://github.com/acme/api")).toBeNull();
		expect(azureRepoOfRemote("https://dev.azure.com/acme/Proj/api")).toBeNull();
		expect(azureRepoOfRemote("git@ssh.dev.azure.com:v2/acme/Proj/api")).toBeNull();
		expect(azureRepoOfRemote("https://acme.visualstudio.com/Proj/api")).toBeNull();
		expect(azureRepoOfRemote("https://dev.azure.com/-acme/Proj/_git/api")).toBeNull();
	});

	it("refuses names that decode into a path or a control character", () => {
		expect(azureRepoOfRemote("https://dev.azure.com/acme/a%2Fb/_git/api")).toBeNull();
		expect(azureRepoOfRemote("https://dev.azure.com/acme/Proj/_git/%2E%2E")).toBeNull();
		expect(azureRepoOfRemote("https://dev.azure.com/acme/Proj/_git/a%0Ab")).toBeNull();
		expect(azureRepoOfRemote("https://dev.azure.com/acme/Proj/_git/%E0%A4%A")).toBeNull();
	});
});
