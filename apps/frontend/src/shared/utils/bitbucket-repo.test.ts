import { describe, expect, it } from "vitest";
import {
	bitbucketRepoFromRemote,
	isBitbucketSlug,
	normalizeBitbucketRepo,
} from "./bitbucket-repo";

describe("bitbucketRepoFromRemote", () => {
	it("reads workspace and slug from https, scp-like and ssh remotes", () => {
		const ref = { workspace: "acme", repo: "web-app" };
		expect(bitbucketRepoFromRemote("https://bitbucket.org/acme/web-app.git")).toEqual(ref);
		expect(bitbucketRepoFromRemote("https://dev@bitbucket.org/acme/web-app")).toEqual(ref);
		expect(bitbucketRepoFromRemote("git@bitbucket.org:acme/web-app.git")).toEqual(ref);
		expect(bitbucketRepoFromRemote("ssh://git@altssh.bitbucket.org:443/acme/web-app.git")).toEqual(
			ref,
		);
		expect(bitbucketRepoFromRemote(" https://bitbucket.org/acme/web-app/?x#y ")).toEqual(ref);
	});

	it("refuses another host and a path that is not workspace/repo", () => {
		expect(bitbucketRepoFromRemote("https://github.com/acme/web-app.git")).toBeNull();
		expect(bitbucketRepoFromRemote("https://bitbucket.org.evil.example/acme/web")).toBeNull();
		expect(bitbucketRepoFromRemote("https://bitbucket.org/acme")).toBeNull();
		expect(bitbucketRepoFromRemote("https://bitbucket.org/acme/web/src/main")).toBeNull();
		expect(bitbucketRepoFromRemote("https://bitbucket.org/acme/..")).toBeNull();
		expect(bitbucketRepoFromRemote("https://bitbucket.org/%2e%2e/web")).toBeNull();
	});
});

describe("normalizeBitbucketRepo", () => {
	it("accepts a slug beside its workspace, workspace/repo and a clone URL", () => {
		expect(normalizeBitbucketRepo("acme", "api")).toEqual({ workspace: "acme", repo: "api" });
		expect(normalizeBitbucketRepo(undefined, "acme/api.git")).toEqual({
			workspace: "acme",
			repo: "api",
		});
		expect(normalizeBitbucketRepo("other", "git@bitbucket.org:acme/api.git")).toEqual({
			workspace: "acme",
			repo: "api",
		});
	});

	it("names nothing for an empty repo, a missing workspace or hostile slugs", () => {
		expect(normalizeBitbucketRepo("acme", "")).toBeNull();
		expect(normalizeBitbucketRepo(undefined, undefined)).toBeNull();
		expect(normalizeBitbucketRepo("", "api")).toBeNull();
		expect(normalizeBitbucketRepo("acme", "../etc")).toBeNull();
		expect(normalizeBitbucketRepo("acme", "a/b/c")).toBeNull();
		expect(normalizeBitbucketRepo("-x", "api")).toBeNull();
		expect(normalizeBitbucketRepo("acme", "api?x=1")).toBeNull();
	});
});

describe("isBitbucketSlug", () => {
	it("holds a slug to Bitbucket's characters", () => {
		expect(isBitbucketSlug("web_app-2.0")).toBe(true);
		for (const bad of [".", "..", "-opt", "a b", "a/b", "", "x".repeat(129), 42, null]) {
			expect(isBitbucketSlug(bad)).toBe(false);
		}
	});
});
