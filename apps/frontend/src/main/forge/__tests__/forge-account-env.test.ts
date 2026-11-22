/**
 * @vitest-environment node
 *
 * A project's settings name the account each forge uses by id only, and an id
 * the renderer sends must be an account saved for that forge
 * (forge-account-env.ts).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../forge-accounts", () => ({
	forgeAccountStore: () => ({
		get: (id: string) =>
			({
				gh: { id: "gh", forge: "github" },
				gl: { id: "gl", forge: "gitlab" },
				az: { id: "az", forge: "azure_devops" },
				bb: { id: "bb", forge: "bitbucket" },
			})[id],
	}),
}));

import {
	applyForgeAccountIds,
	forgeAccountIdRefusal,
	readForgeAccountIds,
} from "../forge-account-env";

describe("forge account ids in project settings", () => {
	it("accepts saved accounts of the right forge, and clearing", () => {
		expect(forgeAccountIdRefusal({})).toBeNull();
		expect(
			forgeAccountIdRefusal({
				githubAccountId: "gh",
				gitlabAccountId: "gl",
				azureDevOpsAccountId: "",
				bitbucketAccountId: "bb",
			}),
		).toBeNull();
	});

	it.each([
		[{ githubAccountId: "gl" }, "Unknown account (githubAccountId)"],
		[{ gitlabAccountId: "missing" }, "Unknown account (gitlabAccountId)"],
		[{ azureDevOpsAccountId: 7 }, "Invalid account (azureDevOpsAccountId)"],
		[{ bitbucketAccountId: "gh" }, "Unknown account (bitbucketAccountId)"],
	])("refuses %o", (config, reason) => {
		expect(forgeAccountIdRefusal(config as never)).toBe(reason);
	});

	it("writes the ids an update names, an empty one clearing the choice", () => {
		const vars: Record<string, string> = { GITLAB_ACCOUNT_ID: "gl", AZURE_DEVOPS_ACCOUNT_ID: "az" };
		applyForgeAccountIds({ githubAccountId: "gh", gitlabAccountId: "" }, vars);
		expect(vars).toEqual({ GITHUB_ACCOUNT_ID: "gh", GITLAB_ACCOUNT_ID: "", AZURE_DEVOPS_ACCOUNT_ID: "az" });
	});

	it("reads the ids the project names", () => {
		const config: Record<string, unknown> = {};
		readForgeAccountIds({ GITHUB_ACCOUNT_ID: " gh ", GITLAB_ACCOUNT_ID: "", BITBUCKET_ACCOUNT_ID: "bb" }, config);
		expect(config).toEqual({ githubAccountId: "gh", bitbucketAccountId: "bb" });
	});
});
