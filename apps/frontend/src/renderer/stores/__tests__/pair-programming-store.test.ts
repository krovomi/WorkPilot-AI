/**
 * AI pair programming: starting, following and stopping a session, the chat,
 * the AI's work log, conflicts, and the session of the project on screen.
 *
 * @vitest-environment jsdom
 */
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadPairSession,
	sendPairMessage,
	setupPairProgrammingListeners,
	startPairSession,
	stopPairSession,
	usePairProgrammingStore,
} from "../pair-programming-store";
import { useProjectStore } from "../project-store";

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
let api: Record<string, ReturnType<typeof vi.fn>>;

const session = (id = "s1", extra: object = {}) =>
	({ id, projectId: "p1", goal: "g", status: "active", messages: [], aiActions: [], ...extra }) as never;
const state = () => usePairProgrammingStore.getState();
const emit = (name: string, ...args: unknown[]) => handlers.get(name)?.(...args);

beforeEach(async () => {
	await i18n.changeLanguage("en");
	handlers.clear();
	state().reset();
	const on = (name: string) =>
		vi.fn((handler: Handler) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		});
	api = {
		startPairSession: vi.fn().mockResolvedValue({ success: true, data: session() }),
		stopPairSession: vi.fn().mockResolvedValue({ success: true }),
		sendPairMessage: vi.fn(),
		getPairSession: vi.fn().mockResolvedValue({ success: true, data: null }),
		onPairStreamChunk: on("chunk"),
		onPairStatus: on("status"),
		onPairAiAction: on("action"),
		onPairConflict: on("conflict"),
		onPairError: on("error"),
		onPairComplete: on("complete"),
		onPairReview: on("review"),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	// The page shows project p1.
	await loadPairSession("p1");
	api.getPairSession.mockClear();
});

describe("a session", () => {
	it("starts from a clean state and says what it is doing, in the app's language", async () => {
		state().addMessage({ id: "old", role: "user", content: "x", timestamp: "" });
		const starting = startPairSession({ projectId: "p1", goal: "g" } as never);
		expect(state()).toMatchObject({ messages: [], status: "planning", statusMessage: "Starting the pair programming session…" });
		await starting;
		expect(state()).toMatchObject({ session: { id: "s1" }, status: "planning" });
		expect(state().statusMessage).toMatch(/^Analyzing the project/);

		await i18n.changeLanguage("fr");
		await stopPairSession("p1", "s1");
		expect(api.stopPairSession).toHaveBeenCalledWith("p1", "s1");
		expect(state()).toMatchObject({ status: "completed", statusMessage: "Session arrêtée." });
		expect(state().session?.status).toBe("completed");
	});

	it("says why it could not start", async () => {
		api.startPairSession.mockResolvedValueOnce({ success: false, error: "no provider" });
		await startPairSession({} as never);
		expect(state()).toMatchObject({ status: "error", statusMessage: "no provider", session: null });
		api.startPairSession.mockResolvedValueOnce({ success: true });
		await startPairSession({} as never);
		expect(state().statusMessage).toBe("Failed to start pair programming session");
	});

	it("keeps the session's own status when the app goes back to idle", () => {
		state().setSession(session("s1", { status: "paused" }));
		state().setStatus("idle");
		expect(state()).toMatchObject({ status: "idle", statusMessage: "", session: { status: "paused" } });
	});

	it("shows the developer's message at once and sends it", () => {
		state().setPendingMessage("hello");
		sendPairMessage("p1", "s1", "hello");
		sendPairMessage("p1", "s1", "again");
		expect(api.sendPairMessage).toHaveBeenCalledWith("p1", "s1", "hello");
		expect(state().pendingMessage).toBe("");
		const [first, second] = state().messages;
		expect([first.role, first.content, second.content]).toEqual(["user", "hello", "again"]);
		expect(first.id).not.toBe(second.id);
	});
});

