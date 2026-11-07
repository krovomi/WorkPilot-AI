/**
 * @vitest-environment node
 *
 * The worktree recipe over IPC: the renderer only names the project (checked
 * by the path policy); what the backend returns reaches it as one shape, and
 * nothing but the project directory is ever sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	fetch: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
	},
}));
vi.mock("../_backend-fetch", () => ({ backendFetch: state.fetch }));

import { IPC_CHANNELS } from "../../../shared/constants";
import { registerWorktreeRecipeHandlers } from "../worktree-recipe-handlers";

const recipe = { source: "detected", setup: [["npm", "ci"]] };
const backendState = {
	success: true,
	recipe,
	detected: recipe,
	hasFile: false,
	approved: true,
	extra: "not forwarded",
};

beforeEach(() => {
	state.handlers.clear();
	state.fetch.mockReset();
	registerWorktreeRecipeHandlers();
});

const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args);

describe("worktree recipe handlers", () => {
	it("reads the project's recipe", async () => {
		state.fetch.mockResolvedValue(backendState);
		const result = await call(IPC_CHANNELS.WORKTREE_RECIPE_GET, "/repo");
		expect(result).toEqual({
			success: true,
			data: { recipe, detected: recipe, hasFile: false, approved: true },
		});
		expect(state.fetch.mock.calls[0][0]).toBe(
			"/api/worktree-recipe?project_dir=%2Frepo",
		);
	});

	it.each([
		[IPC_CHANNELS.WORKTREE_RECIPE_APPROVE, "/api/worktree-recipe/approve"],
		[IPC_CHANNELS.WORKTREE_RECIPE_SAVE_DETECTED, "/api/worktree-recipe/save-detected"],
	])("%s posts only the project directory", async (channel, path) => {
		state.fetch.mockResolvedValue(backendState);
		await call(channel, "/repo", { command: "rm -rf /" });
		expect(state.fetch.mock.calls[0][0]).toBe(path);
		expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({
			project_dir: "/repo",
		});
	});

	it("passes a refusal through", async () => {
		state.fetch.mockResolvedValue({ success: false, error: "worktree.toml already exists" });
		const result = await call(IPC_CHANNELS.WORKTREE_RECIPE_SAVE_DETECTED, "/repo");
		expect(result).toEqual({ success: false, error: "worktree.toml already exists" });
	});
});
