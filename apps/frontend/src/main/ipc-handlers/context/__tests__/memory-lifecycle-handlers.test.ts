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
import {
	conflictId,
	entryId,
	maintainerNames,
	memoryId,
	scopeText,
	trashId,
} from "../memory-lifecycle-validation";

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
			data: {
				journal: [],
				revertible: {},
				lastUndo: null,
				metrics: null,
				maintainers: [],
				canArbitrate: true,
				trash: [],
				conflicts: [],
				pinned: 3,
				pinLimit: 50,
				retentionDays: 30,
			},
		});
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "pin-limit", code: "pin-limit" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, true)).toEqual({
			success: false,
			error: "pin-limit",
		});
	});
});

describe("history, restore and the backend's refusals", () => {
	it("reads a memory's history, and passes a refusal through", async () => {
		const entry = { at: "2026-11-14T10:00:00Z", action: "created", path: MEMORY };
		state.backendFetch.mockResolvedValueOnce({ success: true, entries: [entry] });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, "p1", MEMORY)).toEqual({
			success: true,
			data: [entry],
		});
		const [path] = state.backendFetch.mock.calls[0];
		expect(path).toBe(
			`/api/brain/memory/history?${new URLSearchParams({ project_dir: "/work/shop", id: MEMORY })}`,
		);

		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, "p1", MEMORY)).toEqual({
			success: true,
			data: [],
		});

		state.backendFetch.mockResolvedValueOnce({ success: false, error: "not-found" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, "p1", MEMORY)).toEqual({
			success: false,
			error: "not-found",
		});
	});

	it("restores from the trash and says what the restored memory contradicts", async () => {
		state.backendFetch.mockResolvedValueOnce({
			success: true,
			path: MEMORY,
			contradicts: ["knowledge/projects/shop/memory/gotchas/push-any-day.md"],
		});
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "p1", "gotchas/never-push-on-friday.md"),
		).toEqual({
			success: true,
			data: {
				path: MEMORY,
				contradicts: ["knowledge/projects/shop/memory/gotchas/push-any-day.md"],
			},
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/restore");
		expect(JSON.parse(init.body)).toEqual({
			project_dir: "/work/shop",
			id: "gotchas/never-push-on-friday.md",
		});

		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "p1", "gotchas/never-push-on-friday.md"),
		).toEqual({ success: true, data: { path: "", contradicts: [] } });

		state.backendFetch.mockResolvedValueOnce({ success: false, error: "gone", code: "expired" });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "p1", "gotchas/never-push-on-friday.md"),
		).toEqual({ success: false, error: "expired" });
	});

	it("passes the lifecycle view's refusal through", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "backend-down" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1")).toEqual({
			success: false,
			error: "backend-down",
		});
	});

	it("answers server-project for history, forget and restore of a server project", async () => {
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, "remote", MEMORY)).toEqual({
			success: false,
			error: "server-project",
		});
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "remote", MEMORY, "old")).toEqual({
			success: false,
			error: "server-project",
		});
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "remote", "gotchas/never-push-on-friday.md"),
		).toEqual({ success: false, error: "server-project" });
		expect(state.backendFetch).not.toHaveBeenCalled();
	});
});

describe("pins, conflicts and the arbiter's opinion", () => {
	const CONFLICT = "0123456789abcdef";

	it("fills the lifecycle view's defaults when the backend leaves them out", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1")).toEqual({
			success: true,
			data: {
				journal: [],
				revertible: {},
				lastUndo: null,
				metrics: null,
				maintainers: [],
				canArbitrate: true,
				trash: [],
				conflicts: [],
				pinned: 0,
				pinLimit: 50,
				retentionDays: 30,
			},
		});
	});

	it("passes a refused forget through", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "missing" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "p1", MEMORY, "")).toEqual({
			success: false,
			error: "missing",
		});
	});

	it("pins and reports how many memories are pinned", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, count: 4 });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, true)).toEqual({
			success: true,
			data: { count: 4 },
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/pin");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", id: MEMORY, pinned: true });

		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, false)).toEqual({
			success: true,
			data: { count: 0 },
		});
	});

	it("resolves a conflict with the person's choice", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, canonical: MEMORY });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", CONFLICT, "custom", "Never on Friday."),
		).toEqual({ success: true, data: { canonical: MEMORY } });
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/conflicts/resolve");
		expect(JSON.parse(init.body)).toEqual({
			project_dir: "/work/shop",
			conflict_id: CONFLICT,
			choice: "custom",
			text: "Never on Friday.",
		});

		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", CONFLICT, "dismiss"),
		).toEqual({ success: true, data: { canonical: null } });

		state.backendFetch.mockResolvedValueOnce({ success: false, error: "stale", code: "resolved" });
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", CONFLICT, "dismiss"),
		).toEqual({ success: false, error: "resolved" });
	});

	it("refuses a custom resolution with nothing written", async () => {
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", CONFLICT, "custom", "   "),
		).toEqual({ success: false, error: "invalid" });
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("asks the arbiter, and says when it had no answer", async () => {
		const opinion = { verdict: "contradiction", prefer: "a", canonical: "Never on Friday.", reason: "newer" };
		state.backendFetch.mockResolvedValueOnce({ success: true, opinion });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, "p1", CONFLICT)).toEqual({
			success: true,
			data: opinion,
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/conflicts/suggest");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", conflict_id: CONFLICT });

		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, "p1", CONFLICT)).toEqual({
			success: false,
			error: "no-answer",
		});

		state.backendFetch.mockResolvedValueOnce({ success: false, error: "provider-down" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, "p1", CONFLICT)).toEqual({
			success: false,
			error: "provider-down",
		});
	});

	it("refuses a hostile conflict id and every call on a server project", async () => {
		expect(
			await call(IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, "p1", "../../x"),
		).toEqual({ success: false, error: "invalid" });
		for (const [channel, args] of [
			[IPC_CHANNELS.CONTEXT_MEMORY_PIN, [MEMORY, true]],
			[IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, [CONFLICT, "dismiss"]],
			[IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, [CONFLICT]],
		] as const) {
			expect(await call(channel, "remote", ...args)).toEqual({
				success: false,
				error: "server-project",
			});
		}
		expect(state.backendFetch).not.toHaveBeenCalled();
	});
});

