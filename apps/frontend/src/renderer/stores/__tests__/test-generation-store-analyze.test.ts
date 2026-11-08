/**
 * A coverage analysis has to land somewhere the studio reads. The old dialog
 * read `result.coverage_gaps`, which the store never set, so an analysis ran
 * and showed nothing. These pin that the gaps reach `coverageGaps`, that the
 * run is tagged as an analysis, and that the stages it reports are followed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-store", () => ({
	useProjectStore: {
		getState: () => ({ getActiveProject: () => ({ path: "/proj" }) }),
	},
}));

import { useTestGenerationStore } from "../test-generation-store";

type Listener = (data: never) => void;

const initial = useTestGenerationStore.getState();
let listeners: Record<string, Listener>;
let analyze: ReturnType<typeof vi.fn>;

beforeEach(() => {
	useTestGenerationStore.setState(initial, true);
	listeners = {};
	analyze = vi.fn();
	const on = (name: string) => (cb: Listener) => {
		listeners[name] = cb;
	};
	globalThis.electronAPI = {
		onTestGenerationStatus: on("status"),
		onTestGenerationResult: on("result"),
		onTestGenerationError: on("error"),
		onTestGenerationProgress: on("progress"),
		removeTestGenerationStatusListener: vi.fn(),
		removeTestGenerationResultListener: vi.fn(),
		removeTestGenerationErrorListener: vi.fn(),
		removeTestGenerationProgressListener: vi.fn(),
		analyzeTestCoverage: analyze,
	} as never;
});

describe("analyzeCoverage", () => {
	it("stores the gaps and tags the run as an analysis", async () => {
		const run = useTestGenerationStore.getState().analyzeCoverage("/proj/src/cart.cs");
		expect(analyze).toHaveBeenCalledWith("/proj/src/cart.cs", undefined, "/proj");
		expect(useTestGenerationStore.getState()).toMatchObject({
			runKind: "analyze",
			phase: "analyzing",
			isLiveRun: false,
		});

		listeners.progress({ type: "stage", stage: "analyze", status: "active" } as never);
		expect(
			useTestGenerationStore.getState().liveStages.find((s) => s.id === "analyze")?.status,
		).toBe("active");

		const gaps = [
			{ function_name: "Total", line_number: 12, reason: "untested", priority: "high" },
		];
		listeners.result({ gaps } as never);

		await expect(run).resolves.toEqual(gaps);
		expect(useTestGenerationStore.getState()).toMatchObject({
			coverageGaps: gaps,
			phase: "complete",
		});
	});

	it("forgets an earlier analysis's gaps when a generation starts", () => {
		useTestGenerationStore.setState({ coverageGaps: [], result: null });
		useTestGenerationStore.getState().resetLive();
		expect(useTestGenerationStore.getState().coverageGaps).toBeNull();
	});
});
