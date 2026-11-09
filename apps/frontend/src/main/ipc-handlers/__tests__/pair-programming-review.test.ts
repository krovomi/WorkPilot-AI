/**
 * Pair programming: the AI codes in its review card's worktree, never in the
 * project folder, and its work is committed there when the session ends.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

const { handlers, sent, spawnMock, openReviewRunMock, run } = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
	spawnMock: vi.fn(),
	openReviewRunMock: vi.fn(),
	run: {
		root: "/project/.workpilot/worktrees/tasks/003-pair",
		map: (t: string | undefined) => t,
		finish: vi.fn(),
		abandon: vi.fn(),
	},
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
		on: vi.fn(),
	},
}));
vi.mock("node:child_process", () => {
	const mod = { spawn: (...args: unknown[]) => spawnMock(...args) };
	return { ...mod, default: mod };
});
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return { ...real, existsSync: () => true };
});
vi.mock("../../project-store", () => ({
	projectStore: { getProject: (id: string) => (id === "p1" ? { id, path: "/project" } : undefined) },
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: async () => ({}) }));
vi.mock("../../generated-review/review-run", () => ({
	openReviewRun: (...args: unknown[]) => openReviewRunMock(...args),
}));
vi.mock("../utils", () => ({
	safeSendToRenderer: (_win: unknown, ...args: unknown[]) => sent.push(args),
}));

import { registerPairProgrammingHandlers } from "../pair-programming-handlers";

const review = {
	taskId: "003-pair",
	specId: "003-pair",
	title: "Pair programming : JWT",
	branch: "workpilot/003-pair",
	baseBranch: "develop",
	files: ["api/auth.py"],
	committed: true,
	reused: false,
};

function fakeProcess() {
	const proc = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	spawnMock.mockReturnValue(proc);
	return proc;
}

const start = () =>
	handlers.get(IPC_CHANNELS.PAIR_PROGRAMMING_START)?.(
		{},
		{ projectId: "p1", goal: "Add JWT auth", devScope: "front", aiScope: "API" },
	) as Promise<{ success: boolean; error?: string }>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	handlers.clear();
	sent.length = 0;
	spawnMock.mockReset();
	openReviewRunMock.mockReset().mockResolvedValue(run);
	run.finish.mockReset().mockResolvedValue(review);
	run.abandon.mockReset().mockResolvedValue(undefined);
	registerPairProgrammingHandlers(() => null);
});

describe("pair programming on a review card", () => {
	it("runs the AI in the card's worktree, not the project folder", async () => {
		fakeProcess();
		const result = await start();

		expect(result.success).toBe(true);
		expect(openReviewRunMock).toHaveBeenCalledWith(
			"/project",
			"pair-programming",
			"Add JWT auth",
			undefined,
			expect.stringContaining("Add JWT auth"),
		);
		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args[args.indexOf("--project-dir") + 1]).toBe(run.root);
	});

	it("commits the AI's work when the session ends and shows the card", async () => {
		const proc = fakeProcess();
		await start();

		proc.emit("close", 0);
		await flush();

		expect(run.finish).toHaveBeenCalledWith({
			message: "feat: Add JWT auth (pair programming)",
			summary: "API",
		});
		expect(sent).toContainEqual([IPC_CHANNELS.PAIR_PROGRAMMING_REVIEW, "p1", review]);
	});

	it("commits what a stopped session wrote too", async () => {
		const proc = fakeProcess();
		await start();
		await handlers.get(IPC_CHANNELS.PAIR_PROGRAMMING_STOP)?.({}, "p1", "s");

		proc.emit("close", null);
		await flush();

		expect(proc.kill).toHaveBeenCalled();
		expect(run.finish).toHaveBeenCalledTimes(1);
	});

	it("keeps the work where it is when git refuses the commit, and says where", async () => {
		const proc = fakeProcess();
		run.finish.mockRejectedValueOnce(new Error("git has no author identity"));
		await start();

		proc.emit("close", 0);
		await flush();

		expect(run.abandon).not.toHaveBeenCalled();
		const error = sent.find((s) => s[0] === IPC_CHANNELS.PAIR_PROGRAMMING_ERROR);
		expect(error?.[2]).toContain(run.root);
		expect(error?.[2]).toContain("git has no author identity");
	});

	it("starts nothing when the review branch cannot be prepared", async () => {
		openReviewRunMock.mockRejectedValueOnce(
			Object.assign(new Error("The review branch could not be prepared."), {
				details: "not a git repository",
			}),
		);

		const result = await start();

		expect(result).toEqual({
			success: false,
			error: "The review branch could not be prepared. not a git repository",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("takes the card back when the runner cannot start", async () => {
		const proc = fakeProcess();
		await start();

		proc.emit("error", new Error("ENOENT"));
		await flush();

		expect(run.abandon).toHaveBeenCalled();
		expect(run.finish).not.toHaveBeenCalled();
	});
});