describe("the session's events", () => {
	beforeEach(() => {
		setupPairProgrammingListeners();
		state().setSession(session());
	});

	it("streams the AI's answer into one message, and asks its questions apart", () => {
		emit("chunk", "p1", { type: "stream", content: "Let me " });
		emit("chunk", "p1", { type: "stream", content: "look.  " });
		emit("chunk", "p1", { type: "stream" });
		expect(state().streamingContent).toBe("Let me look.  ");
		emit("chunk", "p1", { type: "question", content: "Which file?" });
		emit("chunk", "p1", { type: "question" });
		expect(state().messages.map((m) => [m.role, m.content, m.isQuestion ?? false])).toEqual([
			["ai", "Let me look.", false],
			["ai", "Which file?", true],
		]);
		expect(state().streamingContent).toBe("");
		expect(new Set(state().messages.map((m) => m.id)).size).toBe(2);
	});

	it("ends on done, error and complete, with the main process's words or the app's", () => {
		emit("chunk", "p1", { type: "stream", content: "  " });
		emit("chunk", "p1", { type: "done" });
		expect(state()).toMatchObject({ status: "completed", statusMessage: "Session completed.", messages: [] });
		emit("chunk", "p1", { type: "done", summary: "3 files" });
		expect(state().statusMessage).toBe("3 files");
		emit("chunk", "p1", { type: "error" });
		expect(state()).toMatchObject({ status: "error", statusMessage: "An error occurred." });
		emit("chunk", "p1", { type: "error", message: "crashed" });
		expect(state().statusMessage).toBe("crashed");
		emit("chunk", "p1", { type: "unknown" });

		emit("chunk", "p1", { type: "stream", content: "last words" });
		emit("complete", "p1", "all done");
		expect(state()).toMatchObject({ status: "completed", statusMessage: "all done" });
		expect(state().messages.at(-1)?.content).toBe("last words");
		emit("error", "p1", "killed");
		expect(state()).toMatchObject({ status: "error", statusMessage: "killed" });
	});

	it("follows the status, the AI's actions, conflicts and the review card", () => {
		emit("status", "p1", "active", "Working");
		expect(state()).toMatchObject({ status: "active", statusMessage: "Working", session: { status: "active" } });
		emit("action", "p1", { id: "a1", type: "file_created" });
		expect(state().aiActions).toEqual([{ id: "a1", type: "file_created" }]);
		emit("conflict", "p1", "src/a.ts", "both edited");
		emit("conflict", "p1", "src/b.ts", "both edited");
		expect(state().conflicts.map((c) => c.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(state().conflicts[0].id).not.toBe(state().conflicts[1].id);
		emit("review", "p1", null);
		expect(state().review).toBeNull();
	});

	it("ignores every event of another project", () => {
		const before = state();
		emit("chunk", "p2", { type: "stream", content: "x" });
		emit("status", "p2", "error", "x");
		emit("action", "p2", { id: "a" });
		emit("conflict", "p2", "f", "m");
		emit("error", "p2", "x");
		emit("complete", "p2", "x");
		emit("review", "p2", null);
		expect(state()).toEqual(before);
	});

	it("drops its seven listeners on teardown", () => {
		handlers.clear();
		const teardown = setupPairProgrammingListeners();
		expect(handlers.size).toBe(7);
		teardown();
		expect(handlers.size).toBe(0);
	});
});

describe("the session of the project on screen", () => {
	it("brings back the project's session with its chat and AI log", async () => {
		const messages = [{ id: "m", role: "user", content: "hi", timestamp: "" }];
		api.getPairSession.mockResolvedValueOnce({ success: true, data: session("s1", { messages, aiActions: [{ id: "a" }] }) });
		await loadPairSession("p1");
		expect(api.getPairSession).toHaveBeenCalledWith("p1");
		expect(state()).toMatchObject({ session: { id: "s1" }, status: "active", messages, aiActions: [{ id: "a" }] });
	});

	it("replaces the last project's session, or clears it when this one has none", async () => {
		state().setSession(session("other"));
		state().addMessage({ id: "m", role: "user", content: "from the other project", timestamp: "" });
		api.getPairSession.mockResolvedValueOnce({ success: true, data: session("s2") });
		await loadPairSession("p1");
		expect(state()).toMatchObject({ session: { id: "s2" }, messages: [] });

		await loadPairSession("p1");
		expect(state()).toMatchObject({ session: null, status: "idle" });
		state().setSession(session("x"));
		api.getPairSession.mockResolvedValueOnce({ success: false });
		await loadPairSession("p1");
		expect(state().session).toBeNull();
	});

	it("keeps the live session it already shows", async () => {
		state().setSession(session("s1"));
		state().addMessage({ id: "live", role: "ai", content: "streamed", timestamp: "" });
		api.getPairSession.mockResolvedValueOnce({ success: true, data: session("s1") });
		await loadPairSession("p1");
		expect(state().messages.map((m) => m.id)).toEqual(["live"]);

		state().reset();
		let started: (value: unknown) => void = vi.fn();
		api.startPairSession.mockReturnValueOnce(new Promise((resolve) => (started = resolve)));
		const starting = startPairSession({ projectId: "p1" } as never);
		await loadPairSession("p1");
		expect(state().status).toBe("planning");
		started({ success: true, data: session("s9") });
		await starting;
		expect(state().session?.id).toBe("s9");
	});

	it("shows the project of its page, whichever project is selected", async () => {
		useProjectStore.setState({ selectedProjectId: "p2" });
		api.getPairSession.mockResolvedValueOnce({ success: true, data: session("s1") });
		await loadPairSession("p1");
		expect(state().session?.id).toBe("s1");
	});

	it("clears the last project's session at once, and drops its late answers", async () => {
		state().setSession(session("s1"));
		state().addMessage({ id: "m", role: "user", content: "for p1", timestamp: "" });
		let answer: (value: unknown) => void = vi.fn();
		api.getPairSession.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const loading = loadPairSession("p2");
		expect(state()).toMatchObject({ session: null, messages: [] });

		let late: (value: unknown) => void = vi.fn();
		api.getPairSession.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
		const back = loadPairSession("p1");
		answer({ success: true, data: session("s2", { projectId: "p2" }) });
		await loading;
		expect(state().session).toBeNull();
		late({ success: true, data: null });
		await back;

		let started: (value: unknown) => void = vi.fn();
		api.startPairSession.mockReturnValueOnce(new Promise((resolve) => (started = resolve)));
		const starting = startPairSession({ projectId: "p1" } as never);
		await loadPairSession("p3");
		started({ success: true, data: session("s9") });
		await starting;
		expect(state()).toMatchObject({ session: null, status: "idle" });
	});
});