describe("taking a decision back", () => {
	const ENTRY = "0123456789ab";

	it("names an entry by its journal id only", async () => {
		expect(entryId(ENTRY)).toBe(ENTRY);
		for (const hostile of ["../../x", "0123456789abc", "0123456789AB", 12, null]) {
			expect(entryId(hostile)).toBeNull();
			expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "p1", hostile)).toEqual({
				success: false,
				error: "invalid",
			});
		}
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "remote", ENTRY)).toEqual({
			success: false,
			error: "server-project",
		});
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("reverts with the project's own path and reads the outcome", async () => {
		state.backendFetch.mockResolvedValueOnce({
			success: true,
			mode: "unmerge",
			restored: [MEMORY],
			conflict: "0123456789abcdef",
		});
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "p1", ENTRY)).toEqual({
			success: true,
			data: { mode: "unmerge", restored: [MEMORY], conflict: "0123456789abcdef" },
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/revert");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", entry_id: ENTRY });

		state.backendFetch.mockResolvedValueOnce({ success: true, mode: "anything" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "p1", ENTRY)).toEqual({
			success: true,
			data: { mode: "undo", restored: [], conflict: null },
		});

		state.backendFetch.mockResolvedValueOnce({
			success: false,
			error: "not-revertible",
			code: "not-revertible",
		});
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "p1", ENTRY)).toEqual({
			success: false,
			error: "not-revertible",
		});
	});
});

describe("a memory's scope and the maintainers", () => {
	it("checks a scope and the maintainers' names in main", async () => {
		expect(scopeText("apps/billing/")).toBe("apps/billing/");
		expect(scopeText(undefined)).toBe("");
		for (const hostile of ["a\nb", "x\u007f", "x".repeat(201), 3]) {
			expect(scopeText(hostile)).toBeNull();
			expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, "p1", MEMORY, hostile)).toEqual({
				success: false,
				error: "invalid",
			});
		}
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, "p1", "../x.md", "apps/")).toEqual({
			success: false,
			error: "invalid",
		});
		expect(maintainerNames([" Bob ", "carol@example.com"])).toEqual(["Bob", "carol@example.com"]);
		for (const hostile of [
			"Bob",
			[""],
			[" "],
			["a\u0000b"],
			[42],
			["x".repeat(121)],
			Array.from({ length: 21 }, (_, n) => `p${n}`),
		]) {
			expect(maintainerNames(hostile)).toBeNull();
			expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, "p1", hostile)).toEqual({
				success: false,
				error: "invalid",
			});
		}
		for (const [channel, args] of [
			[IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, [MEMORY, "apps/"]],
			[IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, [["Bob"]]],
		] as const) {
			expect(await call(channel, "remote", ...args)).toEqual({
				success: false,
				error: "server-project",
			});
		}
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("sends a scope and the maintainers with the project's own path", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, applies_to: "apps/" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, "p1", MEMORY, "apps/")).toEqual({
			success: true,
			data: { appliesTo: "apps/" },
		});
		let [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/scope");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", id: MEMORY, applies_to: "apps/" });
		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, "p1", MEMORY, "")).toEqual({
			success: true,
			data: { appliesTo: "" },
		});
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "not-found" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, "p1", MEMORY, "apps/")).toEqual({
			success: false,
			error: "not-found",
		});

		state.backendFetch.mockResolvedValueOnce({ success: true, maintainers: ["Bob"] });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, "p1", ["Bob"])).toEqual({
			success: true,
			data: ["Bob"],
		});
		[path, init] = state.backendFetch.mock.calls[3];
		expect(path).toBe("/api/brain/memory/maintainers");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", names: ["Bob"] });
		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, "p1", [])).toEqual({
			success: true,
			data: [],
		});
		state.backendFetch.mockResolvedValueOnce({ success: false, error: "invalid", code: "invalid" });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, "p1", ["Bob"])).toEqual({
			success: false,
			error: "invalid",
		});
	});

	it("says whether the person here may settle an escalated pair", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, maintainers: ["Bob"], can_arbitrate: false });
		const view = (await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1")) as {
			data: { maintainers: string[]; canArbitrate: boolean };
		};
		expect(view.data.maintainers).toEqual(["Bob"]);
		expect(view.data.canArbitrate).toBe(false);
	});
});
