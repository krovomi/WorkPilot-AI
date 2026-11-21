/**
 * @vitest-environment jsdom
 */
/**
 * A server project's held rejections (#361, lot 3): a finding whose rejection
 * waits for a maintainer says so; the panel lists the held rejections, with
 * Approve and Discard for a maintainer only; a reset is a maintainer's; the
 * conventions file is a local project's. In English and in French.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { PRReviewFinding } from "@preload/api/modules/github-api";
import i18n from "@shared/i18n";
import type { ReviewFeedbackStats as Stats } from "../../../../../shared/types/review-feedback";
import { useFindingFeedback } from "../../hooks/useFindingFeedback";
import { useReviewFeedbackStats } from "../../hooks/useReviewFeedbackStats";
import { FindingFeedback } from "../FindingFeedback";
import { ReviewFeedbackStats } from "../ReviewFeedbackStats";
import { ReviewFindings } from "../ReviewFindings";

const rf = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`reviewFeedback:${key}`, options) as string;
const common = (key: string) => i18n.t(`common:${key}`) as string;

const api = {
	getReviewFeedbackStats: vi.fn(),
	resetReviewFeedbackRule: vi.fn(),
	writeReviewConventions: vi.fn(),
	decideHeldReviewFeedback: vi.fn(),
	getReviewFindingFeedback: vi.fn(),
	setReviewFindingFeedback: vi.fn(),
};

const HELD = [
	{
		prNumber: 12,
		findingId: "f-1",
		verdict: "rejected" as const,
		reason: "too_pedantic" as const,
		note: "we never document helpers",
		category: "style",
		label: "Missing docstring on `foo`",
	},
	{
		prNumber: 13,
		findingId: "f-2",
		verdict: "not_applicable" as const,
		reason: null,
		note: "",
		category: "quality",
		label: "Prefer an early return",
	},
];

function stats(maintainer: boolean, held = HELD): Stats {
	return {
		threshold: 3,
		categories: [{ category: "style", accepted: 0, rejected: 3, notApplicable: 0 }],
		rules: [
			{
				signature: "0123456789abcdef",
				category: "style",
				label: "Nit",
				rejections: 3,
				accepts: 0,
				status: "downgraded",
				topReason: null,
			},
		],
		server: { maintainer, held },
	};
}

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.getReviewFindingFeedback.mockResolvedValue({ success: true, feedback: {} });
	(window as unknown as { electronAPI: unknown }).electronAPI = { github: api };
	await i18n.changeLanguage("en");
});

afterEach(async () => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	await i18n.changeLanguage("en");
});

async function openPanel(answer: Stats) {
	api.getReviewFeedbackStats.mockResolvedValue({ success: true, stats: answer });
	render(<ReviewFeedbackStats projectId="p1" />);
	fireEvent.click(screen.getByRole("button", { name: rf("show") }));
	await screen.findByText(rf("held.title", { count: answer.server?.held.length }));
}

describe("held rejections in the panel", () => {
	it("lets a maintainer approve or discard each one", async () => {
		await openPanel(stats(true));
		expect(screen.getByText(rf("held.pr", { number: 12 }))).toBeInTheDocument();
		expect(screen.getByText("we never document helpers")).toBeInTheDocument();
		expect(screen.getByText(common("prReview.feedback.reasons.too_pedantic"), { exact: false })).toBeInTheDocument();
		expect(screen.getByText(HELD[1].label).closest("li")).toHaveTextContent(
			common("prReview.feedback.notApplicable"),
		);
		expect(screen.queryByText(rf("conventions.write"))).toBeNull();
		expect(screen.getByText(rf("resetHint"))).toBeInTheDocument();
		expect(screen.getByRole("button", { name: rf("resetLabel", { label: "Nit" }) })).toBeInTheDocument();

		api.decideHeldReviewFeedback.mockResolvedValue({
			success: true,
			stats: stats(true, [HELD[1]]),
		});
		fireEvent.click(
			screen.getByRole("button", {
				name: rf("held.approveLabel", { label: HELD[0].label }),
			}),
		);
		await waitFor(() =>
			expect(api.decideHeldReviewFeedback).toHaveBeenCalledWith("p1", 12, "f-1", true),
		);
		await screen.findByText(rf("held.title", { count: 1 }));
		fireEvent.click(
			screen.getByRole("button", {
				name: rf("held.discardLabel", { label: HELD[1].label }),
			}),
		);
		await waitFor(() =>
			expect(api.decideHeldReviewFeedback).toHaveBeenLastCalledWith(
				"p1",
				13,
				"f-2",
				false,
			),
		);
	});

	it("shows a member the list without buttons, and no reset", async () => {
		await openPanel(stats(false));
		expect(screen.queryByRole("button", { name: rf("held.approveLabel", { label: HELD[0].label }) })).toBeNull();
		expect(screen.queryByRole("button", { name: rf("resetLabel", { label: "Nit" }) })).toBeNull();
		expect(screen.getByText(rf("maintainerOnly"))).toBeInTheDocument();
	});

	it("lists nothing when nothing is held", async () => {
		api.getReviewFeedbackStats.mockResolvedValue({
			success: true,
			stats: stats(true, []),
		});
		render(<ReviewFeedbackStats projectId="p1" />);
		fireEvent.click(screen.getByRole("button", { name: rf("show") }));
		await screen.findByText(rf("rulesTitle"));
		expect(screen.queryByText(rf("held.hint"))).toBeNull();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		await openPanel(stats(true));
		expect(screen.getByText("PR n° 12")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: /^Approuver le rejet/ })).toHaveLength(2);
	});
});

describe("the decide action", () => {
	it("does nothing without a project, says a throw, and clears its mark", async () => {
		const empty = renderHook(() => useReviewFeedbackStats(undefined));
		await act(() => empty.result.current.decide(1, "f", true));
		expect(api.decideHeldReviewFeedback).not.toHaveBeenCalled();

		api.decideHeldReviewFeedback.mockRejectedValue(new Error("ipc down"));
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.decide(1, "f", false));
		expect(result.current.error).toBe("write_failed");
		expect(result.current.pendingHeld).toBeNull();
	});
});

describe("a held finding", () => {
	it("says it waits for a maintainer, until the form opens", () => {
		render(<FindingFeedback findingId="f-1" verdict="rejected" held onSubmit={vi.fn()} />);
		expect(screen.getByRole("status")).toHaveTextContent(common("prReview.feedback.held"));
		fireEvent.click(screen.getByText(common("prReview.feedback.reject")));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("is not held by default", () => {
		render(<FindingFeedback findingId="f-1" verdict="rejected" onSubmit={vi.fn()} />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("comes from the main process's answers, and goes when the PR changes", async () => {
		api.getReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { "f-1": "rejected" },
			held: ["f-1"],
		});
		api.setReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { "f-1": "accepted" },
		});
		const { result, rerender } = renderHook(
			({ pr }: { pr: number }) => useFindingFeedback("p1", pr),
			{ initialProps: { pr: 3 } },
		);
		await waitFor(() => expect(result.current.held).toEqual(["f-1"]));
		await act(async () => {
			await result.current.submit({ findingId: "f-1", verdict: "accepted" });
		});
		expect(result.current.held).toEqual([]);
		api.getReviewFindingFeedback.mockResolvedValue({ success: false, error: "not_found" });
		rerender({ pr: 4 });
		await waitFor(() => expect(result.current.feedback).toEqual({}));
		expect(result.current.held).toEqual([]);
	});

	it("is marked in the findings list", async () => {
		api.getReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { "f-1": "rejected" },
			held: ["f-1"],
		});
		api.setReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { "f-1": "rejected" },
			held: ["f-1"],
		});
		const finding: PRReviewFinding = {
			id: "f-1",
			severity: "high",
			category: "style",
			title: "Missing docstring",
			description: "d",
			file: "a.py",
			line: 1,
			fixable: false,
		};
		render(
			<ReviewFindings
				findings={[finding]}
				selectedIds={new Set()}
				onSelectionChange={vi.fn()}
				projectId="p1"
				prNumber={3}
			/>,
		);
		expect(await screen.findByText(common("prReview.feedback.held"))).toBeInTheDocument();
	});
});
