/**
 * The memory-lifecycle channels take a project id and a memory's vault path.
 * Main looks the project up, revalidates every argument and refuses a hostile
 * one before the backend is ever called (rule S6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, { id: string; path: string; remote?: unknown }>(),
	backendFetch: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("../../_backend-fetch", () => ({ backendFetch: state.backendFetch }));
vi.mock("../../server-feature-files", () => ({
	featureProject: (id: unknown) =>
		typeof id === "string" ? state.projects.get(id) : undefined,
}));

import { registerMemoryLifecycleHandlers } from "../memory-lifecycle-handlers";
import { conflictId, memoryId, trashId } from "../memory-lifecycle-validation";

const MEMORY = "knowledge/projects/shop/memory/gotchas/never-push-on-friday.md";

function call(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<{ success: boolean; error?: string; data?: unknown }>;
}

beforeEach(() => {
	state.handlers.clear();
	state.projects.clear();
	state.backendFetch.mockReset();
	state.projects.set("p1", { id: "p1", path: "/work/shop" });
	state.projects.set("remote", { id: "remote", path: "/srv/x", remote: { serverId: "s" } });
	registerMemoryLifecycleHandlers();
});

describe("a memory is named by its vault path, checked in main", () => {
	it.each([
		"../../../etc/passwd.md",
		"/etc/passwd.md",
		"knowledge/projects/shop/memory/gotchas/../../../../x.md",
		"knowledge/projects/shop/memory/.lifecycle/journal/2026-11.md",
		"knowledge/projects/shop/memory/secrets/x.md",
		"knowledge/projects/shop/memory/gotchas/x.txt",
		"knowledge\\projects\\shop\\memory\\gotchas\\x.md",
		"C:/Windows/x.md",
		"",
		42,
		null,
		`knowledge/projects/shop/memory/gotchas/${"a".repeat(500)}.md`,
	])("refuses %s", async (hostile) => {
		expect(memoryId(hostile)).toBeNull();
		for (const channel of [
			IPC_CHANNELS.CONTEXT_MEMORY_FORGET,
			IPC_CHANNELS.CONTEXT_MEMORY_PIN,
			IPC_CHANNELS.CONTEXT_MEMORY_HISTORY,
		]) {
			expect(await call(channel, "p1", hostile, true)).toEqual({
				success: false,
				error: "invalid",
			});
		}
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "p1", hostile)).toEqual({
			success: false,
			error: "invalid",
		});
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("accepts a memory, a trash id and a conflict id of the right shape", () => {
		expect(memoryId(MEMORY)).toBe(MEMORY);
		expect(memoryId("knowledge/projects/shop/memory/sessions/001-login/session-001.md")).not.toBeNull();
		expect(trashId("gotchas/never-push-on-friday.md")).toBe("gotchas/never-push-on-friday.md");
		expect(trashId("../gotchas/x.md")).toBeNull();
		expect(conflictId("0123456789abcdef")).toBe("0123456789abcdef");
		expect(conflictId("0123456789abcdef; rm -rf /")).toBeNull();
	});

	it("refuses a pin that is not a boolean, a choice off the list and an oversized text", async () => {
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, "yes")).toEqual({
			success: false,
			error: "invalid",
		});
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", "0123456789abcdef", "merge-all", ""),
		).toEqual({ success: false, error: "invalid" });
		expect(
			await call(
				IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT,
				"p1",
				"0123456789abcdef",
				"custom",
				"x".repeat(5000),
			),
		).toEqual({ success: false, error: "invalid" });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "p1", MEMORY, "x".repeat(301)),
		).toEqual({ success: false, error: "invalid" });
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("never takes a path from the renderer: the project is looked up by id", async () => {
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "/etc")).toEqual({
			success: false,
			error: "project-not-found",
		});
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "remote")).toEqual({
			success: false,
			error: "server-project",
		});
		expect(state.backendFetch).not.toHaveBeenCalled();
	});
});

describe("valid calls reach /api/brain/memory/*", () => {
	it("forgets with the project's own path and the person's reason", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, trash_id: "gotchas/x.md" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "p1", MEMORY, "obsolete")).toEqual({
			success: true,
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/forget");
		expect(JSON.parse(init.body)).toEqual({
			project_dir: "/work/shop",
			id: MEMORY,
			reason: "obsolete",
		});
	});

	it("reads the lifecycle view and passes refusal codes through", async () => {
		state.backendFetch.mockResolvedValueOnce({
			success: true,
			journal: [],
			trash: [],
			conflicts: [],
			pinned: 3,
			pin_limit: 50,
			retention_days: 30,
		});
		const view = await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1");
		expect(view).toEqual({
			success: true,
			data: { journal: [], trash: [], conflicts: [], pinned: 3, pinLimit: 50, retentionDays: 30 },
		});
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "pin-limit", code: "pin-limit" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, true)).toEqual({
			success: false,
			error: "pin-limit",
		});
	});
});
