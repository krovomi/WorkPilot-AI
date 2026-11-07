/**
 * The AI review of a server project's merge requests runs on the server: the
 * app starts and follows the job, reads the saved reviews there, and posts a
 * review as a note on the merge request through the relay, with the person's
 * own token, then records it on the server. Nothing runs or is read on this
 * computer.
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
	cancelServerMRReview,
	postServerMRReview,
	serverMRReview,
	startServerMRReview,
} from "../server-mr-review";

const project = {
	id: "p-1",
	path: "/nowhere/mirror",
	remote: {
		repoUrl: "https://gitlab.example.com/acme/lab.git",
		defaultBranch: "main",
		role: "member",
		forge: "gitlab",
	},
} as unknown as Project;

const saved = JSON.stringify({
	mr_iid: 3,
	project: "acme/lab",
	success: true,
	summary: "Two issues",
	overall_status: "request_changes",
	reviewed_commit_sha: "abc",
	findings: [
		{ id: "F1", severity: "high", category: "security", title: "SQL", description: "d", file: "a.py", line: 3, suggested_fix: "bind it" },
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

describe("a server project's MR AI review", () => {
	it("reads the saved review from the server, by project id", async () => {
		answered({ reviews: { "3": saved } });
		const review = await serverMRReview(project, 3);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/gitlab/reviews?numbers=3&project_id=p-1",
			"GET",
		);
		expect(review?.mrIid).toBe(3);
		expect(review?.reviewedCommitSha).toBe("abc");
		expect(review?.findings.map((f) => f.suggestedFix)).toEqual(["bind it", undefined]);

		expect(await serverMRReview(project, -1)).toBeNull();
		expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
	});

	it("runs on the server and hands the view its progress and result", async () => {
		const stream = job();
		const { send, mainWindow } = window();
		startServerMRReview(project, 3, false, mainWindow, {
			model: "claude-sonnet",
			thinkingLevel: "medium",
		});
		expect(mocks.relayServerJob).toHaveBeenCalledWith(project, "forge/gitlab/reviews", {
			options: { number: 3, followup: false, model: "claude-sonnet", thinking_level: "medium" },
		});

		stream.stdout.emit("data", Buffer.from("[MR !3] [ 40%] Analyzing files\n"));
		expect(send).toHaveBeenCalledWith(
			IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS,
			"p-1",
			expect.objectContaining({ mrIid: 3, progress: 40, message: "Analyzing files" }),
		);

		answered({ reviews: { "3": saved } });
		stream.emit("exit", 0);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE,
				"p-1",
				expect.objectContaining({ mrIid: 3, success: true }),
			),
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("says why a review failed, refuses a second follow-up, and stops one", () => {
		const failing = job();
		const { send, mainWindow } = window();
		startServerMRReview(project, 4, true, mainWindow, { model: "m", thinkingLevel: "x" });
		expect(mocks.relayServerJob.mock.calls[0][2]).toEqual({
			options: { number: 4, followup: true, model: "m" },
		});
		startServerMRReview(project, 4, true, mainWindow, { model: "m", thinkingLevel: "low" });
		expect(mocks.relayServerJob).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenLastCalledWith(
			IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR,
			"p-1",
			{ mrIid: 4, error: "Review already in progress" },
		);

		failing.stderr.emit("data", Buffer.from("Add your GitLab token\n"));
		failing.emit("exit", 1);
		expect(send).toHaveBeenLastCalledWith(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR, "p-1", {
			mrIid: 4,
			error: "Add your GitLab token",
		});

		const running = job();
		startServerMRReview(project, 5, false, mainWindow, { model: "m", thinkingLevel: "low" });
		expect(cancelServerMRReview("p-1", 5)).toBe(true);
		expect(running.kill).toHaveBeenCalled();
		expect(cancelServerMRReview("p-1", 5)).toBe(false);
	});

	it("posts the selected findings as a note with the person's token, then records them", async () => {
		answered({ reviews: { "3": saved } });
		answered({ status: 201, body: { id: 77 } });
		answered({ posted: true });

		expect(await postServerMRReview(project, 3, ["F2", 7])).toBe(true);

		const [read, post, record] = mocks.authedFetch.mock.calls;
		expect(read[0]).toContain("/api/features/forge/gitlab/reviews?numbers=3");
		expect(post[0]).toBe("/api/features/forge/gitlab/write?project_id=p-1");
		expect(post[2]).toMatchObject({
			method: "POST",
			endpoint: "/projects/acme%2Flab/merge_requests/3/notes",
		});
		expect(post[2].body.body).toContain("Name");
		expect(post[2].body.body).not.toContain("SQL");
		expect(record).toEqual([
			"/api/features/forge/gitlab/reviews/3/posted?project_id=p-1",
			"POST",
			{ finding_ids: ["F2"] },
		]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("posts nothing without a saved review", async () => {
		answered({ reviews: { "3": null } });
		expect(await postServerMRReview(project, 3)).toBe(false);
		expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
	});
});
