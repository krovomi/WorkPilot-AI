/**
 * @vitest-environment node
 *
 * The pull request handlers' arguments, checked before a handler runs: a PR
 * number, a list of them or a workflow run id is a positive integer, a merge
 * method one of three, an assignee a GitHub login, a comment and a cursor
 * text. A refused invoke rejects and a refused send is dropped, without the
 * handler ever seeing the call.
 */

import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { prArgsAllowed, prIpcMain } from "../pr-ipc-guard";

const mock = ipcMain as unknown as {
	invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
	emit: (c: string, ...a: unknown[]) => boolean;
	removeHandler: (c: string) => void;
	removeAllListeners: (c: string) => void;
};

const NOT_NUMBERS: unknown[] = ["12", "1/../../user", 0, -4, 2.5, Number.NaN, null, undefined, {}];

describe("prArgsAllowed", () => {
	it.each([
		[IPC_CHANNELS.GITHUB_PR_GET],
		[IPC_CHANNELS.GITHUB_PR_GET_LOGS],
		[IPC_CHANNELS.GITHUB_PR_REVIEW],
		[IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS],
		[IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW],
		[IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL],
		[IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE],
	])("%s takes a positive integer only", (channel) => {
		expect(prArgsAllowed(channel, ["p", 42])).toBe(true);
		for (const bad of NOT_NUMBERS) expect(prArgsAllowed(channel, ["p", bad])).toBe(false);
	});

	it("takes a bounded list of PR numbers for the batch of reviews", () => {
		const batch = IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH;
		expect(prArgsAllowed(batch, ["p", [1, 2, 3]])).toBe(true);
		expect(prArgsAllowed(batch, ["p", []])).toBe(true);
		expect(prArgsAllowed(batch, ["p", [1, "2"]])).toBe(false);
		expect(prArgsAllowed(batch, ["p", "1,2"])).toBe(false);
		expect(prArgsAllowed(batch, ["p", Array.from({ length: 501 }, (_, i) => i + 1)])).toBe(false);
	});

	it("takes one of GitHub's merge methods, or none for the default", () => {
		const merge = IPC_CHANNELS.GITHUB_PR_MERGE;
		for (const method of ["merge", "squash", "rebase", undefined]) {
			expect(prArgsAllowed(merge, ["p", 7, method])).toBe(true);
		}
		expect(prArgsAllowed(merge, ["p", 7, "fast-forward"])).toBe(false);
		expect(prArgsAllowed(merge, ["p", "7", "squash"])).toBe(false);
	});

	it("takes a GitHub login as the assignee", () => {
		const assign = IPC_CHANNELS.GITHUB_PR_ASSIGN;
		for (const login of ["ana", "a-b-9", "A".repeat(39)]) expect(prArgsAllowed(assign, ["p", 7, login])).toBe(true);
		for (const login of ["", "-ana", "ana-", "a".repeat(40), "ana bo", "ana\"]}", 3]) {
			expect(prArgsAllowed(assign, ["p", 7, login])).toBe(false);
		}
	});

	it("takes text as a comment and as a cursor, and leaves other channels alone", () => {
		expect(prArgsAllowed(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, ["p", 7, "LGTM"])).toBe(true);
		expect(prArgsAllowed(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, ["p", 7, { body: "x" }])).toBe(false);
		expect(prArgsAllowed(IPC_CHANNELS.GITHUB_PR_LIST_MORE, ["p", "Y3Vyc29y"])).toBe(true);
		expect(prArgsAllowed(IPC_CHANNELS.GITHUB_PR_LIST_MORE, ["p", 5])).toBe(false);
		expect(prArgsAllowed(IPC_CHANNELS.GITHUB_PR_LIST, ["p"])).toBe(true);
	});
});

describe("prIpcMain", () => {
	const listener = vi.fn((_event: unknown, ...args: unknown[]) => ({ got: args }));

	beforeEach(() => {
		listener.mockClear();
		mock.removeHandler(IPC_CHANNELS.GITHUB_PR_GET);
		mock.removeAllListeners(IPC_CHANNELS.GITHUB_PR_REVIEW);
	});

	it("passes an allowed invoke to its handler, and rejects a refused one before it", async () => {
		prIpcMain.handle(IPC_CHANNELS.GITHUB_PR_GET, listener);

		await expect(mock.invokeHandler(IPC_CHANNELS.GITHUB_PR_GET, {}, "p", 5)).resolves.toEqual({ got: ["p", 5] });
		await expect(mock.invokeHandler(IPC_CHANNELS.GITHUB_PR_GET, {}, "p", "5/../../user")).rejects.toThrow(
			"Invalid pull request arguments",
		);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("passes an allowed send to its listener, and drops a refused one", () => {
		prIpcMain.on(IPC_CHANNELS.GITHUB_PR_REVIEW, listener);

		mock.emit(IPC_CHANNELS.GITHUB_PR_REVIEW, {}, "p", 5);
		mock.emit(IPC_CHANNELS.GITHUB_PR_REVIEW, {}, "p", -1);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({}, "p", 5);
	});
});
