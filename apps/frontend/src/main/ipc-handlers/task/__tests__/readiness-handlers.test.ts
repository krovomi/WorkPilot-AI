/**
 * The pre-analysis before « En cours »: machine checks first, then one AI
 * review for a short card on its first start, kept for the same text; a
 * review that cannot run never stops the card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	task: null as Record<string, unknown> | null,
	git: { isGitRepo: true, hasCommits: true },
	needsClaude: false,
	profiles: { success: true, profileManager: { hasValidAuth: () => true } } as unknown,
	review: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () => (state.task ? { task: state.task, project: { path: "/p" } } : {}),
}));
vi.mock("../execution-utils", () => ({
	requiresClaudeAuth: () => state.needsClaude,
	ensureProfileManagerInitialized: async () => state.profiles,
}));
vi.mock("../../../project-initializer", () => ({ checkGitStatus: () => state.git }));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../../readiness-review-service", () => ({ readinessReviewService: { review: state.review } }));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: (id: unknown) => (id === "server:p:1" ? { cardId: "1" } : null),
}));

import { checkTaskReadiness, registerReadinessHandlers } from "../readiness-handlers";

let next = 0;
function shortCard(overrides: Record<string, unknown> = {}) {
	next++;
	state.task = { id: `t${next}`, title: "Fix login", description: "", status: "backlog", subtasks: [], ...overrides };
	return state.task.id as string;
}

beforeEach(() => {
	state.task = null;
	state.git = { isGitRepo: true, hasCommits: true };
	state.needsClaude = false;
	state.profiles = { success: true, profileManager: { hasValidAuth: () => true } };
	state.review.mockReset();
});

describe("checkTaskReadiness", () => {
	it("lets a server card or an unknown card through", async () => {
		expect(await checkTaskReadiness("server:p:1")).toEqual({ ready: true });
		expect(await checkTaskReadiness("ghost")).toEqual({ ready: true });
	});

	it("stops a start that would fail on the machine", async () => {
		const id = shortCard();
		state.git = { isGitRepo: false, hasCommits: false };
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, problem: "no_git" });
		state.git = { isGitRepo: true, hasCommits: false };
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, problem: "no_commit" });
		state.git = { isGitRepo: true, hasCommits: true };
		state.needsClaude = true;
		state.profiles = { success: true, profileManager: { hasValidAuth: () => false } };
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, problem: "no_auth" });
		state.profiles = { success: false, error: "x" };
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, problem: "no_auth" });
		expect(state.review).not.toHaveBeenCalled();
	});

	it("reviews a short card once for the same text, again when it changes", async () => {
		state.needsClaude = true;
		const questions = [{ id: "q1", question: "Which page?" }];
		state.review.mockResolvedValue({ ready: false, questions });
		const id = shortCard();
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, questions });
		expect(await checkTaskReadiness(id)).toEqual({ ready: false, questions });
		expect(state.review).toHaveBeenCalledTimes(1);
		expect(state.review).toHaveBeenCalledWith("Fix login", "", "fr");
		(state.task as Record<string, unknown>).description = "On the admin page";
		state.review.mockResolvedValue({ ready: true, questions: [] });
		expect(await checkTaskReadiness(id)).toEqual({ ready: true });
		expect(state.review).toHaveBeenCalledTimes(2);
	});

	it("does not review a described card, a resumed one, or when the review cannot run", async () => {
		expect(await checkTaskReadiness(shortCard({ description: "x".repeat(120) }))).toEqual({ ready: true });
		expect(await checkTaskReadiness(shortCard({ status: "human_review" }))).toEqual({ ready: true });
		expect(await checkTaskReadiness(shortCard({ description: undefined, status: "queue" }))).toEqual({ ready: true });
		expect(state.review).toHaveBeenCalledTimes(1);
		expect(state.review).toHaveBeenLastCalledWith("Fix login", "", "fr");
	});

	it("forgets the oldest verdicts past its bound", async () => {
		state.review.mockResolvedValue({ ready: true, questions: [] });
		const first = shortCard();
		for (let i = 0; i < 200; i++) await checkTaskReadiness(shortCard());
		state.task = { id: first, title: "Fix login", description: "", status: "backlog", subtasks: [] };
		const before = state.review.mock.calls.length;
		await checkTaskReadiness(first);
		expect(state.review.mock.calls.length).toBe(before + 1);
	});
});

describe("the readiness handler", () => {
	it("refuses an id that is not a short string, answers otherwise", async () => {
		registerReadinessHandlers();
		const handler = state.handlers.get(IPC_CHANNELS.TASK_CHECK_READINESS) as (e: unknown, id: unknown) => unknown;
		for (const bad of [42, "", "x".repeat(201), null]) {
			expect(await handler({}, bad)).toEqual({ success: false, error: "Invalid task id" });
		}
		expect(await handler({}, "ghost")).toEqual({ success: true, data: { ready: true } });
	});
});
