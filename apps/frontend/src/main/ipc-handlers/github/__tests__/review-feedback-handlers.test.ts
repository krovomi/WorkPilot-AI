/**
 * The two feedback channels (#361): every argument the renderer sends is
 * checked before a project is looked up, a server project's call goes to the
 * server (lot 3) without touching a folder, and an unknown project is refused.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const handlers = vi.hoisted(
	() => new Map<string, (...args: unknown[]) => Promise<unknown>>(),
);
const state = vi.hoisted(() => ({
	projects: new Map<string, { path: string }>(),
	remote: new Set<string>(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
			handlers.set(channel, fn),
	},
}));
vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));
vi.mock("../../server-review-jobs", () => ({
	serverProjectOf: (id: unknown) =>
		typeof id === "string" && state.remote.has(id) ? { id } : undefined,
}));
const server = vi.hoisted(() => ({
	record: vi.fn(),
	read: vi.fn(),
}));
vi.mock("../review-feedback-server", () => ({
	recordServerFeedback: server.record,
	serverFeedback: server.read,
}));
vi.mock("../utils/project-middleware", () => ({
	withProjectOrNull: async (
		id: string,
		fn: (project: { path: string }) => Promise<unknown>,
	) => {
		const project = state.projects.get(id);
		return project ? fn(project) : null;
	},
}));

import { registerReviewFeedbackHandlers } from "../review-feedback-handlers";

let root: string;

function call(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args);
}

beforeEach(() => {
	handlers.clear();
	state.projects.clear();
	state.remote.clear();
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-feedback-ipc-")));
	const dir = path.join(root, ".workpilot", "github", "pr");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "review_3.json"),
		JSON.stringify({
			findings: [
				{ id: "f-1", category: "style", severity: "low", title: "Nit" },
			],
		}),
	);
	state.projects.set("p1", { path: root });
	state.remote.add("remote");
	registerReviewFeedbackHandlers();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const SET = IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_SET;
const GET = IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_GET;
const REJECT = { findingId: "f-1", verdict: "rejected", reason: "other" };

describe("setting feedback", () => {
	it("records it and answers the PR's verdicts", async () => {
		await expect(call(SET, "p1", 3, REJECT)).resolves.toEqual({
			success: true,
			feedback: { "f-1": "rejected" },
		});
		await expect(call(GET, "p1", 3)).resolves.toEqual({
			success: true,
			feedback: { "f-1": "rejected" },
		});
	});

	it.each([
		["a project id that is not text", [{ id: "p1" }, 3, REJECT]],
		["a hostile verdict", ["p1", 3, { findingId: "f-1", verdict: "drop_table" }]],
		["a path for a PR number", ["p1", "../../x", REJECT]],
	])("refuses %s", async (_label, args) => {
		await expect(call(SET, ...args)).resolves.toEqual({
			success: false,
			error: "invalid",
		});
	});

	it("sends a server project's checked verdict to the server", async () => {
		server.record.mockResolvedValueOnce({ success: true, feedback: {}, held: [] });
		await expect(call(SET, "remote", 3, REJECT)).resolves.toEqual({
			success: true,
			feedback: {},
			held: [],
		});
		expect(server.record).toHaveBeenCalledWith(
			{ id: "remote" },
			expect.objectContaining({ prNumber: 3, findingId: REJECT.findingId }),
		);
	});

	it("checks a server project's arguments before sending them", async () => {
		server.record.mockClear();
		await expect(
			call(SET, "remote", 3, { findingId: "f-1", verdict: "drop_table" }),
		).resolves.toEqual({ success: false, error: "invalid" });
		expect(server.record).not.toHaveBeenCalled();
	});

	it("refuses a project it does not know", async () => {
		await expect(call(SET, "nobody", 3, REJECT)).resolves.toEqual({
			success: false,
			error: "not_found",
		});
	});
});

describe("reading feedback", () => {
	it.each([
		["a project id that is not text", [42, 3]],
		["a PR number that is not one", ["p1", 0]],
	])("refuses %s", async (_label, args) => {
		await expect(call(GET, ...args)).resolves.toEqual({
			success: false,
			error: "invalid",
		});
	});

	it("reads a server project from the server and refuses an unknown one", async () => {
		server.read.mockResolvedValueOnce({ success: true, feedback: { a: "accepted" } });
		await expect(call(GET, "remote", 3)).resolves.toEqual({
			success: true,
			feedback: { a: "accepted" },
		});
		expect(server.read).toHaveBeenCalledWith({ id: "remote" }, 3);
		await expect(call(GET, "nobody", 3)).resolves.toEqual({
			success: false,
			error: "not_found",
		});
	});
});
