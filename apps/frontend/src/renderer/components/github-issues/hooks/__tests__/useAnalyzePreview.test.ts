/**
 * The issue analysis wizard: it follows the preview analysis of this project
 * only, and an approved batch becomes one task that links its issues.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAnalyzePreview } from "../useAnalyzePreview";

const createTask = vi.hoisted(() => vi.fn());
vi.mock("../../../../stores/task-store", () => ({ createTask }));

type Handler = (...args: unknown[]) => void;
let handlers: Record<string, Handler>;
let cleanups: Array<ReturnType<typeof vi.fn>>;
let github: Record<string, ReturnType<typeof vi.fn>>;

function listener(name: string) {
	return vi.fn((handler: Handler) => {
		handlers[name] = handler;
		const cleanup = vi.fn();
		cleanups.push(cleanup);
		return cleanup;
	});
}

beforeEach(() => {
	handlers = {};
	cleanups = [];
	createTask.mockReset().mockResolvedValue({ id: "t" });
	github = {
		onAnalyzePreviewProgress: listener("progress"),
		onAnalyzePreviewComplete: listener("complete"),
		onAnalyzePreviewError: listener("error"),
		analyzeIssuesPreview: vi.fn(),
		approveBatches: vi.fn().mockResolvedValue({ success: true }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = { github };
});

const issue = (issueNumber: number, title: string) => ({ issueNumber, title });
const batch = (issues: ReturnType<typeof issue>[], extra: Record<string, unknown> = {}) =>
	({ issues, theme: "", commonThemes: [], reasoning: "same module", ...extra }) as never;

describe("analysis", () => {
	it("runs the analysis of this project and follows it to its result", () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		act(() => result.current.openWizard());
		act(() => result.current.startAnalysis());
		expect(github.analyzeIssuesPreview).toHaveBeenCalledWith("p1", undefined, 200);
		expect(result.current).toMatchObject({ isWizardOpen: true, isAnalyzing: true });

		act(() => handlers.progress("other", { progress: 99 }));
		act(() => handlers.progress("p1", { progress: 30 }));
		expect(result.current.analysisProgress).toEqual({ progress: 30 });

		act(() => handlers.complete("other", { batches: [] }));
		expect(result.current.isAnalyzing).toBe(true);
		act(() => handlers.complete("p1", { batches: [1] }));
		expect(result.current).toMatchObject({ isAnalyzing: false, analysisResult: { batches: [1] }, analysisError: null });
	});

	it("shows an analysis error of this project only", () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		act(() => result.current.startAnalysis());
		act(() => handlers.error("other", { error: "no" }));
		expect(result.current.analysisError).toBeNull();
		act(() => handlers.error("p1", { error: "rate limited" }));
		expect(result.current).toMatchObject({ isAnalyzing: false, analysisError: "rate limited" });
	});

	it("starts clean each time the wizard opens or closes", () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		act(() => result.current.startAnalysis());
		act(() => handlers.error("p1", { error: "x" }));
		act(() => result.current.openWizard());
		expect(result.current.analysisError).toBeNull();
		act(() => result.current.startAnalysis());
		act(() => result.current.closeWizard());
		expect(result.current).toMatchObject({ isWizardOpen: false, isAnalyzing: false, analysisProgress: null });
	});

	it("listens to nothing and starts nothing without a project, and unsubscribes on unmount", async () => {
		const none = renderHook(() => useAnalyzePreview({ projectId: "" }));
		act(() => none.result.current.startAnalysis());
		await none.result.current.approveBatches([batch([issue(1, "a")])]);
		expect(github.onAnalyzePreviewProgress).not.toHaveBeenCalled();
		expect(github.analyzeIssuesPreview).not.toHaveBeenCalled();
		expect(github.approveBatches).not.toHaveBeenCalled();

		const { unmount } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		unmount();
		expect(cleanups).toHaveLength(3);
		for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
	});
});

describe("approving batches", () => {
	it("makes a task for one issue", async () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		const one = batch([issue(5, "Crash on save")]);
		await act(() => result.current.approveBatches([one]));
		expect(github.approveBatches).toHaveBeenCalledWith("p1", [one]);
		expect(createTask).toHaveBeenCalledWith("p1", "GitHub Issue #5: Crash on save", "Crash on save", {
			sourceType: "github",
			githubIssueNumbers: [5],
			githubIssueNumber: 5,
			githubBatchTheme: "",
		});
		expect(result.current.isApproving).toBe(false);
	});

	it("makes one task per batch of several issues, named by its theme", async () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		const themed = batch([issue(1, "A"), issue(2, "B")], { theme: "Auth", commonThemes: ["login", "token"] });
		const plain = batch([issue(3, "C"), issue(4, "D")]);
		await act(() => result.current.approveBatches([themed, plain]));

		expect(createTask.mock.calls[0]).toEqual([
			"p1",
			"Auth",
			"**Issues in this batch:**\n- #1: A\n- #2: B\n\n**Common themes:** login, token\n\n**Reasoning:** same module",
			{ sourceType: "github", githubIssueNumbers: [1, 2], githubIssueNumber: undefined, githubBatchTheme: "Auth" },
		]);
		expect(createTask.mock.calls[1][1]).toBe("GitHub Issues: #3, #4");
		expect(createTask.mock.calls[1][2]).toContain("**Common themes:** N/A");
	});

	it("approves nothing for an empty selection", async () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		await result.current.approveBatches([]);
		expect(github.approveBatches).not.toHaveBeenCalled();
	});

	it("makes no task when the approval is refused, and says why", async () => {
		const { result } = renderHook(() => useAnalyzePreview({ projectId: "p1" }));
		github.approveBatches.mockResolvedValueOnce({ success: false, error: "stale analysis" });
		await act(() => expect(result.current.approveBatches([batch([issue(1, "a")])])).rejects.toThrow("stale analysis"));
		expect(result.current).toMatchObject({ analysisError: "stale analysis", isApproving: false });
		expect(createTask).not.toHaveBeenCalled();

		github.approveBatches.mockResolvedValueOnce({ success: false });
		await act(() => expect(result.current.approveBatches([batch([issue(1, "a")])])).rejects.toThrow());
		expect(result.current.analysisError).toBe("Failed to approve batches");

		github.approveBatches.mockRejectedValueOnce("x");
		await act(() => expect(result.current.approveBatches([batch([issue(1, "a")])])).rejects.toBe("x"));
		expect(result.current.analysisError).toBe("Failed to approve batches");
	});
});
