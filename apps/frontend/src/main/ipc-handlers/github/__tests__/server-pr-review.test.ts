/**
 * The AI review of a server project's pull requests runs on the server: the
 * app starts and follows the job, reads the saved reviews there, and posts a
 * review to GitHub through the relay, with the person's own token, then
 * records it on the server. Nothing runs or is read on this computer.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	relayServerJob: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../../server-features", () => ({ relayServerJob: mocks.relayServerJob }));
vi.mock("../../server-feature-files", () => ({ featureProject: () => undefined }));

import {
	cancelServerReview,
	postServerReview,
	serverReviews,
	startServerReview,
} from "../server-pr-review";

const project = {
	id: "p-1",
	path: "/nowhere/mirror",
	remote: {
		repoUrl: "https://github.com/acme/shop.git",
		defaultBranch: "main",
		role: "member",
		forge: "github",
	},
} as unknown as Project;

const saved = JSON.stringify({
	pr_number: 7,
	repo: "acme/shop",
	success: true,
	summary: "Two issues",
	overall_status: "request_changes",
	findings: [
		{ id: "F1", severity: "high", category: "security", title: "SQL", description: "d", file: "a.py", line: 3 },
		{ id: "F2", severity: "low", category: "style", title: "Name", description: "d", file: "b.py", line: 9 },
	],
});

function answered(data: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
}

function job() {
	const stream = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(() => true),
	});
	mocks.relayServerJob.mockReturnValueOnce(stream);
	return stream;
}

function window() {
	const send = vi.fn();
	return { send, mainWindow: { webContents: { send } } as never };
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.relayServerJob.mockReset();
	mocks.fetch.mockReset();
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("a server project's AI review", () => {
	it("reads the saved reviews from the server, by project id", async () => {
		answered({ reviews: { "7": saved, "8": null, "9": "not json" } });
		const reviews = await serverReviews(project, [7, 8, 9, 7, -1, "7/../x"]);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/github/reviews?numbers=7,8,9&project_id=p-1",
			"GET",
		);
		expect(reviews[7]?.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
		expect(reviews[7]?.overallStatus).toBe("request_changes");
		expect(reviews[8]).toBeNull();
		expect(reviews[9]).toBeNull();
	});

	it("runs on the server and hands the view its progress and result", async () => {
		const stream = job();
		const { send, mainWindow } = window();
		startServerReview(project, 7, false, mainWindow, {
			model: "claude-sonnet",
			thinkingLevel: "ultrathink",
		});
		expect(mocks.relayServerJob).toHaveBeenCalledWith(project, "forge/github/reviews", {
			options: { number: 7, followup: false, model: "claude-sonnet" },
		});
		// One review of a PR at a time from here.
		startServerReview(project, 7, false, mainWindow, { model: "m", thinkingLevel: "high" });
		expect(mocks.relayServerJob).toHaveBeenCalledTimes(1);

		stream.stdout.emit("data", Buffer.from("[ 40%] Analyzing files\nother\n"));
		expect(send).toHaveBeenCalledWith(
			IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
			"p-1",
			expect.objectContaining({ prNumber: 7, progress: 40, message: "Analyzing files" }),
		);

		answered({ reviews: { "7": saved } });
		stream.emit("exit", 0);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
				"p-1",
				expect.objectContaining({ prNumber: 7, success: true }),
			),
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("says why a review failed, and stops one that runs", () => {
		const failing = job();
		const { send, mainWindow } = window();
		startServerReview(project, 8, true, mainWindow, { model: "m", thinkingLevel: "low" });
		expect(mocks.relayServerJob.mock.calls[0][2]).toEqual({
			options: { number: 8, followup: true, model: "m", thinking_level: "low" },
		});
		failing.stderr.emit("data", Buffer.from("Add your GitHub token\n"));
		failing.emit("exit", 1);
		expect(send).toHaveBeenCalledWith(
			IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
			"p-1",
			expect.anything(),
		);
		expect(JSON.stringify(send.mock.calls.at(-1))).toContain("Add your GitHub token");

		const running = job();
		startServerReview(project, 9, false, mainWindow, { model: "m", thinkingLevel: "low" });
		expect(cancelServerReview("p-1", 9)).toBe(true);
		expect(running.kill).toHaveBeenCalled();
		expect(cancelServerReview("p-1", 9)).toBe(false);
	});

	it("posts the selected findings with the person's token, then records them", async () => {
		answered({ reviews: { "7": saved } });
		answered({ status: 200, body: { id: 99 } });
		answered({ posted: true });

		expect(await postServerReview(project, 7, ["F2"])).toBe(true);

		const [read, post, record] = mocks.authedFetch.mock.calls;
		expect(read[0]).toContain("/api/features/forge/github/reviews?numbers=7");
		expect(post[0]).toBe("/api/features/forge/github/write?project_id=p-1");
		expect(post[2]).toMatchObject({
			method: "POST",
			endpoint: "/repos/acme/shop/pulls/7/reviews",
			body: { event: "COMMENT" },
		});
		expect(post[2].body.body).toContain("[F2]");
		expect(post[2].body.body).not.toContain("[F1]");
		expect(record).toEqual([
			"/api/features/forge/github/reviews/7/posted?project_id=p-1",
			"POST",
			{ finding_ids: ["F2"], review_id: 99 },
		]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("posts nothing without a saved review", async () => {
		answered({ reviews: { "7": null } });
		expect(await postServerReview(project, 7)).toBe(false);
		expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
	});
});
