/**
 * Server mode: what the app does to a server card goes to the server, never
 * to this computer. Each action is checked by the request it sends, and the
 * board is read again afterwards.
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

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

/** Serves the server's answers by method and path; records every request. */
function serve(routes: Record<string, (body: unknown) => Reply>) {
	connection.authedFetch.mockImplementation(
		async (url: string, method: string, body?: unknown) => {
			const route = routes[`${method} ${url}`];
			return route ? route(body) : { ok: false, error: `unexpected ${method} ${url}` };
		},
	);
}

function snapshot(cards: Record<string, Record<string, string>>): Reply {
	return { ok: true, data: { cards, worktrees: {} } };
}

const REQUIREMENTS = JSON.stringify({ task_description: "Users sign in." });

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
	const [project] = await listServerProjects();
	return { project, actions: await import("../server-board-actions") };
}

beforeEach(() => {
	TEST_DIR = mkdtempSync(path.join(tmpdir(), "server-actions-test-"));
	mkdirSync(path.join(TEST_DIR, "userData", "store"), { recursive: true });
	connection.authedFetch.mockReset();
	vi.resetModules();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("server card ids", () => {
	it("name their project, and nothing else is taken for one", async () => {
		const { actions } = await setup();
		expect(actions.findServerCard(`server:${PID}:001-login`)?.cardId).toBe("001-login");
		for (const id of [
			"001-login",
			`server:unknown-project:001-login`,
			`server:${PID}:../../etc`,
			`server:${PID}:001-login/..`,
			42,
		]) {
			expect(actions.findServerCard(id)).toBeNull();
		}
	});
});

describe("server card actions", () => {
	it("creates a card on the server and returns it as the board now has it", async () => {
		const { project, actions } = await setup();
		const sent: unknown[] = [];
		serve({
			[`POST /api/board/cards${Q}`]: (body) => {
				sent.push(body);
				return { ok: true, data: { id: "001-login", specId: "row-1" } };
			},
			[`GET /api/board/snapshot${Q}`]: () =>
				snapshot({ "001-login": { "requirements.json": REQUIREMENTS } }),
		});

		const result = await actions.createServerCard(project, " Login ", "Users sign in.", {
			requireReviewBeforeCoding: false,
		});

		expect(sent).toEqual([
			{ title: "Login", description: "Users sign in.", require_review: false },
		]);
		expect(result.success).toBe(true);
		expect(result.data?.id).toBe(`server:${PID}:001-login`);
		expect(result.data?.projectId).toBe(PID);
		// No metadata: a review before coding, as the server defaults.
		await actions.createServerCard(project, "Other", "");
		expect(sent[1]).toMatchObject({ require_review: true });
	});

	it("refuses a card with neither title nor description before asking the server", async () => {
		const { project, actions } = await setup();
		connection.authedFetch.mockClear();
		expect((await actions.createServerCard(project, "  ", " \n ")).success).toBe(false);
		expect(connection.authedFetch).not.toHaveBeenCalled();
	});

	it("titles a card left without one after its description's first line", async () => {
		const { project, actions } = await setup();
		const sent: Array<{ title?: string }> = [];
		serve({
			[`POST /api/board/cards${Q}`]: (body) => {
				sent.push(body as { title?: string });
				return { ok: true, data: { id: "001-login" } };
			},
			[`GET /api/board/snapshot${Q}`]: () =>
				snapshot({ "001-login": { "requirements.json": REQUIREMENTS } }),
		});

		await actions.createServerCard(project, "", "\n  Let users sign in  \nwith email.");
		await actions.createServerCard(project, "", "x".repeat(80));

		expect(sent[0].title).toBe("Let users sign in");
		expect(sent[1].title).toBe(`${"x".repeat(60)}...`);
	});

	it("edits only the title and description, and reports the server's refusal", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		const sent: unknown[] = [];
		serve({
			[`PATCH /api/board/cards/001-login${Q}`]: (body) => {
				sent.push(body);
				return sent.length === 1
					? { ok: true, data: {} }
					: { ok: false, error: "Card already started" };
			},
			[`GET /api/board/snapshot${Q}`]: () =>
				snapshot({ "001-login": { "requirements.json": REQUIREMENTS } }),
		});

		const first = await actions.updateServerCard(card, {
			title: "Sign in",
			metadata: { requireReviewBeforeCoding: false },
		});
		expect(first.success).toBe(true);
		expect(sent).toEqual([{ title: "Sign in" }]);
		expect(await actions.updateServerCard(card, { description: "SSO" })).toEqual({
			success: false,
			error: "Card already started",
		});
	});

	it("sends the engine, priority and category, even once work started", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		const sent: Array<[string, unknown]> = [];
		serve({
			[`PATCH /api/board/cards/001-login/settings${Q}`]: (body) => {
				sent.push(["settings", body]);
				return { ok: true, data: {} };
			},
			[`PATCH /api/board/cards/001-login${Q}`]: (body) => {
				sent.push(["text", body]);
				return { ok: false, error: "Work has started on this card" };
			},
			[`GET /api/board/snapshot${Q}`]: () =>
				snapshot({ "001-login": { "requirements.json": REQUIREMENTS } }),
		});
		const current = await actions.serverCardTask(card.project, card.cardId);
		const result = await actions.updateServerCard(card, {
			// The edit dialog sends the text back unchanged.
			title: current.data?.title,
			description: current.data?.description,
			metadata: {
				provider: "openai",
				model: "gpt-5.5",
				thinkingLevel: "high",
				phaseModels: undefined,
				priority: "urgent",
				category: "",
			},
		});
		expect(result.success).toBe(true);
		expect(sent).toEqual([
			[
				"settings",
				{
					engine: { provider: "openai", model: "gpt-5.5", thinkingLevel: "high" },
					priority: "urgent",
					category: null,
				},
			],
		]);
	});

	it("creates a card with its engine", async () => {
		const { actions, project } = await setup();
		const sent: Array<Record<string, unknown>> = [];
		serve({
			[`POST /api/board/cards${Q}`]: (body) => {
				sent.push(body as Record<string, unknown>);
				return { ok: true, data: { id: "002-new" } };
			},
			[`GET /api/board/snapshot${Q}`]: () => snapshot({}),
		});
		await actions.createServerCard(project, "New", "Text", {
			provider: "claude",
			model: "claude-opus-4-8",
			requireReviewBeforeCoding: true,
		} as never);
		await actions.createServerCard(project, "Plain", "Text", { requireReviewBeforeCoding: true } as never);
		expect(sent[0].settings).toEqual({ engine: { provider: "claude", model: "claude-opus-4-8" } });
		expect(sent[1].settings).toBeUndefined();
	});

	it("sends the dialog's images, and refuses one it cannot send", async () => {
		const { actions, project } = await setup();
		const sent: Array<Record<string, unknown>> = [];
		serve({
			[`POST /api/board/cards${Q}`]: (body) => {
				sent.push(body as Record<string, unknown>);
				return { ok: true, data: { id: "002-new" } };
			},
			[`GET /api/board/snapshot${Q}`]: () => snapshot({}),
		});
		const png = { id: "1", filename: "shot.png", mimeType: "image/png", size: 3, data: "iVBO" };
		await actions.createServerCard(project, "New", "Text", { attachedImages: [png] } as never);
		expect(sent[0].attachments).toEqual([{ filename: "shot.png", mimeType: "image/png", data: "iVBO" }]);

		const svg = { ...png, filename: "logo.svg", mimeType: "image/svg+xml" };
		const refused = await actions.createServerCard(project, "New", "Text", { attachedImages: [svg] } as never);
		expect(refused.success).toBe(false);
		expect(sent).toHaveLength(1);
	});

	it("deletes through the server", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		serve({
			[`DELETE /api/board/cards/001-login${Q}`]: () => ({
				ok: true,
				data: { deleted: "001-login" },
			}),
		});
		expect(await actions.deleteServerCard(card)).toEqual({ success: true });
	});

	it("starts a card as the app does: spec first, then the build", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		const calls: string[] = [];
		const noReview = JSON.stringify({ requireReviewBeforeCoding: false });
		let files: Record<string, string> = {
			"requirements.json": REQUIREMENTS,
			"task_metadata.json": noReview,
		};
		serve({
			[`GET /api/board/snapshot${Q}`]: () => snapshot({ "001-login": files }),
			[`GET /projects/${PID}/specs`]: () => ({
				ok: true,
				data: [{ id: "row-1", spec_name: "001-login" }],
			}),
			[`POST /projects/${PID}/specs/row-1/runs`]: (body) => {
				calls.push(`run ${(body as { phase: string }).phase}`);
				return { ok: true, data: { id: "run-1" } };
			},
		});

		expect(await actions.startServerCard(card)).toEqual({ success: true });
		files = { ...files, "spec.md": "# Login" };
		expect(await actions.startServerCard(card)).toEqual({ success: true });
		// No review asked: nobody's approval is recorded on the person's behalf.
		expect(calls).toEqual(["run spec", "run build"]);
	});

	it("approves a reviewed card's spec, as this person, before building it", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		const calls: string[] = [];
		let approval: Reply = { ok: true, data: { approved: true } };
		serve({
			[`GET /api/board/snapshot${Q}`]: () =>
				snapshot({
					"001-login": {
						"requirements.json": REQUIREMENTS,
						"spec.md": "# Login",
						"task_metadata.json": JSON.stringify({ requireReviewBeforeCoding: true }),
					},
				}),
			[`POST /api/board/cards/001-login/approve${Q}`]: () => {
				calls.push("approve");
				return approval;
			},
			[`GET /projects/${PID}/specs`]: () => ({
				ok: true,
				data: [{ id: "row-1", spec_name: "001-login" }],
			}),
			[`POST /projects/${PID}/specs/row-1/runs`]: (body) => {
				calls.push(`run ${(body as { phase: string }).phase}`);
				return { ok: true, data: { id: "run-1" } };
			},
		});

		expect(await actions.startServerCard(card)).toEqual({ success: true });
		expect(calls).toEqual(["approve", "run build"]);

		// A viewer's approval is refused by the server: nothing is started.
		approval = { ok: false, error: "Missing permission: review.approve" };
		calls.length = 0;
		expect(await actions.startServerCard(card)).toEqual({
			success: false,
			error: "Missing permission: review.approve",
		});
		expect(calls).toEqual(["approve"]);
	});

	it("stops the card's active run and leaves finished ones alone", async () => {
		const { actions } = await setup();
		const card = actions.findServerCard(`server:${PID}:001-login`);
		if (!card) throw new Error("card");
		const cancelled: string[] = [];
		let runs = [
			{ id: "run-2", status: "running" },
			{ id: "run-1", status: "failed" },
		];
		serve({
			[`GET /projects/${PID}/specs`]: () => ({
				ok: true,
				data: [{ id: "row-1", spec_name: "001-login" }],
			}),
			[`GET /projects/${PID}/specs/row-1/runs`]: () => ({ ok: true, data: runs }),
			[`POST /projects/${PID}/specs/row-1/runs/run-2/cancel`]: () => {
				cancelled.push("run-2");
				return { ok: true, data: { cancelled: true } };
			},
		});

		expect(await actions.stopServerCard(card)).toEqual({ success: true });
		runs = [{ id: "run-1", status: "failed" }];
		expect(await actions.stopServerCard(card)).toEqual({ success: true });
		expect(cancelled).toEqual(["run-2"]);
	});
});
