/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
		i18n: { language: "en" },
	}),
}));

import type {
	DesignLoopIteration,
	DesignRenderLoop,
} from "../../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
import { IterationPanel, percent } from "../IterationPanel";

function iteration(index: number, score: number, applied_edits = 0): DesignLoopIteration {
	return {
		index,
		score,
		pixel_match: score,
		ssim: score,
		render_image: `data:image/png;base64,R${index}`,
		diff_image: `data:image/png;base64,D${index}`,
		regions: [],
		applied_edits,
		refused_edits: [],
		notes: [],
		duration_seconds: 1,
	};
}

function loop(overrides: Partial<DesignRenderLoop> = {}): DesignRenderLoop {
	return {
		status: "converged",
		threshold: 0.95,
		mirror: false,
		best_iteration: 1,
		iterations: [iteration(0, 0.8163), iteration(1, 0.9512, 2), iteration(2, 0.9, 0)],
		issues: [],
		...overrides,
	};
}

const renderImage = () => screen.getByAltText("loop.render").getAttribute("src");

beforeEach(() => {
	useDesignToCodeStore.setState({ ...useDesignToCodeStore.getInitialState(), notes: {} });
});

describe("percent", () => {
	it("reads a 0..1 score as a percentage with one decimal", () => {
		expect(percent(0.95123)).toBe("95.1");
		expect(percent(null)).toBe("0");
		expect(percent(undefined)).toBe("0");
	});
});

