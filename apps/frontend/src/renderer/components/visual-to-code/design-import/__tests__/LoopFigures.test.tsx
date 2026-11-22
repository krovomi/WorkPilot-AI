/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: Record<string, unknown>) =>
			vars ? `${key} ${JSON.stringify(vars)}` : key,
		i18n: { language: "en" },
	}),
}));

import type { DesignLoopStats } from "../../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
import { LoopFigures } from "../LoopFigures";

const EMPTY: DesignLoopStats = {
	loops: 0,
	converged: 0,
	averageScore: null,
	averageIterations: null,
	writes: 0,
	kept: 0,
	pending: 0,
	retouched: 0,
};

function show(stats: DesignLoopStats | null) {
	useDesignToCodeStore.setState({ loopStats: stats });
	return render(<LoopFigures />);
}

beforeEach(() => {
	useDesignToCodeStore.setState(useDesignToCodeStore.getInitialState());
});

describe("LoopFigures", () => {
	it("shows nothing before a loop or a write", () => {
		show(null);
		expect(screen.queryByTestId("design-loop-figures")).toBeNull();
		show(EMPTY);
		expect(screen.queryByTestId("design-loop-figures")).toBeNull();
	});

	it("gives the average score kept and the corrections to converge", () => {
		show({ ...EMPTY, loops: 3, converged: 2, averageScore: 0.934, averageIterations: 1.5 });
		const card = screen.getByTestId("design-loop-figures");
		expect(card).toHaveTextContent('figures.loops {"count":3,"converged":2}');
		expect(card).toHaveTextContent('figures.averageScore {"score":"93.4"}');
		expect(card).toHaveTextContent('figures.averageIterations {"value":"1.5"}');
		expect(card).not.toHaveTextContent("figures.approximation");
	});

	it("says when no loop converged", () => {
		show({ ...EMPTY, loops: 1, averageScore: 0.5 });
		expect(screen.getByText("figures.noConvergence")).toBeInTheDocument();
	});

	it("gives the writes kept as written, those still in review, and says it is approximate", () => {
		show({ ...EMPTY, writes: 4, kept: 2, pending: 1, retouched: 1 });
		const card = screen.getByTestId("design-loop-figures");
		expect(card).toHaveTextContent('figures.accepted {"kept":2,"count":3}');
		expect(card).toHaveTextContent('figures.pending {"count":1}');
		expect(card).toHaveTextContent("figures.approximation");
		expect(card).not.toHaveTextContent("figures.loops");
	});

	it("says when no write reached the project yet", () => {
		const { unmount } = show({ ...EMPTY, writes: 1, pending: 1 });
		expect(screen.getByTestId("design-loop-figures")).toHaveTextContent("figures.noneDecided");
		unmount();
		show({ ...EMPTY, writes: 1, retouched: 1 });
		const card = screen.getByTestId("design-loop-figures");
		expect(card).toHaveTextContent('figures.accepted {"kept":0,"count":1}');
		expect(card).not.toHaveTextContent("figures.pending");
	});
});
