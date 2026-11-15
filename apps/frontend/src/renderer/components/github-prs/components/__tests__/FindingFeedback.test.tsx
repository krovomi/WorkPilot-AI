/**
 * @vitest-environment jsdom
 */
/**
 * Accept / Reject / Not applicable on a review finding (#361).
 */
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { PRReviewFinding } from "@preload/api/modules/github-api";
import i18n from "@shared/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FindingFeedback } from "../FindingFeedback";
import { FindingItem } from "../FindingItem";
import { LearnedSuppressionsNote } from "../LearnedSuppressionsNote";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`common:${key}`, options) as string;

describe("FindingFeedback", () => {
	it("sends an acceptance at once", async () => {
		const onSubmit = vi.fn().mockResolvedValue(true);
		render(<FindingFeedback findingId="f-1" onSubmit={onSubmit} />);
		fireEvent.click(screen.getByText(t("prReview.feedback.accept")));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				findingId: "f-1",
				verdict: "accepted",
			}),
		);
	});

	it("asks for an optional reason before sending a rejection", async () => {
		const onSubmit = vi.fn().mockResolvedValue(true);
		render(<FindingFeedback findingId="f-1" onSubmit={onSubmit} />);
		fireEvent.click(screen.getByText(t("prReview.feedback.reject")));
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText(t("prReview.feedback.reasonLabel")), {
			target: { value: "project_convention" },
		});
		fireEvent.change(screen.getByLabelText(t("prReview.feedback.noteLabel")), {
			target: { value: "we use tabs" },
		});
		fireEvent.click(screen.getByText(t("prReview.feedback.save")));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				findingId: "f-1",
				verdict: "rejected",
				reason: "project_convention",
				note: "we use tabs",
			}),
		);
	});

	it("sends a bare rejection, and keeps the form when it fails", async () => {
		const onSubmit = vi.fn().mockResolvedValue(false);
		render(<FindingFeedback findingId="f-1" onSubmit={onSubmit} />);
		fireEvent.click(screen.getByText(t("prReview.feedback.notApplicable")));
		fireEvent.change(screen.getByLabelText(t("prReview.feedback.noteLabel")), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByText(t("prReview.feedback.save")));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				findingId: "f-1",
				verdict: "not_applicable",
				reason: null,
				note: undefined,
			}),
		);
		expect(screen.getByText(t("prReview.feedback.save"))).toBeInTheDocument();
	});

	it("closes the form on cancel without sending", () => {
		const onSubmit = vi.fn();
		render(<FindingFeedback findingId="f-1" onSubmit={onSubmit} />);
		fireEvent.click(screen.getByText(t("prReview.feedback.reject")));
		fireEvent.click(screen.getByText(t("prReview.feedback.cancel")));
		expect(screen.queryByText(t("prReview.feedback.save"))).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("shows the recorded verdict as pressed", () => {
		render(
			<FindingFeedback findingId="f-1" verdict="not_applicable" onSubmit={vi.fn()} />,
		);
		expect(
			screen.getByText(t("prReview.feedback.notApplicable")).closest("button"),
		).toHaveAttribute("aria-pressed", "true");
	});
});

describe("learned suppressions in the findings list", () => {
	const finding: PRReviewFinding = {
		id: "f-1",
		severity: "low",
		category: "style",
		title: "Missing docstring",
		description: "d",
		file: "a.py",
		line: 1,
		fixable: false,
		learnedRejections: 4,
	};

	it("marks a finding the feedback downgraded", () => {
		render(<FindingItem finding={finding} selected={false} onToggle={vi.fn()} />);
		expect(
			screen.getByText(t("prReview.feedback.learnedBadge", { count: 4 })),
		).toBeInTheDocument();
	});

	it("lists the dropped findings on demand", () => {
		render(
			<LearnedSuppressionsNote
				suppressions={[
					{
						id: "x",
						title: "Prefer early return",
						category: "style",
						severity: "low",
						file: "b.ts",
						line: 9,
						rejections: 6,
					},
				]}
			/>,
		);
		expect(
			screen.getByText(t("prReview.feedback.suppressed", { count: 1 })),
		).toBeInTheDocument();
		expect(screen.queryByText("Prefer early return")).toBeNull();
		fireEvent.click(screen.getByText(t("prReview.feedback.show")));
		expect(screen.getByText("Prefer early return")).toBeInTheDocument();
	});
});
