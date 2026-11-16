/**
 * The PR list: one row per PR with its review status and when it last
 * moved, in the app's language; the empty, loading and error states; and
 * the next page.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { PRData } from "../../hooks/useGitHubPRs";
import type { PRReviewInfo } from "../../utils/pr-review-status";
import { PRList } from "../PRList";

const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pr = (number: number, updatedAt: string, title = `PR ${number}`) =>
	({
		number,
		title,
		author: { login: "ana" },
		headRefName: `feature-${number}`,
		additions: 12,
		deletions: 3,
		updatedAt,
	}) as PRData;

function renderList(props: Partial<React.ComponentProps<typeof PRList>> = {}) {
	const handlers = { onSelectPR: vi.fn(), onLoadMore: vi.fn() };
	const view = render(
		<PRList
			prs={[]}
			selectedPRNumber={null}
			isLoading={false}
			hasMore={false}
			error={null}
			getReviewStateForPR={() => null}
			isLoadingMore={false}
			isFiltered={false}
			{...handlers}
			{...props}
		/>,
	);
	return { ...handlers, ...view };
}

describe("PRList", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(async () => {
		vi.useRealTimers();
		await i18n.changeLanguage("en");
	});

	it("says it is loading, or why the PRs could not be read", () => {
		const { rerender } = renderList({ isLoading: true });
		expect(screen.getByText("Loading pull requests...")).toBeInTheDocument();
		rerender(
			<PRList
				prs={[]}
				selectedPRNumber={null}
				isLoading={false}
				hasMore={false}
				error="gh: not logged in"
				getReviewStateForPR={() => null}
				onSelectPR={vi.fn()}
				onLoadMore={vi.fn()}
				isLoadingMore={false}
				isFiltered={false}
			/>,
		);
		expect(screen.getByText("gh: not logged in")).toBeInTheDocument();
	});

	it("tells an empty repository from a filter that hides every PR", () => {
		const { unmount } = renderList();
		expect(screen.getByText("No open pull requests")).toBeInTheDocument();
		unmount();
		renderList({ isFiltered: true });
		expect(screen.getByText("No results found")).toBeInTheDocument();
		expect(screen.queryByText("No open pull requests")).toBeNull();
	});

	it("keeps the rows while a refresh loads", () => {
		renderList({ isLoading: true, prs: [pr(1, ago(MIN))] });
		expect(screen.getByText("PR 1")).toBeInTheDocument();
		expect(screen.queryByText("Loading pull requests...")).toBeNull();
	});

	it("shows each PR and opens the one clicked", async () => {
		vi.useRealTimers();
		const { onSelectPR } = renderList({
			prs: [pr(4, new Date().toISOString(), "Fix login")],
			selectedPRNumber: 4,
		});
		const row = screen.getByRole("button", { name: /Fix login/ });
		expect(within(row).getByText("#4")).toBeInTheDocument();
		expect(within(row).getByText("feature-4")).toBeInTheDocument();
		expect(within(row).getByText("ana")).toBeInTheDocument();
		expect(within(row).getByText("+12")).toBeInTheDocument();
		expect(within(row).getByText("-3")).toBeInTheDocument();
		expect(row.className).toContain("bg-accent");
		await userEvent.click(row);
		expect(onSelectPR).toHaveBeenCalledWith(4);
	});

	it("says when each PR last moved, in the app's language", async () => {
		const prs = [
			pr(1, ago(5 * MIN)),
			pr(2, ago(3 * HOUR)),
			pr(3, ago(DAY + HOUR)),
			pr(4, ago(3 * DAY)),
			pr(5, ago(15 * DAY)),
			pr(6, "2026-09-01T12:00:00Z"),
			// A clock a little ahead of this one.
			pr(7, new Date(NOW.getTime() + 2 * MIN).toISOString()),
		];
		const { unmount } = renderList({ prs });
		for (const text of ["5m ago", "3h ago", "Yesterday", "3d ago", "2w ago", "9/1/2026", "0m ago"]) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
		unmount();

		await i18n.changeLanguage("fr");
		renderList({ prs });
		for (const text of ["il y a 5 min", "il y a 3 h", "Hier", "il y a 3 j", "il y a 2 sem.", "01/09/2026"]) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
	});

	it("shows where each review stands", () => {
		const states: Record<number, PRReviewInfo> = {
			2: { isReviewing: true, result: null },
			3: { isReviewing: false, result: { findings: [], overallStatus: "comment" } as never },
			4: { isReviewing: false, result: { findings: [], reviewId: 9, overallStatus: "approve" } as never },
			5: {
				isReviewing: false,
				result: { findings: [], reviewId: 9, overallStatus: "request_changes" } as never,
			},
			6: {
				isReviewing: false,
				result: { findings: [], postedFindingIds: ["a"], overallStatus: "comment" } as never,
				newCommitsCheck: { hasNewCommits: true, hasCommitsAfterPosting: true } as never,
			},
		};
		renderList({
			prs: [1, 2, 3, 4, 5, 6].map((n) => pr(n, ago(MIN), `Title ${n}`)),
			getReviewStateForPR: (n) => states[n] ?? null,
		});
		const row = (n: number) => screen.getByRole("button", { name: new RegExp(`Title ${n}`) });
		expect(row(1).textContent).not.toMatch(/Review|Pending|Ready|Changes/);
		expect(within(row(2)).getByText("Reviewing")).toBeInTheDocument();
		expect(within(row(3)).getByText("Pending Post")).toBeInTheDocument();
		expect(within(row(4)).getByText("Ready to Merge")).toBeInTheDocument();
		expect(within(row(5)).getByText("Changes Requested")).toBeInTheDocument();
		expect(within(row(6)).getByText("Ready for Follow-up")).toBeInTheDocument();
	});

	it("loads the next page while more PRs exist, and says when all are in", async () => {
		const prs = [pr(1, ago(MIN))];
		const { onLoadMore, rerender } = renderList({ prs, hasMore: true });
		await userEvent.click(screen.getByRole("button", { name: "Load More" }));
		expect(onLoadMore).toHaveBeenCalledTimes(1);

		const again = (props: Partial<React.ComponentProps<typeof PRList>>) =>
			rerender(
				<PRList
					prs={prs}
					selectedPRNumber={null}
					isLoading={false}
					hasMore
					error={null}
					getReviewStateForPR={() => null}
					onSelectPR={vi.fn()}
					onLoadMore={onLoadMore}
					isLoadingMore={false}
					isFiltered={false}
					{...props}
				/>,
			);
		again({ isLoadingMore: true });
		expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled();
		again({ hasMore: false });
		expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
		expect(screen.getByText("All PRs loaded")).toBeInTheDocument();
	});
});
