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

import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
import { LoopOptions } from "../LoopOptions";

beforeEach(() => {
	useDesignToCodeStore.setState({ ...useDesignToCodeStore.getInitialState(), notes: {} });
});

describe("LoopOptions", () => {
	it("offers the bounded choices and keeps what the person picks", () => {
		render(<LoopOptions disabled={false} />);
		const button = screen.getByTestId("design-loop-options");
		expect(button).toHaveTextContent('loopOptions.summary {"iterations":5,"threshold":"95"}');
		expect(screen.queryByRole("dialog")).toBeNull();

		fireEvent.click(button);
		expect(button).toHaveAttribute("aria-expanded", "true");
		const iterations = screen.getByTestId("design-loop-maxIterations") as HTMLSelectElement;
		expect(iterations.options).toHaveLength(10);
		expect(iterations.options[0]).toHaveTextContent('loopOptions.iterationsValue {"count":1}');
		expect(screen.getByTestId("design-loop-threshold")).toHaveTextContent('loop.score {"score":"80"}');
		expect(screen.getByTestId("design-loop-maxTokens")).toHaveTextContent('loopOptions.tokensValue {"value":400}');
		expect(screen.getByTestId("design-loop-maxCostUsd")).toHaveTextContent('loopOptions.costValue {"value":0.5}');

		fireEvent.change(iterations, { target: { value: "3" } });
		fireEvent.change(screen.getByTestId("design-loop-threshold"), { target: { value: "0.9" } });
		fireEvent.change(screen.getByTestId("design-loop-maxTokens"), { target: { value: "800000" } });
		fireEvent.change(screen.getByTestId("design-loop-maxCostUsd"), { target: { value: "5" } });
		// Without a pass there is nothing to fix from.
		expect(screen.getByTestId("design-loop-fixPasses")).toBeDisabled();
		fireEvent.click(screen.getByTestId("design-loop-responsive"));
		fireEvent.click(screen.getByTestId("design-loop-states"));
		expect(screen.getByTestId("design-loop-fixPasses")).toBeEnabled();
		fireEvent.click(screen.getByTestId("design-loop-fixPasses"));
		expect(useDesignToCodeStore.getState().loopOptions).toEqual({
			maxIterations: 3,
			threshold: 0.9,
			maxTokens: 800_000,
			maxCostUsd: 5,
			responsive: true,
			states: true,
			fixPasses: true,
			masks: [],
		});

		// A click inside keeps it open, a click outside closes it.
		fireEvent.mouseDown(screen.getByRole("dialog"));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.click(button);
		fireEvent.click(button);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("is closed while a run goes on", () => {
		render(<LoopOptions disabled />);
		expect(screen.getByTestId("design-loop-options")).toBeDisabled();
	});
});
