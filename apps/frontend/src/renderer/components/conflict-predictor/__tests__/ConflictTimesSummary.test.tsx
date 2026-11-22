/**
 * Resolution time of residual merge conflicts (#358, lot 4): the median of
 * measured times over the sprint window, the conflicts still open, and a
 * file that could not be read.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MergeConflictTime } from "../../../../shared/types/conflict-waves";
import { ConflictTimesSummary, conflictTimesFigures, median } from "../ConflictTimesSummary";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function resolved(at: string, hours: number): MergeConflictTime {
	const end = Date.parse(at);
	return { taskId: "t", detectedAt: new Date(end - hours * HOUR).toISOString(), resolvedAt: new Date(end).toISOString() };
}

const OPEN: MergeConflictTime = { taskId: "o", detectedAt: "2026-09-01T10:00:00.000Z", resolvedAt: null };

describe("median", () => {
	it("takes the middle value, or the mean of the two middle ones, and none of nothing", () => {
		expect(median([])).toBeNull();
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});

describe("conflictTimesFigures", () => {
	it("times the conflicts resolved in the last 14 days, and counts every open one", () => {
		const figures = conflictTimesFigures(
			{
				entries: [
					resolved("2026-11-19T10:00:00.000Z", 1),
					resolved("2026-11-12T10:00:00.000Z", 3),
					resolved("2026-11-10T10:00:00.000Z", 2),
					resolved("2026-10-01T10:00:00.000Z", 50),
					OPEN,
				],
				ignored: false,
			},
			NOW,
		);
		expect(figures).toEqual({ resolved: 3, medianMs: 2 * HOUR, open: 1 });
	});
});

describe("ConflictTimesSummary", () => {
	it("shows the median time to resolve and the conflicts still open", () => {
		render(
			<ConflictTimesSummary
				now={NOW}
				times={{
					entries: [resolved("2026-11-19T10:00:00.000Z", 1), resolved("2026-11-18T10:00:00.000Z", 2), OPEN, OPEN],
					ignored: false,
				}}
			/>,
		);
		const text = screen.getByTestId("merge-conflict-times").textContent ?? "";
		expect(text).toContain("Last 14 days: 2 merge conflicts resolved, median");
		expect(text).toContain("from the conflict to the merge.");
		expect(text).toContain("2 conflicts still open.");
	});

	it("speaks of one conflict, and of none resolved while one is open", () => {
		const { unmount } = render(
			<ConflictTimesSummary now={NOW} times={{ entries: [resolved("2026-11-19T10:00:00.000Z", 1)], ignored: false }} />,
		);
		expect(screen.getByTestId("merge-conflict-times")).toHaveTextContent(
			"Last 14 days: 1 merge conflict resolved, in 1 hr from the conflict to the merge.",
		);
		unmount();
		render(<ConflictTimesSummary now={NOW} times={{ entries: [OPEN], ignored: false }} />);
		expect(screen.getByTestId("merge-conflict-times")).toHaveTextContent(
			"Last 14 days: no merge conflict resolved. 1 conflict still open.",
		);
	});

	it("shows nothing without a conflict, and says when the file was ignored", () => {
		const { container } = render(
			<ConflictTimesSummary now={NOW} times={{ entries: [resolved("2026-10-01T10:00:00.000Z", 1)], ignored: false }} />,
		);
		expect(container).toBeEmptyDOMElement();
		render(<ConflictTimesSummary times={{ entries: [], ignored: true }} />);
		expect(screen.getByText(/could not be read/)).toBeInTheDocument();
	});
});
