/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
		i18n: { language: "en" },
	}),
}));

import type {
	DesignBreakpointCheck,
	DesignLoopSpend,
} from "../../../../../shared/types/design-to-code";
import { dollars, ResponsivePanel, SpendLine, StatesPanel } from "../LoopReport";

function spend(overrides: Partial<DesignLoopSpend> = {}): DesignLoopSpend {
	return {
		input_tokens: 900,
		output_tokens: 100,
		tokens: 1000,
		estimated: false,
		cost_status: "priced",
		cost_usd: 0.25,
		max_tokens: 400000,
		max_cost_usd: 2,
		cost_budget_checked: true,
		...overrides,
	};
}

function point(overrides: Partial<DesignBreakpointCheck> = {}): DesignBreakpointCheck {
	return {
		name: "mobile",
		width: 390,
		height: 844,
		compared: false,
		render_image: "data:image/png;base64,M",
		overflow_px: 0,
		overflowing: [],
		clipped: [],
		overlaps: [],
		...overrides,
	};
}

describe("dollars", () => {
	it("shows cents, or four decimals below a cent", () => {
		expect(dollars(1.5)).toBe("1.50");
		expect(dollars(0.0042)).toBe("0.0042");
	});
});

describe("SpendLine", () => {
	it("says what the tokens cost, from the catalogue only", () => {
		const { rerender } = render(<SpendLine spend={spend()} />);
		const line = () => screen.getByTestId("design-loop-spend");
		expect(line()).toHaveTextContent('loop.spend.tokens {"tokens":1000,"max":400000}');
		expect(line()).toHaveTextContent('loop.spend.cost {"cost":"0.25","max":"2.00"}');

		rerender(<SpendLine spend={spend({ estimated: true, cost_status: "flat_rate", cost_usd: 0 })} />);
		expect(line()).toHaveTextContent("loop.spend.tokensEstimated");
		expect(line()).toHaveTextContent("loop.spend.flatRate");
		expect(line()).not.toHaveTextContent("loop.spend.costUnchecked");

		rerender(
			<SpendLine spend={spend({ cost_status: "unknown", cost_usd: null, cost_budget_checked: false })} />,
		);
		expect(line()).toHaveTextContent("loop.spend.unknownCost");
		expect(line()).toHaveTextContent("loop.spend.costUnchecked");

		// A priced status without a figure is not shown as a cost.
		rerender(<SpendLine spend={spend({ cost_usd: null })} />);
		expect(line()).toHaveTextContent("loop.spend.unknownCost");
		expect(line()).not.toHaveTextContent("loop.spend.costUnchecked");
	});
});

describe("ResponsivePanel", () => {
	it("shows each width with what it found", () => {
		render(
			<ResponsivePanel
				pass={{
					status: "done",
					breakpoints: [
						point({
							overflow_px: 610,
							overflowing: ["div"],
							clipped: ['p "long"', 'p "long"'],
							overlaps: [["span a", "span b"]],
						}),
						point({
							name: "tablet",
							width: 800,
							height: 600,
							compared: true,
							score: 0.97,
							passed: true,
							issues: [
								{ region: "Top", kind: "offset", axis: "y", px: -3 },
								{ region: "Card", kind: "structure" },
							],
						}),
						point({ name: "desktop", width: 1440, height: 900 }),
					],
				}}
			/>,
		);
		const mobile = screen.getByTestId("design-breakpoint-mobile");
		expect(mobile).toHaveTextContent('loop.responsive.overflow {"px":610}');
		expect(mobile).toHaveTextContent('loop.responsive.outside {"label":"div"}');
		expect(mobile).toHaveTextContent("loop.responsive.clipped");
		expect(mobile.querySelectorAll("li")).toHaveLength(4);
		expect(mobile).toHaveTextContent('loop.responsive.overlap {"a":"span a","b":"span b"}');
		expect(mobile).toHaveTextContent("loop.responsive.notCompared");
		const tablet = screen.getByTestId("design-breakpoint-tablet");
		expect(tablet).toHaveTextContent('loop.responsive.compared {"score":"97"}');
		expect(tablet).toHaveTextContent('"px":3');
		expect(tablet).toHaveTextContent('"axis":"loop.axis.y"');
		expect(tablet).toHaveTextContent('loop.issue.structure {"region":"Card","px":0,"axis":""}');
		expect(screen.getByTestId("design-breakpoint-desktop")).toHaveTextContent("loop.responsive.clean");
	});

	it("says why it could not run", () => {
		const { rerender } = render(<ResponsivePanel pass={{ status: "failed", detail: "no_browser" }} />);
		expect(screen.getByTestId("design-loop-responsive")).toHaveTextContent("loop.reason.no_browser");
		rerender(<ResponsivePanel pass={{ status: "failed" }} />);
		expect(screen.getByTestId("design-loop-responsive")).toHaveTextContent("loop.reason.load_failed");
		rerender(<ResponsivePanel pass={{ status: "done" }} />);
		expect(screen.queryByRole("img")).toBeNull();
	});
});

describe("StatesPanel", () => {
	it("marks a state that changes nothing visible", () => {
		render(
			<StatesPanel
				pass={{
					status: "done",
					limit: 6,
					without_hover: 1,
					without_focus: 1,
					unreached: 1,
					elements: [
						{
							id: 0,
							label: 'button "Go"',
							rest_image: "data:image/png;base64,R",
							hover: { changed: true, image: "data:image/png;base64,H" },
							focus: { changed: false, image: "data:image/png;base64,F" },
						},
						{
							id: 1,
							label: "a Quiet",
							rest_image: "data:image/png;base64,R2",
							hover: { changed: false, image: "data:image/png;base64,H2" },
							focus: null,
						},
					],
				}}
			/>,
		);
		const panel = screen.getByTestId("design-loop-states");
		expect(panel).toHaveTextContent('loop.states.title {"limit":6}');
		expect(panel).toHaveTextContent('loop.states.summary {"hover":1,"focus":1,"unreached":1}');
		expect(panel).toHaveTextContent("loop.states.visible");
		expect(panel).toHaveTextContent("loop.states.none_focus");
		expect(panel).toHaveTextContent("loop.states.none_hover");
		expect(panel).toHaveTextContent("loop.states.unreached");
		expect(screen.getAllByAltText("loop.states.rest")).toHaveLength(2);
	});

	it("says when there is nothing to hover, or why the pass failed", () => {
		const { rerender } = render(<StatesPanel pass={{ status: "done" }} />);
		expect(screen.getByTestId("design-loop-states")).toHaveTextContent('loop.states.title {"limit":0}');
		expect(screen.getByTestId("design-loop-states")).toHaveTextContent("loop.states.noElements");
		rerender(<StatesPanel pass={{ status: "done", elements: [{ id: 0, label: "a", rest_image: "", hover: null, focus: null }] }} />);
		expect(screen.getByTestId("design-loop-states")).toHaveTextContent(
			'loop.states.summary {"hover":0,"focus":0,"unreached":0}',
		);
		rerender(<StatesPanel pass={{ status: "failed", detail: "load_failed" }} />);
		expect(screen.getByTestId("design-loop-states")).toHaveTextContent("loop.reason.load_failed");
		rerender(<StatesPanel pass={{ status: "failed" }} />);
		expect(screen.getByTestId("design-loop-states")).toHaveTextContent("loop.reason.load_failed");
	});
});
