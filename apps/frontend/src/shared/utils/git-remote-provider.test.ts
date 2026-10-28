import { describe, expect, it } from "vitest";
import { gitRemoteHost, providerFromRemoteUrl } from "./git-remote-provider";

describe("gitRemoteHost", () => {
	it("reads the host of https, ssh and scp-like remotes", () => {
		expect(gitRemoteHost("https://github.com/o/r.git")).toBe("github.com");
		expect(gitRemoteHost("git@github.com:o/r.git")).toBe("github.com");
		expect(gitRemoteHost("ssh://git@ssh.dev.azure.com:22/v3/o/p/r")).toBe(
			"ssh.dev.azure.com",
		);
		expect(gitRemoteHost("https://user@Org.VisualStudio.com/p/_git/r")).toBe(
			"org.visualstudio.com",
		);
	});
});

describe("providerFromRemoteUrl", () => {
	it("names the forge from the host", () => {
		expect(providerFromRemoteUrl("git@github.com:o/r.git")).toBe("github");
		expect(providerFromRemoteUrl("https://dev.azure.com/o/p/_git/r")).toBe(
			"azure_devops",
		);
		expect(providerFromRemoteUrl("git@ssh.dev.azure.com:v3/o/p/r")).toBe(
			"azure_devops",
		);
		expect(providerFromRemoteUrl("https://org.visualstudio.com/p/_git/r")).toBe(
			"azure_devops",
		);
	});

	it("is not fooled by a forge name outside the host", () => {
		expect(providerFromRemoteUrl("https://evil.example/github.com/o/r")).toBe(
			"unknown",
		);
		expect(providerFromRemoteUrl("https://github.com.evil.example/o/r")).toBe(
			"unknown",
		);
		expect(providerFromRemoteUrl("https://notgithub.com/o/r")).toBe("unknown");
		expect(
			providerFromRemoteUrl("https://evil.example/?dev.azure.com/o/p"),
		).toBe("unknown");
	});
});
