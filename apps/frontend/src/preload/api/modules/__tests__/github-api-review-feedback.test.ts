/**
 * The two preload methods of the review feedback (#361) call their own
 * channels with the arguments as given; the main process checks them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
	ipcRenderer: {
		invoke,
		send: vi.fn(),
		on: vi.fn(),
		removeListener: vi.fn(),
	},
}));

import { createGitHubAPI } from "../github-api";

beforeEach(() => {
	invoke.mockReset();
	invoke.mockResolvedValue({ success: true, feedback: {} });
});

describe("review feedback preload", () => {
	it("sets feedback on its channel", async () => {
		const input = { findingId: "f-1", verdict: "rejected" as const };
		await createGitHubAPI().setReviewFindingFeedback("p1", 3, input);
		expect(invoke).toHaveBeenCalledWith(
			IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_SET,
			"p1",
			3,
			input,
		);
	});

	it("reads feedback on its channel", async () => {
		await createGitHubAPI().getReviewFindingFeedback("p1", 3);
		expect(invoke).toHaveBeenCalledWith(
			IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_GET,
			"p1",
			3,
		);
	});

	it("reads the stats, resets a rule and writes the conventions on their channels", async () => {
		const api = createGitHubAPI();
		await api.getReviewFeedbackStats("p1");
		await api.resetReviewFeedbackRule("p1", "0123456789abcdef");
		await api.writeReviewConventions("p1");
		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_STATS, "p1"],
			[IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_RESET, "p1", "0123456789abcdef"],
			[IPC_CHANNELS.GITHUB_PR_REVIEW_CONVENTIONS_WRITE, "p1"],
		]);
	});

	it("decides a held rejection on its channel", async () => {
		await createGitHubAPI().decideHeldReviewFeedback("p1", 3, "f-1", false);
		expect(invoke).toHaveBeenCalledWith(
			IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_HELD_DECIDE,
			"p1",
			3,
			"f-1",
			false,
		);
	});
});
