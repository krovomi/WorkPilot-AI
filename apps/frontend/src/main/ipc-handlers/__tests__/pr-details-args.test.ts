/**
 * The PR details handler checks what the renderer sends before any request:
 * a PR number is a positive whole number, a task id a string.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	githubFetch: vi.fn(),
	getGitHubConfig: vi.fn(),
	findTaskAndProject: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp" },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, fn),
	},
}));
vi.mock("../github/utils", () => ({ getGitHubConfig: mocks.getGitHubConfig, githubFetch: mocks.githubFetch }));
vi.mock("../task/shared", () => ({ findTaskAndProject: mocks.findTaskAndProject }));
vi.mock("../../project-env-file", () => ({ readProjectEnv: vi.fn(() => ({})) }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const mocked = { ...actual, spawn: mocks.spawn };
	return { ...mocked, default: mocked };
});

import { IPC_CHANNELS } from "../../../shared/constants";
import { isPRNumber, registerPRDetailsHandlers } from "../pr-details-handlers";

registerPRDetailsHandlers();
const prDetails = (...args: unknown[]) => {
	const handler = mocks.handlers.get(IPC_CHANNELS.PR_DETAILS);
	if (!handler) throw new Error("PR_DETAILS not registered");
	return handler({}, ...args) as Promise<{ success: boolean; error?: string; data?: { data: { files: { status: string }[] } } }>;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getGitHubConfig.mockReturnValue({ token: "ghp_test_0000", repo: "acme/app" });
	mocks.findTaskAndProject.mockReturnValue({ task: null, project: null });
});

describe("isPRNumber", () => {
	it.each([1, 42, Number.MAX_SAFE_INTEGER])("accepts %s", (n) => expect(isPRNumber(n)).toBe(true));
	it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12", "1/files", null, undefined, {}])(
		"refuses %s",
		(n) => expect(isPRNumber(n)).toBe(false),
	);
});

describe("PR_DETAILS handler", () => {
	it.each([["a string", "7/../../user"], ["a fraction", 7.5], ["zero", 0], ["an object", { valueOf: (): number => 7 }]])(
		"refuses a PR number that is %s, before any request",
		async (_label, prNumber) => {
			const result = await prDetails(prNumber);
			expect(result).toEqual({ success: false, error: "Invalid pull request" });
			expect(mocks.githubFetch).not.toHaveBeenCalled();
			expect(mocks.findTaskAndProject).not.toHaveBeenCalled();
		},
	);

	it("refuses a task id that is not a string", async () => {
		const result = await prDetails(7, { id: "t1" });
		expect(result).toEqual({ success: false, error: "Invalid pull request" });
		expect(mocks.findTaskAndProject).not.toHaveBeenCalled();
	});

	it("asks GitHub for the PR it was given", async () => {
		mocks.findTaskAndProject.mockReturnValue({ task: { metadata: {} }, project: { id: "p1", path: "/projects/demo" } });
		mocks.githubFetch.mockResolvedValue({});
		await prDetails(7, "task-1");
		expect(mocks.githubFetch).toHaveBeenCalledWith("ghp_test_0000", "/repos/acme/app/pulls/7");
	});

	it("shows a file an Azure DevOps PR deletes as removed", async () => {
		const prUrl = "https://dev.azure.com/org/proj/_git/repo/pullrequest/7";
		mocks.findTaskAndProject.mockReturnValue({
			task: { metadata: { prUrl } },
			project: { id: "p1", path: "/projects/demo" },
		});
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const pr = { id: 7, title: "t", status: "active", files: [{ path: "/old.ts", changeType: "delete" }] };
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(JSON.stringify({ success: true, data: pr })));
			child.emit("close", 0);
		});
		mocks.spawn.mockReturnValueOnce(child);

		const result = await prDetails(7, "task-1");

		expect(result.error).toBeUndefined();
		expect(result.data?.data.files.map((f) => f.status)).toEqual(["removed"]);
	});
});
