/**
 * Learning loop: the patterns learned from a project's builds, the summary
 * shown next to them, an analysis and its events, and the review lessons.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	adoptReviewLesson,
	cancelLearningAnalysis,
	deleteLearningPattern,
	dismissReviewLesson,
	loadLearningPatterns,
	loadLearningSummary,
	loadReviewLessons,
	openLearningLoopDialog,
	setupLearningLoopListeners,
	startLearningAnalysis,
	toggleLearningPattern,
	useLearningLoopStore,
} from "../learning-loop-store";

type Handler = (value: unknown) => void;
const handlers = new Map<string, Handler>();
let api: Record<string, ReturnType<typeof vi.fn>>;
let errors: ReturnType<typeof vi.spyOn>;

const pattern = (id: string, enabled = true) => ({ pattern_id: id, enabled }) as never;
const summary = (total: number, enabled: number, disabled: number) =>
	({ total_patterns: total, enabled_count: enabled, disabled_count: disabled }) as never;
const lesson = (id: string, status = "candidate") => ({ id, status, rule: "" }) as never;
const state = () => useLearningLoopStore.getState();

beforeEach(() => {
	handlers.clear();
	state().reset();
	errors = vi.spyOn(console, "error").mockReturnValue(undefined);
	const on = (name: string) =>
		vi.fn((handler: Handler) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		});
	api = {
		getLearningPatterns: vi.fn().mockResolvedValue({ success: true, data: [pattern("a"), pattern("b", false)] }),
		getLearningSummary: vi.fn().mockResolvedValue({ success: true, data: summary(2, 1, 1) }),
		runLearningAnalysis: vi.fn(),
		stopLearningAnalysis: vi.fn().mockResolvedValue(undefined),
		deleteLearningPattern: vi.fn().mockResolvedValue({ success: true }),
		toggleLearningPattern: vi.fn().mockResolvedValue({ success: true, data: false }),
		getReviewLessons: vi.fn().mockResolvedValue({ success: true, data: [lesson("l1"), lesson("l2")] }),
		adoptReviewLesson: vi.fn().mockResolvedValue({ success: true, data: lesson("l1", "adopted") }),
		dismissReviewLesson: vi.fn().mockResolvedValue({ success: true }),
		onLearningLoopStreamChunk: on("chunk"),
		onLearningLoopStatus: on("status"),
		onLearningLoopError: on("error"),
		onLearningLoopComplete: on("complete"),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("the dialog", () => {
	it("opens on a fresh state and closes", () => {
		state().setPatterns([pattern("old")]);
		state().setError("old");
		openLearningLoopDialog();
		expect(state()).toMatchObject({ isOpen: true, patterns: [], error: null, phase: "idle" });
		state().appendStreamingOutput("x");
		state().closeDialog();
		expect(state()).toMatchObject({ isOpen: false, streamingOutput: "" });
	});
});

describe("patterns and their summary", () => {
	beforeEach(async () => {
		await loadLearningPatterns("/p");
		await loadLearningSummary("/p");
	});

	it("loads both for the project", () => {
		expect(api.getLearningPatterns).toHaveBeenCalledWith("/p");
		expect(state()).toMatchObject({ patterns: [{ pattern_id: "a" }, { pattern_id: "b" }], summary: summary(2, 1, 1), isLoading: false });
	});

	it("disables a pattern, and the summary counts it as disabled", async () => {
		expect(await toggleLearningPattern("/p", "a")).toBe(true);
		expect(api.toggleLearningPattern).toHaveBeenCalledWith("/p", "a");
		expect(state().patterns.map((p) => p.enabled)).toEqual([false, false]);
		expect(state().summary).toEqual(summary(2, 0, 2));
	});

	it("deletes a pattern, and the summary loses it from the right count", async () => {
		expect(await deleteLearningPattern("/p", "b")).toBe(true);
		expect(state().patterns.map((p) => p.pattern_id)).toEqual(["a"]);
		expect(state().summary).toEqual(summary(1, 1, 0));
		expect(await deleteLearningPattern("/p", "a")).toBe(true);
		expect(state().summary).toEqual(summary(0, 0, 0));
	});

	it("changes no count for a pattern it does not list, nor without a summary", async () => {
		expect(await deleteLearningPattern("/p", "gone")).toBe(true);
		state().updatePatternInList("gone", { enabled: true });
		expect(state().summary).toEqual(summary(2, 1, 1));
		state().setSummary(null);
		await deleteLearningPattern("/p", "a");
		expect(state().summary).toBeNull();
	});

	it("changes nothing when the main process refuses or fails", async () => {
		const before = state();
		api.deleteLearningPattern.mockResolvedValueOnce({ success: false });
		api.toggleLearningPattern.mockResolvedValueOnce({ success: true });
		expect(await deleteLearningPattern("/p", "a")).toBe(false);
		expect(await toggleLearningPattern("/p", "a")).toBe(false);
		api.deleteLearningPattern.mockRejectedValueOnce(new Error("x"));
		api.toggleLearningPattern.mockRejectedValueOnce(new Error("x"));
		expect(await deleteLearningPattern("/p", "a")).toBe(false);
		expect(await toggleLearningPattern("/p", "a")).toBe(false);
		expect(state().patterns).toBe(before.patterns);
		expect(state().summary).toBe(before.summary);
	});

	it("keeps what it had when a read fails, and logs why", async () => {
		const before = state();
		api.getLearningPatterns.mockResolvedValueOnce({ success: false, error: "no store" });
		api.getLearningPatterns.mockResolvedValueOnce({ success: false });
		api.getLearningPatterns.mockRejectedValueOnce(new Error("x"));
		api.getLearningSummary.mockResolvedValueOnce({ success: false });
		api.getLearningSummary.mockRejectedValueOnce(new Error("x"));
		for (let i = 0; i < 3; i++) await loadLearningPatterns("/p");
		for (let i = 0; i < 2; i++) await loadLearningSummary("/p");
		expect(state()).toMatchObject({ patterns: before.patterns, summary: before.summary, isLoading: false });
		expect(errors).toHaveBeenCalledTimes(3);
	});
});

describe("an analysis", () => {
	it("starts clean, streams, and ends with the new patterns and summary", () => {
		setupLearningLoopListeners();
		state().setError("old");
		state().appendStreamingOutput("old");
		startLearningAnalysis("/p", "007");
		expect(api.runLearningAnalysis).toHaveBeenCalledWith("/p", "007");
		expect(state()).toMatchObject({ phase: "analyzing", status: "", streamingOutput: "", error: null });

		handlers.get("status")?.("Reading builds");
		handlers.get("chunk")?.("one ");
		handlers.get("chunk")?.("two");
		expect(state()).toMatchObject({ status: "Reading builds", streamingOutput: "one two" });

		handlers.get("complete")?.({ patterns: [pattern("n")], summary: summary(1, 1, 0) });
		expect(state()).toMatchObject({ phase: "complete", status: "", patterns: [{ pattern_id: "n" }], summary: summary(1, 1, 0) });
	});

	it("keeps the patterns when the run reports none", () => {
		setupLearningLoopListeners();
		state().setPatterns([pattern("kept")]);
		handlers.get("complete")?.({});
		expect(state().patterns).toEqual([pattern("kept")]);
	});

	it("shows the run's error, and can be cancelled", async () => {
		setupLearningLoopListeners();
		handlers.get("error")?.("no builds");
		expect(state()).toMatchObject({ phase: "error", error: "no builds" });
		startLearningAnalysis("/p");
		await cancelLearningAnalysis();
		expect(api.stopLearningAnalysis).toHaveBeenCalled();
		expect(state().phase).toBe("idle");
	});

	it("drops its four listeners on teardown, and registers none without the API", () => {
		const teardown = setupLearningLoopListeners();
		expect(handlers.size).toBe(4);
		teardown();
		expect(handlers.size).toBe(0);
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = {};
		setupLearningLoopListeners()();
		expect(handlers.size).toBe(0);
	});
});

describe("review lessons", () => {
	beforeEach(() => loadReviewLessons("/p"));

	it("adopts one in the person's wording and dismisses another", async () => {
		expect(await adoptReviewLesson("/p", "l1", "Always check nulls")).toBe(true);
		expect(api.adoptReviewLesson).toHaveBeenCalledWith("/p", "l1", "Always check nulls");
		expect(await dismissReviewLesson("/p", "l2")).toBe(true);
		expect(state().lessons.map((l) => l.status)).toEqual(["adopted", "dismissed"]);
		expect(await dismissReviewLesson("/p", "unknown")).toBe(true);
	});

	it("changes nothing when the main process refuses or fails", async () => {
		const before = state().lessons;
		api.adoptReviewLesson.mockResolvedValueOnce({ success: true });
		api.dismissReviewLesson.mockResolvedValueOnce({ success: false });
		expect(await adoptReviewLesson("/p", "l1", "r")).toBe(false);
		expect(await dismissReviewLesson("/p", "l1")).toBe(false);
		api.adoptReviewLesson.mockRejectedValueOnce(new Error("x"));
		api.dismissReviewLesson.mockRejectedValueOnce(new Error("x"));
		expect(await adoptReviewLesson("/p", "l1", "r")).toBe(false);
		expect(await dismissReviewLesson("/p", "l1")).toBe(false);
		expect(state().lessons).toBe(before);
	});

	it("keeps the lessons when a read fails", async () => {
		const before = state().lessons;
		api.getReviewLessons.mockResolvedValueOnce({ success: false });
		await loadReviewLessons("/p");
		api.getReviewLessons.mockRejectedValueOnce(new Error("x"));
		await loadReviewLessons("/p");
		expect(state().lessons).toBe(before);
		expect(errors).toHaveBeenCalledOnce();
	});
});