describe("IterationPanel", () => {
	it("says why the loop did not run", () => {
		const { rerender } = render(
			<IterationPanel
				loop={loop({ status: "skipped", reason: "model_without_vision", provider: "ollama", model: "m", detail: "d" })}
			/>,
		);
		expect(screen.getByTestId("design-loop-skipped")).toHaveTextContent(
			'loop.reason.model_without_vision {"provider":"ollama","model":"m","detail":"d"}',
		);

		rerender(<IterationPanel loop={loop({ status: "skipped" })} />);
		expect(screen.getByTestId("design-loop-skipped")).toHaveTextContent(
			'loop.reason.load_failed {"provider":"—","model":"—","detail":""}',
		);
	});

	it("shows the iteration kept, then the one the person picks", () => {
		useDesignToCodeStore.setState({ imagePreview: "data:image/png;base64,T" });
		render(<IterationPanel loop={loop()} />);

		expect(screen.getByText('loop.status.converged {"score":"95.1"}')).toBeInTheDocument();
		expect(screen.getByAltText("loop.target")).toHaveAttribute("src", "data:image/png;base64,T");
		expect(renderImage()).toBe("data:image/png;base64,R1");
		expect(screen.getByAltText("loop.diff")).toHaveAttribute("src", "data:image/png;base64,D1");
		expect(screen.getByText('loop.edits {"count":2}')).toBeInTheDocument();
		expect(screen.getByTestId("design-loop-iteration-1")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("design-loop-iteration-0")).toHaveTextContent("loop.generated");
		expect(screen.getByTestId("design-loop-iteration-1")).toHaveTextContent("loop.kept");
		expect(screen.getByText("loop.noIssues")).toBeInTheDocument();
		expect(screen.queryByText("loop.mirror")).toBeNull();

		fireEvent.click(screen.getByTestId("design-loop-iteration-2"));
		expect(useDesignToCodeStore.getState().selectedIteration).toBe(2);
		expect(renderImage()).toBe("data:image/png;base64,R2");
		expect(screen.getByText("loop.noEdits")).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("design-loop-iteration-0"));
		expect(renderImage()).toBe("data:image/png;base64,R0");
		expect(screen.queryByText("loop.noEdits")).toBeNull();
	});

	it("falls back to the first iteration, and to nothing without any", () => {
		const { rerender } = render(<IterationPanel loop={loop({ best_iteration: 9 })} />);
		expect(renderImage()).toBe("data:image/png;base64,R0");
		expect(screen.queryByAltText("loop.target")).toBeNull();

		rerender(<IterationPanel loop={loop({ status: "failed", iterations: [], detail: "load_failed" })} />);
		expect(screen.queryByAltText("loop.render")).toBeNull();
		expect(screen.getByText('loop.status.failed {"score":"0"}')).toBeInTheDocument();
		expect(screen.getByText("load_failed")).toBeInTheDocument();

		rerender(<IterationPanel loop={loop({ status: "failed", iterations: [] })} />);
		expect(screen.queryByText("load_failed")).toBeNull();
	});

	it("notes the mirror, the missing fonts and the masked zones", () => {
		render(<IterationPanel loop={loop({ mirror: true, missing_fonts: ["Inter", "Roboto"], masked: ["Avatar"] })} />);
		expect(screen.getByText("loop.mirror")).toBeInTheDocument();
		expect(screen.getByText('loop.missingFonts {"fonts":"Inter, Roboto"}')).toBeInTheDocument();
		expect(screen.getByText('loop.masked {"zones":"Avatar"}')).toBeInTheDocument();
		expect(screen.queryByText(/loop\.drawnMasks/)).toBeNull();
	});

	it("counts the zones drawn on the design and shows the fix from the passes", () => {
		render(<IterationPanel loop={loop({ drawn_masks: 2, pass_fix: { status: "nothing_to_fix", before: 0 } })} />);
		expect(screen.getByText('loop.drawnMasks {"count":2}')).toBeInTheDocument();
		expect(screen.getByTestId("design-loop-pass-fix")).toHaveAttribute("data-status", "nothing_to_fix");
	});

	it("names the budget that stopped the loop, and what it spent", () => {
		const spend = {
			input_tokens: 9,
			output_tokens: 1,
			tokens: 10,
			estimated: false,
			cost_status: "priced" as const,
			cost_usd: 0.004,
			max_tokens: 100,
			max_cost_usd: 2,
			cost_budget_checked: true,
		};
		const { rerender } = render(<IterationPanel loop={loop({ status: "budget", budget_kind: "tokens", spend })} />);
		expect(screen.getByText('loop.status.budget_tokens {"score":"95.1"}')).toBeInTheDocument();
		expect(screen.getByTestId("design-loop-spend")).toHaveTextContent('loop.spend.cost {"cost":"0.0040","max":"2.00"}');

		rerender(<IterationPanel loop={loop({ status: "budget", budget_kind: "cost" })} />);
		expect(screen.getByText('loop.status.budget_cost {"score":"95.1"}')).toBeInTheDocument();
		expect(screen.queryByTestId("design-loop-spend")).toBeNull();

		rerender(<IterationPanel loop={loop({ status: "budget", budget_kind: "time" })} />);
		expect(screen.getByText('loop.status.budget {"score":"95.1"}')).toBeInTheDocument();
	});

	it("shows the passes asked for under the differences", () => {
		const { rerender } = render(<IterationPanel loop={loop()} />);
		expect(screen.queryByTestId("design-loop-responsive")).toBeNull();
		expect(screen.queryByTestId("design-loop-states")).toBeNull();
		rerender(
			<IterationPanel
				loop={loop({ responsive: { status: "failed", detail: "no_browser" }, states: { status: "done", elements: [] } })}
			/>,
		);
		expect(screen.getByTestId("design-loop-responsive")).toBeInTheDocument();
		expect(screen.getByTestId("design-loop-states")).toBeInTheDocument();
	});

	it("lists every difference with what became of it", () => {
		render(
			<IterationPanel
				loop={loop({
					status: "max_iterations",
					missing_fonts: [],
					masked: [],
					issues: [
						{ id: "a", region: "Header", kind: "color", target: "#e63946", render: "#f08030", status: "resolved", first_seen: 0, last_seen: 0, resolved_at: 1 },
						{ id: "b", region: "Card", kind: "offset", axis: "y", px: -12, status: "abandoned", first_seen: 0, last_seen: 2 },
					],
				})}
			/>,
		);
		const lines = screen.getByTestId("design-loop-issues").querySelectorAll("li");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toHaveAttribute("data-status", "resolved");
		expect(lines[0]).toHaveTextContent('"px":0');
		expect(lines[0]).toHaveTextContent('"axis":""');
		expect(lines[1]).toHaveTextContent("loop.issueStatus.abandoned");
		expect(lines[1]).toHaveTextContent('"px":12');
		expect(lines[1]).toHaveTextContent('"axis":"loop.axis.y"');
		expect(screen.queryByText(/loop\.missingFonts/)).toBeNull();
		expect(screen.queryByText(/loop\.masked/)).toBeNull();
	});
});
