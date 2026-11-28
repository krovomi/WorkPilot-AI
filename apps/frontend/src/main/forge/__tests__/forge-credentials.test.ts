/**
 * @vitest-environment node
 *
 * A project's forge readers get the token of the account it names, with the
 * address that token was saved for (forge-credentials.ts); a project naming
 * no account is read as it is, and one naming a missing account gets no token.
 */

import { describe, expect, it, vi } from "vitest";
import type { ForgeAccountView } from "../../../shared/types/forge-accounts";
import type { ForgeAccountStore } from "../forge-accounts";

vi.mock("../../project-env-file", () => ({
	readProjectEnv: () => ({ GITHUB_ACCOUNT_ID: "gh", GITHUB_TOKEN: "pat-test-project" }),
}));
vi.mock("../forge-accounts", () => ({
	forgeAccountStore: () => fakeStore(),
}));

import {
	FORGE_ACCOUNT_KEYS,
	projectForgeAccountId,
	readProjectForgeEnv,
	withForgeAccounts,
} from "../forge-credentials";

const ACCOUNTS: ForgeAccountView[] = [
	{ id: "gh", forge: "github", label: "Work", host: "https://github.com", hasToken: true, createdAt: "" },
	{ id: "gl", forge: "gitlab", label: "Client", host: "https://gitlab.example.com", hasToken: true, createdAt: "" },
	{ id: "az", forge: "azure_devops", label: "Org", host: "https://dev.azure.com/contoso", hasToken: true, createdAt: "" },
	{ id: "bb", forge: "bitbucket", label: "Me", host: "https://bitbucket.org", username: "me@example.com", hasToken: true, createdAt: "" },
	{ id: "empty", forge: "github", label: "None", host: "https://github.com", hasToken: false, createdAt: "" },
];

const TOKENS: Record<string, string> = {
	gh: "pat-test-github",
	gl: "pat-test-gitlab",
	az: "pat-test-azure",
	bb: "pat-test-bitbucket",
};

function fakeStore(): ForgeAccountStore {
	return {
		get: (id: string) => ACCOUNTS.find((account) => account.id === id),
		tokenOf: (id: string) => TOKENS[id],
	} as unknown as ForgeAccountStore;
}

describe("withForgeAccounts", () => {
	it("returns the very same variables when no account is named", () => {
		const vars = { GITHUB_TOKEN: "pat-test-project", GITHUB_ACCOUNT_ID: "  " };
		const store = { get: vi.fn() } as unknown as ForgeAccountStore;
		expect(withForgeAccounts(vars, store)).toBe(vars);
		expect(store.get).not.toHaveBeenCalled();
	});

	it("lends each named account's token and address, without changing the input", () => {
		const vars = {
			GITHUB_ACCOUNT_ID: "gh",
			GITHUB_TOKEN: "pat-test-project",
			GITLAB_ACCOUNT_ID: "gl",
			GITLAB_INSTANCE_URL: "https://elsewhere.example",
			AZURE_DEVOPS_ACCOUNT_ID: "az",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/other",
			BITBUCKET_ACCOUNT_ID: "bb",
			GITHUB_REPO: "acme/app",
		};
		const lent = withForgeAccounts(vars, fakeStore());
		expect(lent).toMatchObject({
			GITHUB_TOKEN: "pat-test-github",
			GITLAB_TOKEN: "pat-test-gitlab",
			GITLAB_INSTANCE_URL: "https://gitlab.example.com",
			AZURE_DEVOPS_PAT: "pat-test-azure",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/contoso",
			BITBUCKET_TOKEN: "pat-test-bitbucket",
			BITBUCKET_USERNAME: "me@example.com",
			GITHUB_REPO: "acme/app",
		});
		expect(vars.GITHUB_TOKEN).toBe("pat-test-project");
	});

	it("gives no token for a missing account, one of another forge, or one without a token", () => {
		expect(withForgeAccounts({ GITHUB_ACCOUNT_ID: "gone", GITHUB_TOKEN: "pat-test-project" }, fakeStore()).GITHUB_TOKEN).toBe("");
		const crossed = withForgeAccounts(
			{ GITLAB_ACCOUNT_ID: "gh", GITLAB_TOKEN: "pat-test-project", GITLAB_INSTANCE_URL: "https://gitlab.com" },
			fakeStore(),
		);
		expect(crossed.GITLAB_TOKEN).toBe("");
		expect(crossed.GITLAB_INSTANCE_URL).toBe("https://gitlab.com");
		expect(withForgeAccounts({ GITHUB_ACCOUNT_ID: "empty" }, fakeStore()).GITHUB_TOKEN).toBe("");
		const noAzure = withForgeAccounts({ AZURE_DEVOPS_ACCOUNT_ID: "gone" }, fakeStore());
		expect(noAzure.AZURE_DEVOPS_PAT).toBe("");
		const noBitbucket = withForgeAccounts({ BITBUCKET_ACCOUNT_ID: "gone" }, fakeStore());
		expect(noBitbucket).toMatchObject({ BITBUCKET_TOKEN: "", BITBUCKET_USERNAME: "" });
	});

	it("uses the app's store when none is given", () => {
		expect(withForgeAccounts({ GITHUB_ACCOUNT_ID: "gh" }).GITHUB_TOKEN).toBe("pat-test-github");
	});

	it("reads a project with its accounts", () => {
		expect(readProjectForgeEnv({ path: "/p", autoBuildPath: ".workpilot" }).GITHUB_TOKEN).toBe(
			"pat-test-github",
		);
	});

	it("names one variable per forge", () => {
		expect(Object.values(FORGE_ACCOUNT_KEYS)).toHaveLength(4);
		expect(projectForgeAccountId({ GITLAB_ACCOUNT_ID: " gl " }, "gitlab")).toBe("gl");
		expect(projectForgeAccountId({}, "gitlab")).toBe("");
	});
});
