/**
 * @vitest-environment node
 *
 * The PR actions: in a local clone they run `gh` by its path with an
 * argument list (the comment body on stdin), and for a server project they
 * call GitHub's API through the server. A PR number and a merge method are
 * checked before either.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	runs: [] as { command: string; args: string[]; options: Record<string, unknown>; stdin: unknown[] }[],
	answer: { error: null as Error | null, stdout: "" },
	config: { token: "server:p", repo: "acme/shop" } as { token: string; repo: string } | null,
	fetches: [] as { endpoint: string; options?: RequestInit }[],
	diff: vi.fn(async () => "relayed diff"),
}));

vi.mock("node:child_process", () => {
	const execFile = vi.fn(
		(
			command: string,
			args: string[],
			options: Record<string, unknown>,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			const run = { command, args, options, stdin: [] as unknown[] };
			state.runs.push(run);
			queueMicrotask(() => callback(state.answer.error, state.answer.stdout));
			return { stdin: { end: (input: unknown) => run.stdin.push(input) } };
		},
	);
	return { execFile, default: { execFile } };
});
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => `/tools/${tool}` }));
vi.mock("../../../env-utils", () => ({ getAugmentedEnv: () => ({ PATH: "/tools" }) }));
vi.mock("../server-relay", () => ({ relayGitHubDiff: state.diff }));
vi.mock("../utils", () => ({
	getGitHubConfig: () => state.config,
	githubFetch: async (_token: string, endpoint: string, options?: RequestInit) => {
		state.fetches.push({ endpoint, options });
		return {};
	},
}));

import { prComment, prDiff, prMerge, prUpdateBranch } from "../pr-actions";

const local = { id: "p", path: "/repo" } as Project;
const remote = { id: "p", path: "/mirror", remote: { serverId: "s" } } as unknown as Project;

beforeEach(() => {
	state.runs = [];
	state.answer = { error: null, stdout: "" };
	state.config = { token: "server:p", repo: "acme/shop" };
	state.fetches = [];
	state.diff.mockClear();
});

describe("in a local clone", () => {
	it("reads the diff with gh, with room for a large one", async () => {
		state.answer.stdout = "diff --git a/x b/x";

		await expect(prDiff(local, 7)).resolves.toBe("diff --git a/x b/x");

		const [run] = state.runs;
		expect(run.command).toBe("/tools/gh");
		expect(run.args).toEqual(["pr", "diff", "7"]);
		expect(run.options).toMatchObject({ cwd: "/repo", env: { PATH: "/tools" }, maxBuffer: 64 * 1024 * 1024 });
		expect(run.stdin).toEqual([undefined]);
	});

	it("comments with the body on stdin, whatever it holds", async () => {
		const body = "Looks good\n`rm -rf /` $(whoami) \"quoted\"";

		await prComment(local, 7, body);

		expect(state.runs[0].args).toEqual(["pr", "comment", "7", "--body-file", "-"]);
		expect(state.runs[0].stdin).toEqual([body]);
	});

	it("merges with the method chosen, and brings the branch up to date", async () => {
		await prMerge(local, 7, "rebase");
		await prUpdateBranch(local, 7);

		expect(state.runs.map((r) => r.args)).toEqual([
			["pr", "merge", "7", "--rebase"],
			["pr", "update-branch", "7"],
		]);
	});

	it("rejects with gh's error", async () => {
		state.answer.error = new Error("Command failed: gh pr merge 7\nPull request is not mergeable");

		await expect(prMerge(local, 7, "squash")).rejects.toThrow("not mergeable");
	});
});

describe("for a server project", () => {
	it("calls GitHub through the server", async () => {
		await expect(prDiff(remote, 7)).resolves.toBe("relayed diff");
		await prComment(remote, 7, "LGTM");
		await prMerge(remote, 7, "merge");
		await prUpdateBranch(remote, 7);

		expect(state.diff).toHaveBeenCalledWith("server:p", "acme/shop", 7);
		expect(state.fetches).toEqual([
			{ endpoint: "/repos/acme/shop/issues/7/comments", options: { method: "POST", body: JSON.stringify({ body: "LGTM" }) } },
			{ endpoint: "/repos/acme/shop/pulls/7/merge", options: { method: "PUT", body: JSON.stringify({ merge_method: "merge" }) } },
			{ endpoint: "/repos/acme/shop/pulls/7/update-branch", options: { method: "PUT", body: "{}" } },
		]);
		expect(state.runs).toEqual([]);
	});

	it("refuses a project that is not on GitHub", async () => {
		state.config = null;

		await expect(prDiff(remote, 7)).rejects.toThrow("Not a GitHub project");
	});
});

describe("what is checked first", () => {
	it.each([0, -3, 2.5, Number.NaN])("refuses the PR number %s", async (prNumber) => {
		await expect(prDiff(local, prNumber)).rejects.toThrow("Invalid PR number");
		await expect(prComment(local, prNumber, "x")).rejects.toThrow("Invalid PR number");
		await expect(prMerge(local, prNumber, "merge")).rejects.toThrow("Invalid PR number");
		await expect(prUpdateBranch(remote, prNumber)).rejects.toThrow("Invalid PR number");
		expect(state.runs).toEqual([]);
	});

	it("refuses a merge method GitHub does not have", async () => {
		await expect(prMerge(local, 7, "--admin" as never)).rejects.toThrow("Invalid merge method");
		expect(state.runs).toEqual([]);
	});
});
