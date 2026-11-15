/**
 * The Insights chat store: messages and the streamed answer, the session
 * list, each session action sent to the main process, and the stream events
 * that only the project on screen may receive.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsSession } from "../../../shared/types";
import {
	clearSession,
	createTaskFromSuggestion,
	deleteSession,
	loadInsightsSession,
	loadInsightsSessions,
	newSession,
	renameSession,
	sendMessage,
	setupInsightsListeners,
	switchSession,
	updateModelConfig,
	useInsightsStore,
} from "../insights-store";

type Listener = (...args: unknown[]) => void;
const on: Record<string, Listener> = {};
const listen = (name: string) =>
	vi.fn((cb: Listener) => {
		on[name] = cb;
		return () => {
			delete on[name];
		};
	});

const api = {
	listInsightsSessions: vi.fn(),
	getInsightsSession: vi.fn(),
	sendInsightsMessage: vi.fn(),
	clearInsightsSession: vi.fn(),
	newInsightsSession: vi.fn(),
	switchInsightsSession: vi.fn(),
	deleteInsightsSession: vi.fn(),
	renameInsightsSession: vi.fn(),
	updateInsightsModelConfig: vi.fn(),
	createTaskFromInsights: vi.fn(),
	onInsightsStreamChunk: listen("chunk"),
	onInsightsStatus: listen("status"),
	onInsightsError: listen("error"),
	onInsightsSessionUpdated: listen("sessionUpdated"),
};

const INITIAL = useInsightsStore.getState();
const store = () => useInsightsStore.getState();

function session(id: string, overrides: Partial<InsightsSession> = {}): InsightsSession {
	return {
		id,
		projectId: "p1",
		messages: [],
		createdAt: new Date("2026-11-01"),
		updatedAt: new Date("2026-11-01"),
		...overrides,
	} as InsightsSession;
}

beforeEach(() => {
	for (const [name, fn] of Object.entries(api)) {
		if (!name.startsWith("on")) fn.mockReset();
	}
	api.listInsightsSessions.mockResolvedValue({ success: true, data: [] });
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	useInsightsStore.setState(INITIAL, true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("messages", () => {
	it("starts a session with the first message, then appends", () => {
		store().addMessage({ id: "m1", role: "user", content: "hi" } as never);
		expect(store().session?.messages.map((m) => m.id)).toEqual(["m1"]);
		store().addMessage({ id: "m2", role: "assistant", content: "yo" } as never);
		expect(store().session?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("turns the streamed text and tools into one assistant message", () => {
		store().appendStreamingContent("Hel");
		store().appendStreamingContent("lo");
		store().addToolUsage({ name: "Read", input: "a.ts" });
		store().finalizeStreamingMessage({ title: "Do it" } as never);
		const [message] = store().session?.messages ?? [];
		expect(message).toMatchObject({
			role: "assistant",
			content: "Hello",
			suggestedTask: { title: "Do it" },
			toolsUsed: [{ name: "Read", input: "a.ts" }],
		});
		expect(store()).toMatchObject({ streamingContent: "", toolsUsed: [] });

		store().appendStreamingContent("again");
		store().finalizeStreamingMessage();
		expect(store().session?.messages).toHaveLength(2);
		expect(store().session?.messages[1].toolsUsed).toBeUndefined();
	});

	it("adds nothing when the answer was empty", () => {
		store().finalizeStreamingMessage();
		expect(store().session).toBeNull();
	});

	it("keeps explanations on the session only", () => {
		store().addExplanation({ id: "e1" } as never);
		expect(store().session).toBeNull();
		store().setSession(session("s1"));
		store().addExplanation({ id: "e1" } as never);
		store().addExplanation({ id: "e2" } as never);
		expect(store().session?.explanations).toEqual([{ id: "e1" }, { id: "e2" }]);
	});

	it("clears the chat but keeps the learning mode", () => {
		store().setSession(session("s1"));
		store().setPendingMessage("draft");
		store().setLearningModeEnabled(true);
		store().setCurrentExplanation({ id: "e" } as never);
		store().setCurrentTool({ name: "Grep" });
		store().clearSession();
		expect(store()).toMatchObject({
			session: null,
			pendingMessage: "",
			currentTool: null,
			currentExplanation: null,
			learningModeEnabled: true,
		});
	});
});

describe("sessions", () => {
	it("loads the project's session and list, and remembers the project shown", async () => {
		api.getInsightsSession.mockResolvedValue({ success: true, data: session("s1") });
		api.listInsightsSessions.mockResolvedValue({ success: true, data: [{ id: "s1" }] });
		await loadInsightsSession("p1");
		expect(store()).toMatchObject({
			projectId: "p1",
			session: { id: "s1" },
			sessions: [{ id: "s1" }],
			isLoadingSessions: false,
		});
		api.getInsightsSession.mockResolvedValue({ success: false });
		api.listInsightsSessions.mockResolvedValue({ success: false });
		await loadInsightsSession("p2");
		expect(store()).toMatchObject({ projectId: "p2", session: null, sessions: [] });
	});

	it("stops loading even when listing throws", async () => {
		api.listInsightsSessions.mockRejectedValue(new Error("ipc"));
		await expect(loadInsightsSessions("p1")).rejects.toThrow("ipc");
		expect(store().isLoadingSessions).toBe(false);
	});

	it("sends a message with the given model, else the session's", () => {
		store().setSession(session("s1", { modelConfig: { model: "sonnet" } as never }));
		store().setPendingMessage("q?");
		store().appendStreamingContent("old");
		sendMessage("p1", "q?");
		expect(api.sendInsightsMessage).toHaveBeenCalledWith("p1", "q?", { model: "sonnet" });
		expect(store()).toMatchObject({
			pendingMessage: "",
			streamingContent: "",
			status: { phase: "thinking" },
		});
		expect(store().session?.messages.at(-1)).toMatchObject({ role: "user", content: "q?" });
		sendMessage("p1", "again", { model: "opus" } as never);
		expect(api.sendInsightsMessage).toHaveBeenLastCalledWith("p1", "again", { model: "opus" });
	});

	it("clears and reloads, or leaves things alone when refused", async () => {
		store().setSession(session("old"));
		api.clearInsightsSession.mockResolvedValue({ success: false });
		await clearSession("p1");
		expect(store().session?.id).toBe("old");
		api.clearInsightsSession.mockResolvedValue({ success: true });
		api.getInsightsSession.mockResolvedValue({ success: true, data: session("fresh") });
		await clearSession("p1");
		expect(store().session?.id).toBe("fresh");
	});

	it("opens a new session and reloads the list", async () => {
		api.newInsightsSession.mockResolvedValue({ success: true, data: session("n") });
		api.listInsightsSessions.mockResolvedValue({ success: true, data: [{ id: "n" }] });
		await newSession("p1");
		expect(store().session?.id).toBe("n");
		expect(store().sessions).toEqual([{ id: "n" }]);
		api.newInsightsSession.mockResolvedValue({ success: false });
		await newSession("p1");
		expect(store().session?.id).toBe("n");
	});

	it("switches session and resets the stream", async () => {
		store().appendStreamingContent("half");
		store().setCurrentTool({ name: "Read" });
		store().setStatus({ phase: "streaming", message: "x" });
		api.switchInsightsSession.mockResolvedValue({ success: false });
		await switchSession("p1", "s2");
		expect(store().streamingContent).toBe("half");
		api.switchInsightsSession.mockResolvedValue({ success: true, data: session("s2") });
		await switchSession("p1", "s2");
		expect(api.switchInsightsSession).toHaveBeenCalledWith("p1", "s2");
		expect(store()).toMatchObject({
			session: { id: "s2" },
			streamingContent: "",
			currentTool: null,
			status: { phase: "idle" },
		});
	});

	it("deletes and renames, saying whether it worked", async () => {
		api.deleteInsightsSession.mockResolvedValue({ success: true });
		api.getInsightsSession.mockResolvedValue({ success: true, data: session("next") });
		expect(await deleteSession("p1", "s1")).toBe(true);
		expect(store().session?.id).toBe("next");
		api.deleteInsightsSession.mockResolvedValue({ success: false });
		expect(await deleteSession("p1", "s1")).toBe(false);

		api.renameInsightsSession.mockResolvedValue({ success: true });
		expect(await renameSession("p1", "s1", "Title")).toBe(true);
		expect(api.renameInsightsSession).toHaveBeenCalledWith("p1", "s1", "Title");
		api.renameInsightsSession.mockResolvedValue({ success: false });
		expect(await renameSession("p1", "s1", "T")).toBe(false);
	});

	it("updates the model of the session on screen only", async () => {
		store().setSession(session("s1"));
		api.updateInsightsModelConfig.mockResolvedValue({ success: true });
		expect(await updateModelConfig("p1", "s1", { model: "haiku" } as never)).toBe(true);
		expect(store().session?.modelConfig).toEqual({ model: "haiku" });
		expect(await updateModelConfig("p1", "other", { model: "opus" } as never)).toBe(true);
		expect(store().session?.modelConfig).toEqual({ model: "haiku" });
		api.updateInsightsModelConfig.mockResolvedValue({ success: false });
		expect(await updateModelConfig("p1", "s1", {} as never)).toBe(false);
	});

	it("creates a task from a suggestion", async () => {
		api.createTaskFromInsights.mockResolvedValue({ success: true, data: { id: "t1" } });
		expect(await createTaskFromSuggestion("p1", "T", "D", { category: "feature" } as never)).toEqual({
			id: "t1",
		});
		expect(api.createTaskFromInsights).toHaveBeenCalledWith("p1", "T", "D", { category: "feature" });
		api.createTaskFromInsights.mockResolvedValue({ success: false });
		expect(await createTaskFromSuggestion("p1", "T", "D")).toBeNull();
	});
});

describe("setupInsightsListeners", () => {
	let off: () => void;

	beforeEach(() => {
		useInsightsStore.setState({ projectId: "p1" });
		off = setupInsightsListeners();
	});

	afterEach(() => off());

	it("streams text and tools of the project shown", () => {
		on.chunk("p1", { type: "tool_start", tool: { name: "Grep", input: "x" } });
		expect(store().currentTool).toEqual({ name: "Grep", input: "x" });
		expect(store().status.message).toBe("Using Grep...");
		on.chunk("p1", { type: "tool_end" });
		expect(store().currentTool).toBeNull();
		on.chunk("p1", { type: "text", content: "Answer" });
		expect(store()).toMatchObject({ streamingContent: "Answer", status: { phase: "streaming" } });
		on.chunk("p1", { type: "text" });
		on.chunk("p1", { type: "tool_start" });
		expect(store().toolsUsed).toHaveLength(1);
		on.chunk("p1", { type: "done" });
		expect(store().session?.messages[0]).toMatchObject({ content: "Answer" });
		expect(store().status.phase).toBe("complete");
	});

	it("keeps explanations, suggestions and errors", () => {
		store().setSession(session("s1"));
		on.chunk("p1", { type: "explanation", explanation: { id: "e" } });
		on.chunk("p1", { type: "explanation" });
		expect(store().currentExplanation).toEqual({ id: "e" });
		expect(store().session?.explanations).toEqual([{ id: "e" }]);
		on.chunk("p1", { type: "task_suggestion", suggestedTask: { title: "T" } });
		expect(store().session?.messages[0].suggestedTask).toEqual({ title: "T" });
		on.chunk("p1", { type: "error", error: "rate limited" });
		expect(store().status).toEqual({ phase: "error", error: "rate limited" });
		on.status("p1", { phase: "thinking", message: "m" });
		expect(store().status.phase).toBe("thinking");
		on.error("p1", "down");
		expect(store().status).toEqual({ phase: "error", error: "down" });
	});

	it("does not mix another project's answer into the one on screen", () => {
		store().setSession(session("s1"));
		on.chunk("p2", { type: "text", content: "elsewhere" });
		on.chunk("p2", { type: "done" });
		on.status("p2", { phase: "thinking", message: "m" });
		on.error("p2", "boom");
		expect(store().streamingContent).toBe("");
		expect(store().session?.messages).toEqual([]);
		expect(store().status.phase).toBe("idle");
	});

	it("takes the saved session when it is the one shown, and refreshes the list", async () => {
		store().setSession(session("s1"));
		api.listInsightsSessions.mockResolvedValue({ success: true, data: [{ id: "s1", title: "Named" }] });
		on.sessionUpdated("p1", session("s1", { title: "Named" } as never));
		expect(store().session).toMatchObject({ title: "Named" });
		on.sessionUpdated("p1", session("other", { title: "X" } as never));
		expect(store().session?.id).toBe("s1");
		await vi.waitFor(() => expect(store().sessions).toEqual([{ id: "s1", title: "Named" }]));
	});

	it("logs a list refresh that fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.listInsightsSessions.mockRejectedValue(new Error("ipc"));
		on.sessionUpdated("p1", session("s9"));
		await vi.waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"Failed to refresh sessions list after update:",
				expect.any(Error),
			),
		);
	});

	it("unsubscribes everything", () => {
		off();
		off = () => undefined;
		expect(Object.keys(on)).toEqual([]);
	});
});
