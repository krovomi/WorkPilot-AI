/**
 * @vitest-environment node
 *
 * The state of a task's PR on GitHub, GitLab and Azure DevOps: one URL shape
 * per forge, the forge's words mapped to open, merged or closed, and
 * "unknown" (never "merged") for anything that cannot be read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

const state = vi.hoisted(() => ({
	calls: [] as Array<{ tool: string; args: string[] }>,
	stdout: "",
	fail: false,
	env: {} as Record<string, string>,
}));

vi.mock("node:child_process", () => ({
	execFile: (
		tool: string,
		args: string[],
		_options: unknown,
		callback: (error: Error | null, out: { stdout: string; stderr: string }) => void,
	) => {
		state.calls.push({ tool, args });
		if (state.fail) callback(new Error("gh: not logged in"), { stdout: "", stderr: "" });
		else callback(null, { stdout: state.stdout, stderr: "" });
	},
}));
vi.mock("../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));
vi.mock("../app-logger", () => ({ appLog: { debug: vi.fn() } }));
vi.mock("../project-env-file", () => ({ readProjectEnv: () => state.env }));

import { forgeOf, normalizePrState, readPrState } from "../pr-state";

const project = { id: "p", path: "/repo" } as Project;

beforeEach(() => {
	state.calls = [];
	state.stdout = "";
	state.fail = false;
	state.env = {};
	vi.unstubAllGlobals();
});

describe("forgeOf", () => {
	it.each([
		["https://github.com/acme/shop/pull/12", "github"],
		["https://github.example.com/acme/shop/pull/12/", "github"],
		["https://gitlab.com/acme/team/shop/-/merge_requests/7", "gitlab"],
		["https://dev.azure.com/acme/Shop/_git/shop-api/pullrequest/42", "azure"],
	])("reads %s as %s", (url, forge) => {
		expect(forgeOf(url)).toBe(forge);
	});

	it.each([
		"http://github.com/acme/shop/pull/12",
		"https://github.com/acme/shop/pull/12?x=1",
		"https://github.com/acme/shop/issues/12",
		"https://github.com/acme/shop/pull/12 --web",
		"--repo=x",
		42,
		undefined,
	])("refuses %s", (url) => {
		expect(forgeOf(url)).toBeNull();
	});
});

describe("normalizePrState", () => {
	it.each([
		["OPEN", "open"],
		["opened", "open"],
		["active", "open"],
		["locked", "open"],
		["MERGED", "merged"],
		["completed", "merged"],
		["CLOSED", "closed"],
		["abandoned", "closed"],
		["draft", "unknown"],
		[undefined, "unknown"],
	])("%s is %s", (raw, expected) => {
		expect(normalizePrState(raw)).toBe(expected);
	});
});

describe("readPrState", () => {
	it("asks gh for a GitHub PR, the URL as one argument", async () => {
		state.stdout = JSON.stringify({ state: "MERGED" });
		await expect(readPrState("https://github.com/acme/shop/pull/12", project)).resolves.toBe(
			"merged",
		);
		expect(state.calls).toEqual([
			{ tool: "gh", args: ["pr", "view", "https://github.com/acme/shop/pull/12", "--json", "state"] },
		]);
	});

	it("asks glab's API for a GitLab merge request", async () => {
		state.stdout = JSON.stringify({ state: "opened" });
		await expect(
			readPrState("https://gitlab.example.com/acme/team/shop/-/merge_requests/7", project),
		).resolves.toBe("open");
		expect(state.calls[0]).toEqual({
			tool: "glab",
			args: [
				"api",
				"--hostname",
				"gitlab.example.com",
				"projects/acme%2Fteam%2Fshop/merge_requests/7",
			],
		});
	});

	it("reads Azure DevOps over REST with the project's token", async () => {
		state.env = { AZURE_DEVOPS_PAT: "pat-value" };
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ status: "completed" }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			readPrState("https://dev.azure.com/acme/Shop/_git/shop-api/pullrequest/42", project),
		).resolves.toBe("merged");
		const [api, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(api).toBe(
			"https://dev.azure.com/acme/Shop/_apis/git/repositories/shop-api/pullrequests/42?api-version=7.1",
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from(":pat-value").toString("base64")}`,
		);
	});

	it("is unknown without an Azure token, on a refused call, a failed tool or an odd answer", async () => {
		await expect(
			readPrState("https://dev.azure.com/acme/Shop/_git/shop-api/pullrequest/42", project),
		).resolves.toBe("unknown");
		state.env = { AZURE_DEVOPS_PAT: "pat-value" };
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
		await expect(
			readPrState("https://dev.azure.com/acme/Shop/_git/shop-api/pullrequest/42", project),
		).resolves.toBe("unknown");
		state.fail = true;
		await expect(readPrState("https://github.com/acme/shop/pull/12", project)).resolves.toBe(
			"unknown",
		);
		state.fail = false;
		state.stdout = "not json";
		await expect(readPrState("https://github.com/acme/shop/pull/12", project)).resolves.toBe(
			"unknown",
		);
		await expect(readPrState("https://example.com/whatever", project)).resolves.toBe("unknown");
		expect(state.calls).toHaveLength(2);
	});
});
