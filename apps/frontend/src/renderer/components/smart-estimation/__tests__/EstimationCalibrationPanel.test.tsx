/**
 * The calibration panel of Smart Estimation (issue #367): ranges, red flags,
 * dimensions, providers, accuracy of past estimates, and the two writes
 * ("Adjust estimate", "Reset calibration") with their outcomes.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CalibratedMetric,
	EstimationCalibration,
	SmartEstimationResult,
} from "../../../../shared/types/smart-estimation";
import { formatMetric, percent } from "../calibration-format";
import { EstimationCalibrationPanel } from "../EstimationCalibrationPanel";
import { calibrationInputs, taskEstimateFrom } from "../task-estimate";

const persistUpdateTask = vi.fn();
vi.mock("../../../stores/task-store", () => ({
	persistUpdateTask: (...args: unknown[]) => persistUpdateTask(...args),
}));

const adjustSmartEstimate = vi.fn();
const resetEstimationCalibration = vi.fn();

function metric(overrides: Partial<CalibratedMetric> = {}): CalibratedMetric {
	return {
		base: 2,
		value: 4,
		low: 3,
		high: 5,
		factor: 2,
		scope: "category",
		samples: 6,
		outliers: 0,
		confidence: 0.72,
		...overrides,
	};
}

const GENERIC: CalibratedMetric = metric({
	value: 2,
	low: null,
	high: null,
	factor: 1,
	scope: "none",
	samples: 0,
	confidence: null,
});

function calibration(overrides: Partial<EstimationCalibration> = {}): EstimationCalibration {
	return {
		status: "calibrated",
		category: "backend",
		samples: 6,
		min_samples: 5,
		reset_at: null,
		metrics: {
			cost_usd: metric(),
			tokens: metric({ base: 40_000, value: 30_000, low: 20_000, high: 50_000, factor: 0.6 }),
			qa_iterations: GENERIC,
			files: metric({ base: null, value: null }),
		},
		complexity: { base: 7, value: 7, bias: 0, scope: "none", adjustments: 0 },
		red_flags: [
			{ metric: "cost_usd", factor: 2, scope: "category" },
			{ metric: "tokens", factor: 0.6, scope: "repo" },
		],
		providers: [
			{ provider: "openai", samples: 3, cost_ratio: 1.5, tokens_ratio: null },
			{ provider: "anthropic", samples: 2, cost_ratio: null, tokens_ratio: 0.8 },
		],
		quality: {
			mape: { cost_usd: 0.25, tokens: null, qa_iterations: null, files: null },
			acceptance_rate: 0.5,
			mean_interval_width: 0.4,
			outliers_excluded: 0,
		},
		...overrides,
	};
}

function result(overrides: Partial<SmartEstimationResult> = {}): SmartEstimationResult {
	return {
		complexity_score: 7,
		confidence_level: 0.6,
		reasoning: "",
		similar_tasks: [],
		risk_factors: ["schema"],
		estimated_qa_iterations: 2,
		recommendations: [],
		category: "backend",
		dimensions: [
			{ key: "algorithmic", level: "low", signals: [], uncertain: true },
			{ key: "integration", level: "high", signals: ["api"], uncertain: false },
		],
		calibration: calibration(),
		...overrides,
	} as SmartEstimationResult;
}

function renderPanel(
	props: Partial<{ result: SmartEstimationResult; projectId: string | null; sourceTaskId: string | null }> = {},
) {
	return render(
		<EstimationCalibrationPanel
			result={props.result ?? result()}
			projectId={props.projectId === undefined ? "p1" : props.projectId}
			sourceTaskId={props.sourceTaskId === undefined ? "t1" : props.sourceTaskId}
		/>,
	);
}

beforeEach(() => {
	persistUpdateTask.mockReset();
	adjustSmartEstimate.mockReset().mockResolvedValue({ samples: 6, adjustments: 1, reset_at: null });
	resetEstimationCalibration.mockReset().mockResolvedValue({ samples: 0, adjustments: 0, reset_at: "now" });
	Object.assign(window, {
		electronAPI: { ...(window as unknown as { electronAPI: object }).electronAPI, adjustSmartEstimate, resetEstimationCalibration },
	});
});

describe("EstimationCalibrationPanel", () => {
	it("renders nothing for a result without calibration", () => {
		const { container } = renderPanel({ result: result({ calibration: undefined }) });
		expect(container).toBeEmptyDOMElement();
	});

	it("shows each calibrated range, the red flags, dimensions, providers and accuracy", () => {
		renderPanel();
		expect(screen.getByText(/Calibrated on 6 merged specs/)).toBeInTheDocument();
		expect(screen.getAllByText(/confidence 72%/)).toHaveLength(2);
		// A metric without a calibrated value is left out; a generic one has no range.
		expect(screen.queryByText("Files changed")).not.toBeInTheDocument();
		expect(screen.getByText("QA iterations")).toBeInTheDocument();
		expect(screen.getByText("generic")).toBeInTheDocument();
		expect(screen.getByText(/used more than estimated, ×2.00 applied/)).toBeInTheDocument();
		expect(screen.getByText(/used less than estimated, ×0.60 applied/)).toBeInTheDocument();
		expect(screen.getByText("uncertain")).toBeInTheDocument();
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.getByText(/openai: cost ×1.50, tokens ×— /)).toBeInTheDocument();
		expect(screen.getByText(/anthropic: cost ×—, tokens ×0.80/)).toBeInTheDocument();
		expect(screen.getByText("Cost: 25% mean error")).toBeInTheDocument();
		expect(screen.getByText("50% of estimates kept without adjustment")).toBeInTheDocument();
		expect(screen.getByText(/Ranges span 40%/)).toBeInTheDocument();
	});

	it("says when the repository has too little history, without flags or accuracy", () => {
		renderPanel({
			result: result({
				dimensions: undefined,
				calibration: calibration({
					status: "insufficient_history",
					samples: 2,
					red_flags: [],
					providers: [],
					quality: {
						mape: { cost_usd: null, tokens: null, qa_iterations: null, files: null },
						acceptance_rate: null,
						mean_interval_width: null,
						outliers_excluded: 0,
					},
				}),
			}),
		});
		expect(screen.getByText(/2 merged specs, 5 needed/)).toBeInTheDocument();
		expect(screen.queryByText("Breakdown by dimension")).not.toBeInTheDocument();
		expect(screen.queryByText("By provider on this repository")).not.toBeInTheDocument();
		expect(screen.queryByText("Accuracy of past estimates")).not.toBeInTheDocument();
	});

	it("shows accuracy lines independently of one another", () => {
		renderPanel({
			result: result({
				calibration: calibration({
					quality: {
						mape: { cost_usd: 0.1, tokens: null, qa_iterations: null, files: null },
						acceptance_rate: null,
						mean_interval_width: null,
						outliers_excluded: 0,
					},
				}),
			}),
		});
		expect(screen.getByText("Cost: 10% mean error")).toBeInTheDocument();
		expect(screen.queryByText(/kept without adjustment/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Ranges span/)).not.toBeInTheDocument();
	});

	it("keeps the person's score in the calibration and on the task", async () => {
		renderPanel();
		fireEvent.change(screen.getByLabelText("Your complexity score (1-13)"), {
			target: { value: "9" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Adjust estimate" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Score 9 kept");
		expect(adjustSmartEstimate).toHaveBeenCalledWith({
			projectId: "p1",
			category: "backend",
			baseScore: 7,
			adjustedScore: 9,
		});
		const update = persistUpdateTask.mock.calls[0];
		expect(update[0]).toBe("t1");
		expect(update[1].metadata.smartEstimate).toMatchObject({
			complexityScore: 9,
			adjustedScore: 9,
			category: "backend",
		});
	});

	it("does not touch a task when the run came from no task", async () => {
		renderPanel({ sourceTaskId: null });
		fireEvent.click(screen.getByRole("button", { name: "Adjust estimate" }));
		await screen.findByRole("status");
		expect(persistUpdateTask).not.toHaveBeenCalled();
	});

	it("refuses a score off 1-13 and a missing project", () => {
		const { unmount } = renderPanel();
		fireEvent.change(screen.getByLabelText("Your complexity score (1-13)"), {
			target: { value: "14" },
		});
		expect(screen.getByRole("button", { name: "Adjust estimate" })).toBeDisabled();
		unmount();
		renderPanel({ projectId: null });
		expect(screen.getByRole("button", { name: "Adjust estimate" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Reset calibration" })).toBeDisabled();
	});

	it("shows the error of a refused write, whatever was thrown", async () => {
		adjustSmartEstimate.mockRejectedValueOnce(new Error("Unknown project"));
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Adjust estimate" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown project");

		resetEstimationCalibration.mockRejectedValueOnce("disk full");
		fireEvent.click(screen.getByRole("button", { name: "Reset calibration" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
	});

	it("asks before a reset, can be cancelled, then resets", async () => {
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Reset calibration" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(resetEstimationCalibration).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Reset calibration" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Calibration reset");
		expect(resetEstimationCalibration).toHaveBeenCalledWith("p1");
	});
});

describe("task estimate and number formats", () => {
	it("keeps only the metrics with both figures, and nothing without calibration", () => {
		expect(calibrationInputs(result({ calibration: undefined }))).toBeUndefined();
		expect(calibrationInputs(result())).toEqual({
			cost_usd: { base: 2, value: 4 },
			tokens: { base: 40_000, value: 30_000 },
			qa_iterations: { base: 2, value: 2 },
		});
		const kept = taskEstimateFrom(result(), "2026-11-15T00:00:00.000Z");
		expect(kept).toMatchObject({ complexityScore: 7, at: "2026-11-15T00:00:00.000Z" });
		expect(typeof taskEstimateFrom(result()).at).toBe("string");
	});

	it("formats cost, tokens and counts, and ratios as percentages", () => {
		expect(formatMetric("cost_usd", 1.5, "en")).toBe("$1.50");
		expect(formatMetric("tokens", 40_000, "en")).toBe("40K");
		expect(formatMetric("files", 2.25, "en")).toBe("2.3");
		expect(percent(0.724)).toBe(72);
	});
});
