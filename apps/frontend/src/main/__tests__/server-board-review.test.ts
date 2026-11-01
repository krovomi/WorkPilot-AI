/**
 * Server mode: the review panel of a server card reads and acts on the
 * server's workspace. Each action is checked by the request it sends, and
 * the server's answer is taken field by field.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let TEST_DIR: string;

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => path.join(TEST_DIR, "userData")) },
}));

const connection = vi.hoisted(() => ({ authedFetch: vi.fn() }));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
	getServerUrl: () => "https://wp.example",
	isServerMode: () => true,
}));

const PID = "6f1c2b9e-0d4a-4c1e-9a7b-1f2e3d4c5b6a";
const Q = `?project_id=${PID}`;
const CARD = "/api/board/cards/001-login";

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

function serve(routes: Record<string, (body: unknown) => Reply>) {
	connection.authedFetch.mockImplementation(
		async (url: string, method: string, body?: unknown) => {
			const route = routes[`${method} ${url}`];
			return route ? route(body) : { ok: false, error: `unexpected ${method} ${url}` };
		},
	);
}

const SPECS = {
	[`GET /projects/${PID}/specs`]: (): Reply => ({
		ok: true,
		data: [{ id: "row-1", spec_name: "001-login" }],
	}),
};

const CHANGES = {
	exists: true,
	branch: "workpilot/001-login",
	baseBranch: "main",
	commitCount: 1,
	filesChanged: 2,
	additions: 3,
	deletions: 0,
	files: [
		{ path: "login.py", status: "added", additions: 2, deletions: 0, patch: "+def login" },
		{ path: "app.py", status: "modified", additions: 1, deletions: 0, patch: "+x" },
		{ path: "", status: "added" },
		{ path: "evil.py", status: "exploded" },
		"not a file",
	],
	summary: "2 files changed",
	worktreePath: "/srv/clones/p/.workpilot/worktrees/tasks/001-login",
};

async function setup() {
	serve({
		"GET /projects": () => ({
			ok: true,
			data: [
				{
					id: PID,
					name: "Shop",
					repo_url: "https://git.example/shop.git",
					default_branch: "main",
					created_at: "2026-10-31T10:00:00Z",
					my_role: "member",
				},
			],
		}),
	});
	const { listServerProjects } = await import("../server-projects");
	await listServerProjects();
	const actions = await import("../server-board-actions");
	const card = actions.findServerCard(`server:${PID}:001-login`);
	if (!card) throw new Error("card");
	return { card, review: await import("../server-board-review") };
}

beforeEach(() => {
	TEST_DIR = mkdtempSync(path.join(tmpdir(), "server-review-test-"));
	mkdirSync(path.join(TEST_DIR, "userData", "store"), { recursive: true });
	connection.authedFetch.mockReset();
	vi.resetModules();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("a server card's changes", () => {
	it("are read from the server and kept to the fields the panel shows", async () => {
		const { card, review } = await setup();
		serve({ [`GET ${CARD}/changes${Q}`]: () => ({ ok: true, data: CHANGES }) });

		const status = await review.serverWorktreeStatus(card);
		expect(status).toEqual({
			success: true,
			data: {
				exists: true,
				branch: "workpilot/001-login",
				baseBranch: "main",
				commitCount: 1,
				filesChanged: 2,
				additions: 3,
				deletions: 0,
			},
		});
		// The server's own path never reaches the app.
		expect(JSON.stringify(status)).not.toContain("/srv/");

		const diff = await review.serverWorktreeDiff(card);
		expect(diff.data?.files.map((f) => f.path)).toEqual(["login.py", "app.py"]);
		expect(diff.data?.summary).toBe("2 files changed");

		expect((await review.serverFileDiff(card, "./app.py")).data?.patch).toBe("+x");
		expect((await review.serverFileDiff(card, "other.py")).success).toBe(false);
		expect((await review.serverFileDiff(card, 42)).success).toBe(false);
	});

	it("say there is no workspace before the build, and pass on a refusal", async () => {
		const { card, review } = await setup();
		let reply: Reply = { ok: true, data: { exists: false, files: [], summary: "" } };
		serve({ [`GET ${CARD}/changes${Q}`]: () => reply });

		expect(await review.serverWorktreeStatus(card)).toEqual({
			success: true,
			data: { exists: false },
		});
		expect((await review.serverWorktreeDiff(card)).success).toBe(false);

		reply = { ok: false, error: "Project not found" };
		expect(await review.serverWorktreeStatus(card)).toEqual({
			success: false,
			error: "Project not found",
		});
	});
});

describe("a server card's review", () => {
	it("merges and opens the pull request as runs on the server", async () => {
		const { card, review } = await setup();
		const phases: string[] = [];
		serve({
			...SPECS,
			[`POST /projects/${PID}/specs/row-1/runs`]: (body) => {
				const phase = (body as { phase: string }).phase;
				phases.push(phase);
				return phase === "pr"
					? { ok: false, error: "Missing permission: vcs.pr.create" }
					: { ok: true, data: { id: "run-1" } };
			},
		});

		expect(review.previewServerMerge()).toEqual({
			success: true,
			data: { success: true, message: "" },
		});
		const merge = await review.mergeServerCard(card);
		expect(merge.success && merge.data?.success).toBe(true);
		expect(merge.data?.merged).toBeUndefined();
		expect(await review.createServerCardPR(card)).toEqual({
			success: false,
			error: "Missing permission: vcs.pr.create",
		});
		expect(phases).toEqual(["merge", "pr"]);

		// Staging is not offered: nothing is asked of the server.
		expect((await review.mergeServerCard(card, { noCommit: true })).success).toBe(false);
		expect(phases).toEqual(["merge", "pr"]);
	});

	it("sends the PR dialog's title, body, target and draft with the run", async () => {
		const { card, review } = await setup();
		const bodies: unknown[] = [];
		serve({
			...SPECS,
			[`POST /projects/${PID}/specs/row-1/runs`]: (body) => {
				bodies.push(body);
				return { ok: true, data: { id: "run-1" } };
			},
		});
		await review.createServerCardPR(card, {
			title: "  Add login ",
			customBody: "## Why\nUsers sign in.",
			targetBranch: "develop",
			draft: true,
			allowCrossReviewDisagreement: true,
			runVisualProof: true,
		});
		await review.createServerCardPR(card, { draft: false });
		expect(bodies).toEqual([
			{
				phase: "pr",
				pr: {
					title: "Add login",
					body: "## Why\nUsers sign in.",
					target_branch: "develop",
					draft: true,
					ignore_cross_review: true,
				},
			},
			// Nothing edited: the server writes the PR from the spec.
			{ phase: "pr" },
		]);
	});

	it("approves as this person, and sends the work back before building again", async () => {
		const { card, review } = await setup();
		const calls: string[] = [];
		const sent: unknown[] = [];
		serve({
			...SPECS,
			[`POST ${CARD}/approve${Q}`]: () => {
				calls.push("approve");
				return { ok: true, data: { approved: true } };
			},
			[`POST ${CARD}/request-changes${Q}`]: (body) => {
				calls.push("request-changes");
				sent.push(body);
				return { ok: true, data: { requested: true } };
			},
			[`POST /projects/${PID}/specs/row-1/runs`]: (body) => {
				calls.push(`run ${(body as { phase: string }).phase}`);
				return { ok: true, data: { id: "run-1" } };
			},
		});

		expect(await review.reviewServerCard(card, true)).toEqual({ success: true });
		expect(calls).toEqual(["approve"]);

		calls.length = 0;
		expect(await review.reviewServerCard(card, false, "  Keep the session.  ")).toEqual({
			success: true,
		});
		expect(sent).toEqual([{ feedback: "Keep the session." }]);
		expect(calls).toEqual(["request-changes", "run build"]);
	});

	it("refuses an empty request or images before asking the server", async () => {
		const { card, review } = await setup();
		connection.authedFetch.mockClear();
		expect((await review.reviewServerCard(card, false, "   ")).success).toBe(false);
		expect((await review.reviewServerCard(card, "yes", "x".repeat(20_001))).success).toBe(
			false,
		);
		expect(
			(await review.reviewServerCard(card, false, "Fix", [{ data: "x" }])).success,
		).toBe(false);
		expect(connection.authedFetch).not.toHaveBeenCalled();
	});

	it("starts no build when the server refuses the request", async () => {
		const { card, review } = await setup();
		const calls: string[] = [];
		serve({
			...SPECS,
			[`POST ${CARD}/request-changes${Q}`]: () => {
				calls.push("request-changes");
				return { ok: false, error: "Missing permission: review.approve" };
			},
			[`POST /projects/${PID}/specs/row-1/runs`]: () => {
				calls.push("run");
				return { ok: true, data: {} };
			},
		});
		expect(await review.reviewServerCard(card, false, "Fix it")).toEqual({
			success: false,
			error: "Missing permission: review.approve",
		});
		expect(calls).toEqual(["request-changes"]);
	});
});
