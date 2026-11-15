/**
 * The terminal store: the per-project limit, restored and external
 * terminals, Claude mode flags, tab order, the staggered resume of deferred
 * Claude sessions, and restoring a project's sessions from disk once their
 * PTYs are gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../../../shared/types";
import { terminalBufferManager } from "../../lib/terminal-buffer-manager";
import {
	registerOutputCallback,
	restoreTerminalSessions,
	useTerminalStore,
	writeToTerminal,
} from "../terminal-store";

const api = {
	activateDeferredClaudeResume: vi.fn(),
	checkTerminalPtyAlive: vi.fn(),
	getTerminalSessions: vi.fn(),
};

const INITIAL = useTerminalStore.getState();
const store = () => useTerminalStore.getState();

function session(id: string, overrides: Partial<TerminalSession> = {}): TerminalSession {
	return {
		id,
		title: `T ${id}`,
		cwd: "/p",
		projectPath: "/p",
		createdAt: "2026-11-14T10:00:00Z",
		isClaudeMode: false,
		outputBuffer: "",
		...overrides,
	} as TerminalSession;
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useTerminalStore.setState(INITIAL, true);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("adding terminals", () => {
	it("numbers new terminals, activates them and stops at the project's limit", () => {
		useTerminalStore.setState({ maxTerminals: 2 });
		const a = store().addTerminal("/p/a", "/p");
		expect(a).toMatchObject({ title: "Terminal 1", cwd: "/p/a", status: "idle", displayOrder: 0 });
		expect(store().activeTerminalId).toBe(a?.id);
		store().addTerminal(undefined, "/p");
		expect(store().canAddTerminal("/p")).toBe(false);
		expect(store().addTerminal("/p", "/p")).toBeNull();
		expect(store().canAddTerminal("/q")).toBe(true);
		expect(store().addTerminal(undefined, "/q")?.cwd).toBe("");

		store().setTerminalStatus(a?.id as string, "exited");
		expect(store().canAddTerminal("/p")).toBe(true);
	});

	it("adds an external terminal as running, once", () => {
		useTerminalStore.setState({ maxTerminals: 1 });
		const ext = store().addExternalTerminal("ext-1", "Agent", "/p", "/p");
		expect(ext).toMatchObject({ id: "ext-1", status: "running", title: "Agent" });
		store().setActiveTerminal(null);
		expect(store().addExternalTerminal("ext-1", "Again")).toBe(ext);
		expect(store().activeTerminalId).toBe("ext-1");
		expect(store().addExternalTerminal("ext-2", "Other", undefined, "/p")).toBeNull();
		expect(store().addExternalTerminal("ext-3", "Elsewhere")?.cwd).toBe("");
	});

	it("restores a saved session with its buffer and defers its Claude resume", () => {
		const restored = store().addRestoredTerminal(
			session("s1", { outputBuffer: "$ ls\n", isClaudeMode: true, claudeSessionId: "c1", displayOrder: 4 }),
		);
		expect(restored).toMatchObject({
			id: "s1",
			isRestored: true,
			isClaudeMode: false,
			claudeSessionId: "c1",
			pendingClaudeResume: true,
			displayOrder: 4,
			createdAt: new Date("2026-11-14T10:00:00Z"),
		});
		expect(terminalBufferManager.get("s1")).toBe("$ ls\n");
		expect(store().activeTerminalId).toBe("s1");
		store().addRestoredTerminal(session("s2"));
		expect(store().activeTerminalId).toBe("s1");
		expect(store().getTerminal("s2")?.displayOrder).toBe(1);
	});

	it("restoring a terminal it already has only refreshes the buffer and the resume", () => {
		const first = store().addRestoredTerminal(session("s1"));
		const again = store().addRestoredTerminal(
			session("s1", { outputBuffer: "new", isClaudeMode: true }),
		);
		expect(again).toBe(first);
		expect(store().terminals).toHaveLength(1);
		expect(store().getTerminal("s1")?.pendingClaudeResume).toBe(true);
		expect(terminalBufferManager.get("s1")).toBe("new");
		store().addRestoredTerminal(session("s1", { isClaudeMode: true }));
		expect(store().terminals).toHaveLength(1);
	});
});

describe("changing terminals", () => {
	beforeEach(() => {
		store().addExternalTerminal("a", "A");
		store().addExternalTerminal("b", "B");
		store().addExternalTerminal("c", "C");
	});

	it("removes a terminal, its buffer and its output callback", () => {
		const write = vi.fn();
		registerOutputCallback("c", write);
		terminalBufferManager.set("c", "old");
		store().removeTerminal("c");
		expect(store().terminals.map((t) => t.id)).toEqual(["a", "b"]);
		expect(store().activeTerminalId).toBe("b");
		expect(terminalBufferManager.get("c")).toBe("");
		writeToTerminal("c", "late");
		expect(write).not.toHaveBeenCalled();
		store().setActiveTerminal("a");
		store().removeTerminal("b");
		expect(store().activeTerminalId).toBe("a");
		store().removeTerminal("a");
		expect(store().activeTerminalId).toBeNull();
	});

	it("keeps each flag on the right terminal", () => {
		store().updateTerminal("a", { title: "Renamed" });
		store().setClaudeSessionId("a", "sess");
		store().setAssociatedTask("a", "task-1");
		store().setWorktreeConfig("b", { name: "wt" } as never);
		store().setPendingClaudeResume("a", true);
		expect(store().getTerminal("a")).toMatchObject({
			title: "Renamed",
			claudeSessionId: "sess",
			associatedTaskId: "task-1",
			pendingClaudeResume: true,
		});
		expect(store().getTerminal("b")?.worktreeConfig).toEqual({ name: "wt" });
		expect(store().getWorktreeCount()).toBe(1);
		expect(store().getTerminal("c")?.title).toBe("C");
	});

	it("clears busy and naming flags when Claude mode ends", () => {
		store().setClaudeMode("a", true);
		store().setClaudeBusy("a", true);
		store().setClaudeNamedOnce("a", true);
		expect(store().getTerminal("a")).toMatchObject({
			status: "claude-active",
			isClaudeBusy: true,
			claudeNamedOnce: true,
		});
		store().setClaudeMode("a", true);
		expect(store().getTerminal("a")?.isClaudeBusy).toBe(true);
		store().setClaudeMode("a", false);
		expect(store().getTerminal("a")).toMatchObject({
			isClaudeMode: false,
			status: "running",
			isClaudeBusy: undefined,
			claudeNamedOnce: undefined,
		});
	});

	it("reorders tabs and renumbers their order", () => {
		store().reorderTerminals("c", "a");
		expect(store().terminals.map((t) => [t.id, t.displayOrder])).toEqual([
			["c", 0],
			["a", 1],
			["b", 2],
		]);
		const before = store().terminals;
		store().reorderTerminals("missing", "a");
		expect(store().terminals).toBe(before);
	});

	it("spotlights a terminal from elsewhere, and clears everything", () => {
		store().jumpToTerminal("b");
		expect(store()).toMatchObject({ jumpToTerminalId: "b", activeTerminalId: "b" });
		expect(store().getActiveTerminal()?.id).toBe("b");
		store().clearTerminalJump();
		expect(store().jumpToTerminalId).toBeNull();
		store().setHasRestoredSessions(true);
		store().clearAllTerminals();
		expect(store()).toMatchObject({ terminals: [], activeTerminalId: null, hasRestoredSessions: false });
	});

	it("lists a project's terminals", () => {
		store().addTerminal("/p", "/p");
		expect(store().getTerminalsForProject("/p")).toHaveLength(1);
	});
});

describe("resuming deferred Claude sessions", () => {
	it("does nothing when none is pending", async () => {
		store().addExternalTerminal("a", "A");
		await store().resumeAllPendingClaude();
		expect(api.activateDeferredClaudeResume).not.toHaveBeenCalled();
	});

	it("resumes each pending session half a second apart, clearing its flag first", async () => {
		vi.useFakeTimers();
		store().addRestoredTerminal(session("a", { isClaudeMode: true }));
		store().addRestoredTerminal(session("b"));
		store().addRestoredTerminal(session("c", { isClaudeMode: true }));
		const done = store().resumeAllPendingClaude();
		expect(api.activateDeferredClaudeResume.mock.calls).toEqual([["a"]]);
		expect(store().getTerminal("a")?.pendingClaudeResume).toBe(false);
		expect(store().getTerminal("c")?.pendingClaudeResume).toBe(true);
		await vi.advanceTimersByTimeAsync(500);
		await done;
		expect(api.activateDeferredClaudeResume.mock.calls).toEqual([["a"], ["c"]]);
		expect(store().getTerminal("c")?.pendingClaudeResume).toBe(false);
	});
});

describe("restoreTerminalSessions", () => {
	it("ignores an empty project path", async () => {
		await restoreTerminalSessions("");
		expect(api.getTerminalSessions).not.toHaveBeenCalled();
	});

	it("restores the saved sessions in their tab order", async () => {
		api.getTerminalSessions.mockResolvedValue({
			success: true,
			data: [session("late"), session("second", { displayOrder: 1 }), session("first", { displayOrder: 0 })],
		});
		await restoreTerminalSessions("/p");
		expect(api.getTerminalSessions).toHaveBeenCalledWith("/p");
		expect(store().terminals.map((t) => t.id)).toEqual(["first", "second", "late"]);
		expect(store().hasRestoredSessions).toBe(true);
	});

	it("keeps live terminals without reading the disk", async () => {
		store().addExternalTerminal("live", "L", "/p", "/p");
		api.checkTerminalPtyAlive.mockResolvedValue({ success: true, data: { alive: true } });
		await restoreTerminalSessions("/p");
		expect(api.checkTerminalPtyAlive).toHaveBeenCalledWith("live");
		expect(api.getTerminalSessions).not.toHaveBeenCalled();
		expect(store().terminals.map((t) => t.id)).toEqual(["live"]);
	});

	it("drops the terminals whose PTY died and restores them from disk", async () => {
		store().addExternalTerminal("live", "L", "/p", "/p");
		store().addExternalTerminal("dead", "D", "/p", "/p");
		store().addExternalTerminal("gone", "G", "/p", "/p");
		api.checkTerminalPtyAlive.mockImplementation(async (id: string) => {
			if (id === "gone") throw new Error("no pty");
			return { success: true, data: { alive: id === "live" } };
		});
		api.getTerminalSessions.mockResolvedValue({ success: true, data: [session("dead")] });
		await restoreTerminalSessions("/p");
		expect(store().terminals.map((t) => [t.id, t.isRestored ?? false])).toEqual([
			["live", false],
			["dead", true],
		]);
	});

	it("stops when the disk has no session, and survives a failing read", async () => {
		api.getTerminalSessions.mockResolvedValue({ success: true, data: [] });
		await restoreTerminalSessions("/p");
		api.getTerminalSessions.mockResolvedValue({ success: false });
		await restoreTerminalSessions("/p");
		expect(store().hasRestoredSessions).toBe(false);
		api.getTerminalSessions.mockRejectedValue(new Error("ipc"));
		await restoreTerminalSessions("/p");
		expect(store().terminals).toEqual([]);
	});

	it("runs one restore at a time per project", async () => {
		let release: (v: unknown) => void = () => undefined;
		api.getTerminalSessions.mockReturnValue(
			new Promise((r) => {
				release = r;
			}),
		);
		const first = restoreTerminalSessions("/p");
		await restoreTerminalSessions("/p");
		expect(api.getTerminalSessions).toHaveBeenCalledTimes(1);
		release({ success: true, data: [session("x")] });
		await first;
		api.getTerminalSessions.mockResolvedValue({ success: true, data: [] });
		await restoreTerminalSessions("/p");
		expect(api.getTerminalSessions).toHaveBeenCalledTimes(2);
	});
});
