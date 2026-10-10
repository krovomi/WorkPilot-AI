/**
 * @vitest-environment jsdom
 */

/**
 * Context-aware snippets store: the form, the run, and the four ways a run
 * ends. The one that used to be missing is the request that never starts —
 * refused by the main process or rejected by IPC — which left the spinner
 * turning for ever because nothing awaited the invoke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const mockCancel = vi.fn();
const mockOnChunk = vi.fn();
const mockOnStatus = vi.fn();
const mockOnError = vi.fn();
const mockOnComplete = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();

	Object.defineProperty(globalThis, "electronAPI", {
		value: {
			generateContextAwareSnippet: mockGenerate,
			cancelSnippetGeneration: mockCancel,
			onSnippetStreamChunk: mockOnChunk,
			onSnippetStatus: mockOnStatus,
			onSnippetError: mockOnError,
			onSnippetComplete: mockOnComplete,
		},
		writable: true,
		configurable: true,
	});
});

const RESULT = {
	snippet: "export const a = 1;",
	language: "typescript",
	description: "A constant",
	context_used: ["AGENTS.md"],
	adaptations: ["Named export"],
	reasoning: "r",
};

describe("Context-Aware Snippets Store", () => {
	let store: typeof import("../context-aware-snippets-store");
	let useStore: typeof import("../context-aware-snippets-store").useContextAwareSnippetsStore;

	beforeEach(async () => {
		mockOnChunk.mockReturnValue(vi.fn());
		mockOnStatus.mockReturnValue(vi.fn());
		mockOnError.mockReturnValue(vi.fn());
		mockOnComplete.mockReturnValue(vi.fn());
		mockGenerate.mockResolvedValue({ success: true });
		mockCancel.mockResolvedValue({ success: true, cancelled: true });

		store = await import("../context-aware-snippets-store");
		useStore = store.useContextAwareSnippetsStore;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("initial state", () => {
		it("starts idle with an empty form", () => {
			const state = useStore.getState();
			expect(state.phase).toBe("idle");
			expect(state.status).toBe("");
			expect(state.result).toBeNull();
			expect(state.error).toBeNull();
			expect(state.errorCode).toBeNull();
			expect(state.isOpen).toBe(false);
			expect(state.snippetType).toBe("component");
			expect(state.autoDetectLanguage).toBe(true);
		});
	});

	describe("startSnippetGeneration", () => {
		it("sends the project id, the form, and no language when auto-detecting", async () => {
			useStore.setState({
				snippetType: "hook",
				description: "a counter",
				language: "python",
				autoDetectLanguage: true,
			});

			await store.startSnippetGeneration("project-1");

			expect(mockGenerate).toHaveBeenCalledWith(
				"project-1",
				"hook",
				"a counter",
				undefined,
			);
			expect(useStore.getState().phase).toBe("generating");
			expect(useStore.getState().status).toBe("context");
		});

		it("sends the chosen language", async () => {
			useStore.setState({
				description: "a counter",
				language: "go",
				autoDetectLanguage: false,
			});

			await store.startSnippetGeneration("project-1");

			expect(mockGenerate.mock.calls[0][3]).toBe("go");
		});

		it("clears what the previous run left", async () => {
			useStore.setState({
				description: "x",
				phase: "error",
				error: "old",
				errorCode: "auth",
				streamingOutput: "old output",
				result: RESULT,
			});

			await store.startSnippetGeneration("project-1");

			const state = useStore.getState();
			expect(state.error).toBeNull();
			expect(state.errorCode).toBeNull();
			expect(state.streamingOutput).toBe("");
			expect(state.result).toBeNull();
		});

		it("does nothing without a description", async () => {
			useStore.setState({ description: "   " });

			await store.startSnippetGeneration("project-1");

			expect(mockGenerate).not.toHaveBeenCalled();
			expect(useStore.getState().phase).toBe("idle");
		});

		it("shows the main process's refusal instead of spinning", async () => {
			mockGenerate.mockResolvedValue({
				success: false,
				error: { code: "project_not_found", message: "project-1" },
			});
			useStore.setState({ description: "x" });

			await store.startSnippetGeneration("project-1");

			const state = useStore.getState();
			expect(state.phase).toBe("error");
			expect(state.errorCode).toBe("project_not_found");
			expect(state.error).toBe("project-1");
		});

		it("shows a rejected invoke instead of spinning", async () => {
			mockGenerate.mockRejectedValue(
				new Error("No handler registered for 'context-aware-snippets:generate'"),
			);
			useStore.setState({ description: "x" });

			await store.startSnippetGeneration("project-1");

			const state = useStore.getState();
			expect(state.phase).toBe("error");
			expect(state.errorCode).toBe("ipc_failed");
			expect(state.error).toContain("No handler registered");
		});

		it("shows a missing preload method instead of spinning", async () => {
			Object.defineProperty(globalThis, "electronAPI", {
				value: {},
				writable: true,
				configurable: true,
			});
			useStore.setState({ description: "x" });

			await store.startSnippetGeneration("project-1");

			expect(useStore.getState().errorCode).toBe("ipc_failed");
		});

		it("does not overwrite a run the user cancelled meanwhile", async () => {
			let answer: (value: unknown) => void = () => undefined;
			mockGenerate.mockReturnValue(
				new Promise((resolve) => {
					answer = resolve;
				}),
			);
			useStore.setState({ description: "x" });

			const started = store.startSnippetGeneration("project-1");
			store.cancelSnippetGeneration();
			answer({ success: false, error: { code: "spawn_failed", message: "" } });
			await started;

			expect(useStore.getState().phase).toBe("idle");
			expect(useStore.getState().errorCode).toBeNull();
		});
	});

	describe("cancelSnippetGeneration", () => {
		it("stops the run and goes back to the form, inputs kept", () => {
			useStore.setState({
				phase: "generating",
				streamingOutput: "partial",
				description: "keep me",
			});

			store.cancelSnippetGeneration();

			const state = useStore.getState();
			expect(mockCancel).toHaveBeenCalledTimes(1);
			expect(state.phase).toBe("idle");
			expect(state.streamingOutput).toBe("");
			expect(state.description).toBe("keep me");
		});

		it("does nothing when nothing runs", () => {
			store.cancelSnippetGeneration();
			expect(mockCancel).not.toHaveBeenCalled();
		});
	});

	describe("closing and reopening", () => {
		it("does not stop a run in flight", () => {
			useStore.setState({ isOpen: true, phase: "generating" });

			useStore.getState().closeDialog();

			expect(useStore.getState().isOpen).toBe(false);
			expect(useStore.getState().phase).toBe("generating");
			expect(mockCancel).not.toHaveBeenCalled();
		});

		it("keeps a finished snippet to show when reopened from the sidebar", () => {
			useStore.setState({ isOpen: true, phase: "complete", result: RESULT });

			useStore.getState().closeDialog();
			store.openContextAwareSnippetsDialog();

			const state = useStore.getState();
			expect(state.isOpen).toBe(true);
			expect(state.phase).toBe("complete");
			expect(state.result).toEqual(RESULT);
		});

		it("resets a failed run", () => {
			useStore.setState({
				isOpen: true,
				phase: "error",
				error: "boom",
				errorCode: "auth",
			});

			useStore.getState().closeDialog();

			const state = useStore.getState();
			expect(state.phase).toBe("idle");
			expect(state.error).toBeNull();
			expect(state.errorCode).toBeNull();
		});

		it("opens a fresh form when nothing is pending", () => {
			useStore.setState({ description: "stale", snippetType: "api" });

			store.openContextAwareSnippetsDialog();

			const state = useStore.getState();
			expect(state.isOpen).toBe(true);
			expect(state.description).toBe("");
			expect(state.snippetType).toBe("component");
		});
	});

	describe("resetSnippetRun", () => {
		it("goes back to the form after a result, inputs kept", () => {
			useStore.setState({
				phase: "complete",
				result: RESULT,
				description: "keep me",
			});

			store.resetSnippetRun();

			const state = useStore.getState();
			expect(state.phase).toBe("idle");
			expect(state.result).toBeNull();
			expect(state.description).toBe("keep me");
		});
	});

	describe("setError", () => {
		it("keeps the code of a structured error", () => {
			useStore.getState().setError({ code: "rate_limit", message: "429" });

			const state = useStore.getState();
			expect(state.phase).toBe("error");
			expect(state.errorCode).toBe("rate_limit");
			expect(state.error).toBe("429");
		});

		it("reads a bare string as generic", () => {
			useStore.getState().setError("boom");
			expect(useStore.getState().errorCode).toBe("generic");
		});
	});

	describe("setupContextAwareSnippetsListeners", () => {
		it("registers the four listeners and removes them all", () => {
			const unsubs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
			mockOnChunk.mockReturnValue(unsubs[0]);
			mockOnStatus.mockReturnValue(unsubs[1]);
			mockOnError.mockReturnValue(unsubs[2]);
			mockOnComplete.mockReturnValue(unsubs[3]);

			const cleanup = store.setupContextAwareSnippetsListeners();
			cleanup();

			for (const unsub of unsubs) expect(unsub).toHaveBeenCalledTimes(1);
		});

		it("feeds a running generation", () => {
			useStore.setState({ phase: "generating" });
			mockOnChunk.mockImplementation((cb: (chunk: string) => void) => {
				cb("{\"snip");
				cb("pet\"");
				return vi.fn();
			});
			mockOnStatus.mockImplementation((cb: (status: string) => void) => {
				cb("parsing");
				return vi.fn();
			});
			mockOnComplete.mockImplementation((cb: (result: unknown) => void) => {
				cb(RESULT);
				return vi.fn();
			});

			store.setupContextAwareSnippetsListeners();

			const state = useStore.getState();
			expect(state.streamingOutput).toBe('{"snippet"');
			expect(state.phase).toBe("complete");
			expect(state.result).toEqual(RESULT);
			expect(state.status).toBe("");
		});

		it("reports a coded error event", () => {
			useStore.setState({ phase: "generating" });
			mockOnError.mockImplementation((cb: (error: unknown) => void) => {
				cb({ code: "process_failed", message: "exit 1" });
				return vi.fn();
			});

			store.setupContextAwareSnippetsListeners();

			expect(useStore.getState().phase).toBe("error");
			expect(useStore.getState().errorCode).toBe("process_failed");
		});

		it("ignores events of a run that is no longer running", () => {
			mockOnComplete.mockImplementation((cb: (result: unknown) => void) => {
				cb(RESULT);
				return vi.fn();
			});

			store.setupContextAwareSnippetsListeners();

			expect(useStore.getState().result).toBeNull();
			expect(useStore.getState().phase).toBe("idle");
		});
	});
});
