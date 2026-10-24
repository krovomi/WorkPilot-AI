/**
 * The Azure DevOps PR URL is read from task metadata, in a spec folder an
 * agent writes to: it reaches the details script as argv, never as source.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, ipcMain: { handle: vi.fn() } }));
vi.mock("../github/utils", () => ({ getGitHubConfig: vi.fn(), githubFetch: vi.fn() }));
vi.mock("../task/shared", () => ({ findTaskAndProject: vi.fn() }));
vi.mock("../../project-env-file", () => ({ readProjectEnv: vi.fn(() => ({})) }));

import {
	AZURE_DEVOPS_PR_URL_REGEX,
	buildAzureDevOpsPRScriptArgs,
} from "../pr-details-handlers";

const URL_OK = "https://dev.azure.com/org/MeCa%20Web/_git/repo/pullrequest/12";

describe("buildAzureDevOpsPRScriptArgs", () => {
	it("passes project, repository and PR number as arguments", () => {
		const args = buildAzureDevOpsPRScriptArgs(URL_OK, 12);
		expect(args?.slice(2)).toEqual(["MeCa Web", "repo", "12"]);
		expect(args?.[0]).toBe("-c");
	});

	it("keeps the script the same whatever the URL", () => {
		const a = buildAzureDevOpsPRScriptArgs(URL_OK, 12)?.[1];
		const b = buildAzureDevOpsPRScriptArgs(
			"https://dev.azure.com/o/p'x/_git/r/pullrequest/3",
			3,
		)?.[1];
		expect(a).toBeDefined();
		expect(a).toBe(b);
		expect(a).not.toContain("MeCa");
	});

	it("never reads a .env from the project, nor turns TLS checks off", () => {
		const script = buildAzureDevOpsPRScriptArgs(URL_OK, 12)?.[1] ?? "";
		expect(script).not.toMatch(/load_dotenv|CERT_NONE|check_hostname = False/);
	});

	it.each([
		["code after the URL", `${URL_OK}'\nimport os; os.system('id')\n'`],
		["another host first", `https://evil.example/?${URL_OK}`],
		["a URL with a query", `${URL_OK}?x=1`],
		["plain http", URL_OK.replace("https", "http")],
		["bad percent-encoding", "https://dev.azure.com/o/%E0%A4%A/_git/r/pullrequest/1"],
	])("refuses %s", (_label, url) => {
		expect(buildAzureDevOpsPRScriptArgs(url, 12)).toBeNull();
	});

	it.each([0, -1, 1.5, Number.NaN])("refuses the PR number %s", (n) => {
		expect(buildAzureDevOpsPRScriptArgs(URL_OK, n)).toBeNull();
	});

	it("anchors the URL pattern", () => {
		expect(AZURE_DEVOPS_PR_URL_REGEX.test(`x${URL_OK}`)).toBe(false);
	});
});
