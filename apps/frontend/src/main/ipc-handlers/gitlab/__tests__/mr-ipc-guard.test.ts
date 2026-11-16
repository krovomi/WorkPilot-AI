/**
 * @vitest-environment node
 *
 * What the renderer sends for a merge request reaches its handler only when
 * it has the shape the handler builds a GitLab API path, a request body or a
 * file name from.
 */

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { mrArgsAllowed } from "../mr-ipc-guard";

const allowed = (channel: string, ...args: unknown[]) => mrArgsAllowed(channel, ["p1", ...args]);

describe("merge request arguments", () => {
	it.each([
		IPC_CHANNELS.GITLAB_MR_GET_REVIEW,
		IPC_CHANNELS.GITLAB_MR_REVIEW,
		IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW,
		IPC_CHANNELS.GITLAB_MR_APPROVE,
		IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL,
		IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS,
	])("%s takes an iid, a positive whole number", (channel) => {
		expect(allowed(channel, 7)).toBe(true);
		for (const iid of [0, -1, 1.5, "7", "../7", Number.NaN, undefined, 2 ** 60]) {
			expect(allowed(channel, iid)).toBe(false);
		}
	});

	it("posts the findings it is given by their ids", () => {
		const channel = IPC_CHANNELS.GITLAB_MR_POST_REVIEW;
		expect(allowed(channel, 7)).toBe(true);
		expect(allowed(channel, 7, ["f1", "f2"])).toBe(true);
		expect(allowed(channel, 7, "f1")).toBe(false);
		expect(allowed(channel, 7, [1])).toBe(false);
		expect(allowed(channel, 7, Array.from({ length: 501 }, () => "f"))).toBe(false);
		expect(allowed(channel, "7", ["f1"])).toBe(false);
	});

	it("posts a note of text", () => {
		const channel = IPC_CHANNELS.GITLAB_MR_POST_NOTE;
		expect(allowed(channel, 7, "Looks good")).toBe(true);
		expect(allowed(channel, 7, { body: "x" })).toBe(false);
		expect(allowed(channel, 7)).toBe(false);
	});

	it("merges by one of GitLab's three methods", () => {
		const channel = IPC_CHANNELS.GITLAB_MR_MERGE;
		for (const method of [undefined, "merge", "squash", "rebase"]) {
			expect(allowed(channel, 7, method)).toBe(true);
		}
		expect(allowed(channel, 7, "fast-forward")).toBe(false);
		expect(allowed(channel, 0, "merge")).toBe(false);
	});

	it("assigns GitLab user ids", () => {
		const channel = IPC_CHANNELS.GITLAB_MR_ASSIGN;
		expect(allowed(channel, 7, [3, 4])).toBe(true);
		expect(allowed(channel, 7, [])).toBe(true);
		expect(allowed(channel, 7, ["alice"])).toBe(false);
		expect(allowed(channel, 7, 3)).toBe(false);
	});

	it("leaves a channel it has no check for alone", () => {
		expect(allowed(IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS, "anything")).toBe(true);
	});
});
