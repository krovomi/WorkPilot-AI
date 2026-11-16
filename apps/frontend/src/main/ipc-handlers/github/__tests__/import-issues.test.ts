/**
 * @vitest-environment node
 *
 * "Create Task" on GitHub issues of a project of this computer: each issue is
 * read from GitHub, becomes a spec (its screenshots attached) and starts its
 * spec creation. What the renderer sends as an issue number is checked
 * before it becomes part of a URL; one issue failing does not stop the rest.
 */

import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	config: { token: "pat-test-0000", repo: "acme/shop" } as { token: string; repo: string } | null,
	issues: new Map<number, unknown>(),
	fetched: [] as string[],
	createSpec: vi.fn(),
	attach: vi.fn(async () => undefined),
	startSpecCreation: vi.fn(),
}));

vi.mock("../../server-feature-files", () => ({
	featureProject: (id: string) => (id === "p1" ? state.project : undefined),
}));
vi.mock("../../../server-board-actions", () => ({ createServerCard: vi.fn() }));
vi.mock("../spec-utils", () => ({ createSpecForIssue: state.createSpec }));
vi.mock("../../shared/issue-attachments", () => ({ attachGitHubIssueImages: state.attach }));
vi.mock("../utils", () => ({
	getGitHubConfig: () => state.config,
	githubFetch: async (_token: string, endpoint: string) => {
		state.fetched.push(endpoint);
		const number = Number(endpoint.split("/").pop());
		const issue = state.issues.get(number);
		if (!issue) throw new Error("HTTP 404");
		if (issue === "text") throw "down";
		return issue;
	},
}));

import type { AgentManager } from "../../../agent";
import { registerImportHandlers } from "../import-handlers";

interface ImportResult {
	success: boolean;
	error?: string;
	data?: { imported: number; failed: number; errors?: string[]; tasks: unknown[] };
}

const invoke = (...args: unknown[]) =>
	(ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<ImportResult> }).invokeHandler(
		IPC_CHANNELS.GITHUB_IMPORT_ISSUES,
		{},
		...args,
	);

registerImportHandlers({ startSpecCreation: state.startSpecCreation } as unknown as AgentManager);

beforeEach(() => {
	state.project = { id: "p1", path: "/repo", settings: { mainBranch: "develop" } } as Project;
	state.config = { token: "pat-test-0000", repo: "acme/shop" };
	state.issues.clear();
	state.fetched = [];
	state.createSpec.mockReset();
	state.attach.mockClear();
	state.startSpecCreation.mockReset();
	state.createSpec.mockImplementation(async (_project: unknown, number: number) => ({
		specId: `00${number}-issue`,
		specDir: `/repo/.workpilot/specs/00${number}-issue`,
		taskDescription: `Issue ${number}`,
		metadata: { issue: number },
	}));
});

describe("importing issues of a local project", () => {
	it("writes a spec per issue, attaches its screenshots and starts its spec creation", async () => {
		state.issues.set(3, {
			number: 3,
			title: "Cart total wrong",
			body: "![shot](https://github.com/x.png)",
			labels: [{ name: "bug" }, { name: "cart" }],
			html_url: "https://github.com/acme/shop/issues/3",
		});
		state.issues.set(4, { number: 4, title: "No body", labels: [], html_url: "https://github.com/acme/shop/issues/4" });

		const result = await invoke("p1", [3, 4]);

		expect(result).toEqual({
			success: true,
			data: { success: true, imported: 2, failed: 0, errors: undefined, tasks: [] },
		});
		const [project, number, title, description, url, labels, branch] = state.createSpec.mock.calls[0];
		expect([project, number, title, url, labels, branch]).toEqual([
			state.project,
			3,
			"Cart total wrong",
			"https://github.com/acme/shop/issues/3",
			["bug", "cart"],
			"develop",
		]);
		expect(description).toContain("**GitHub Issue:** [#3](https://github.com/acme/shop/issues/3)");
		expect(description).toContain("**Labels:** bug, cart");
		expect(state.createSpec.mock.calls[1][3]).toContain("No description provided.");
		expect(state.createSpec.mock.calls[1][3]).not.toContain("**Labels:**");
		expect(state.attach).toHaveBeenCalledWith(
			"pat-test-0000",
			"![shot](https://github.com/x.png)",
			3,
			"/repo/.workpilot/specs/003-issue",
		);
		expect(state.startSpecCreation).toHaveBeenCalledWith(
			"003-issue",
			"/repo",
			"Issue 3",
			"/repo/.workpilot/specs/003-issue",
			{ issue: 3 },
		);
	});

	it("refuses what is not an issue number before any request, and goes on with the others", async () => {
		state.issues.set(5, { number: 5, title: "ok", labels: [], html_url: "u" });
		state.issues.set(6, "text");

		const result = await invoke("p1", ["5/../../user", 0, 5, 404, 6]);

		expect(state.fetched).toEqual([
			"/repos/acme/shop/issues/5",
			"/repos/acme/shop/issues/404",
			"/repos/acme/shop/issues/6",
		]);
		expect(result.data).toMatchObject({
			success: false,
			imported: 1,
			failed: 4,
			errors: [
				"Failed to import #5/../../user: Invalid issue number",
				"Failed to import #0: Invalid issue number",
				"Failed to import #404: HTTP 404",
				"Failed to import #6: Unknown error",
			],
		});
	});

	it("imports nothing from a list that is not one", async () => {
		await expect(invoke("p1", "3")).resolves.toMatchObject({ data: { imported: 0, failed: 0 } });
	});

	it("fails without a project or a GitHub configuration", async () => {
		await expect(invoke("other", [1])).resolves.toEqual({ success: false, error: "Project not found" });
		state.config = null;
		await expect(invoke("p1", [1])).resolves.toEqual({
			success: false,
			error: "No GitHub token or repository configured",
		});
	});
});
