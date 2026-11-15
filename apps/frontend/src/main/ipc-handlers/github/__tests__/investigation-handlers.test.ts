/**
 * @vitest-environment node
 *
 * Turning a GitHub issue into a backlog task, against a stand-in GitHub and a
 * real project folder: the issue and the comments the person kept become the
 * spec's requirements, the pasted screenshots are attached, and the window
 * follows the progress to the end or to the error. The issue number from the
 * renderer is checked before it becomes part of an API path.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	config: null as { token: string; repo: string } | null,
	attach: vi.fn(async () => undefined),
}));

vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));
vi.mock("../../shared/issue-attachments", () => ({ attachGitHubIssueImages: state.attach }));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitHubConfig: () => state.config,
}));

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent";
import { registerInvestigationHandlers } from "../investigation-handlers";

let root: string;
let window: BrowserWindow | null;
const send = vi.fn();
const fetchMock = vi.fn();

registerInvestigationHandlers({} as AgentManager, () => window);

const investigate = (...args: unknown[]) =>
	(ipcMain as unknown as { emit: (c: string, ...a: unknown[]) => boolean }).emit(
		IPC_CHANNELS.GITHUB_INVESTIGATE_ISSUE,
		{},
		"p",
		...args,
	);
const sent = (channel: string) => send.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(1));
const settled = () =>
	vi.waitFor(() => {
		expect(
			sent(IPC_CHANNELS.GITHUB_INVESTIGATION_COMPLETE).length + sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR).length,
		).toBeGreaterThan(0);
	});

const issue = {
	number: 12,
	title: "Checkout button does nothing",
	body: "Click it, nothing happens. ![shot](https://github.com/user-attachments/assets/x)",
	labels: [{ name: "bug" }],
	html_url: "https://github.com/acme/shop/issues/12",
};
const comments = [
	{ id: 1, body: "same on Safari", user: { login: "ana" } },
	{ id: 2, body: "+1", user: { login: "bo" } },
];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-investigate-"));
	state.project = { id: "p", path: root, autoBuildPath: ".workpilot", settings: { mainBranch: "develop" } };
	state.config = { token: "pat-test-0000", repo: "https://github.com/acme/shop" };
	state.attach.mockClear();
	send.mockReset();
	window = { webContents: { send } } as unknown as BrowserWindow;
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (url: string) =>
		new Response(JSON.stringify(url.endsWith("/comments") ? comments : issue), { status: 200 }),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

describe("GITHUB_INVESTIGATE_ISSUE", () => {
	it("creates the task from the issue and the comments kept, and reports each phase", async () => {
		investigate(12, [1]);
		await settled();

		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
			"https://api.github.com/repos/acme/shop/issues/12",
			"https://api.github.com/repos/acme/shop/issues/12/comments",
		]);
		const specs = readdirSync(path.join(root, ".workpilot", "specs"));
		expect(specs).toHaveLength(1);
		const specDir = path.join(root, ".workpilot", "specs", specs[0]);
		const requirements = JSON.parse(readFileSync(path.join(specDir, "requirements.json"), "utf-8"));
		expect(requirements.task_description).toContain("Investigate GitHub Issue #12: Checkout button does nothing");
		expect(requirements.task_description).toContain("**ana:** same on Safari");
		expect(requirements.task_description).not.toContain("**bo:**");
		const metadata = JSON.parse(readFileSync(path.join(specDir, "task_metadata.json"), "utf-8"));
		expect(metadata).toMatchObject({ githubIssueNumber: 12, category: "bug_fix", baseBranch: "develop" });
		expect(state.attach).toHaveBeenCalledWith("pat-test-0000", issue.body, 12, specDir);

		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_PROGRESS).map(([, s]) => s.phase)).toEqual([
			"fetching",
			"analyzing",
			"creating_task",
			"complete",
		]);
		const [[projectId, result]] = sent(IPC_CHANNELS.GITHUB_INVESTIGATION_COMPLETE);
		expect(projectId).toBe("p");
		expect(result).toMatchObject({ success: true, issueNumber: 12, taskId: specs[0] });
	});

	it("keeps every comment when no selection is given, and none for an empty one", async () => {
		investigate(12);
		await settled();
		const all = readdirSync(path.join(root, ".workpilot", "specs"));
		const first = readFileSync(path.join(root, ".workpilot", "specs", all[0], "requirements.json"), "utf-8");
		expect(first).toContain("**bo:** +1");

		send.mockReset();
		investigate(12, []);
		await settled();
		const specs = readdirSync(path.join(root, ".workpilot", "specs")).sort();
		const second = readFileSync(path.join(root, ".workpilot", "specs", specs[1], "requirements.json"), "utf-8");
		expect(second).not.toContain("## Comments");
	});

	it.each([["12/../../../../user"], ["12"], [0], [-1], [1.5], [null]])(
		"refuses the issue number %j without calling GitHub",
		async (issueNumber) => {
			investigate(issueNumber);
			await settled();

			expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR)).toEqual([["p", "Invalid issue number"]]);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("says why it cannot start: no project, no configuration, a bad repository", async () => {
		state.project = undefined;
		investigate(12);
		await settled();
		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR)).toEqual([["p", "Project not found"]]);

		send.mockReset();
		state.project = { id: "p", path: root, autoBuildPath: ".workpilot" };
		state.config = null;
		investigate(12);
		await settled();
		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR)).toEqual([["p", "No GitHub token or repository configured"]]);

		send.mockReset();
		state.config = { token: "pat-test-0000", repo: "acme/shop/extra" };
		investigate(12);
		await settled();
		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR)[0][1]).toMatch(/^Invalid repository format/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("GitHub API error: 404 Not Found - {}"), "GitHub API error: 404 Not Found - {}"],
		["odd", "Failed to investigate issue"],
	])("reports a failed call: %s", async (thrown, message) => {
		fetchMock.mockRejectedValue(thrown);

		investigate(12);
		await settled();

		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR)).toEqual([["p", message]]);
		expect(sent(IPC_CHANNELS.GITHUB_INVESTIGATION_COMPLETE)).toEqual([]);
	});

	it("does nothing without a window to report to", async () => {
		window = null;

		investigate(12);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
