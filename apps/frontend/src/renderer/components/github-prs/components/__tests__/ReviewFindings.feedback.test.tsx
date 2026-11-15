/**
 * @vitest-environment jsdom
 */
/**
 * The findings list with feedback (#361): the buttons appear only for a
 * review that has a project and a PR, show the recorded verdict, and a
 * refusal of the main process is said in the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { PRReviewFinding } from "@preload/api/modules/github-api";
import i18n from "@shared/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewFindings } from "../ReviewFindings";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`common:${key}`, options) as string;

const FINDING: PRReviewFinding = {
	id: "f-1",
	severity: "high",
	category: "style",
	title: "Missing docstring",
	description: "d",
	file: "a.py",
	line: 1,
	fixable: false,
};

const api = {
	getReviewFindingFeedback: vi.fn(),
	setReviewFindingFeedback: vi.fn(),
};

beforeEach(() => {
	api.getReviewFindingFeedback.mockReset();
	api.setReviewFindingFeedback.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { github: api };
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("ReviewFindings feedback", () => {
	it("offers no feedback without a project", () => {
		render(
			<ReviewFindings
				findings={[FINDING]}
				selectedIds={new Set()}
				onSelectionChange={vi.fn()}
			/>,
		);
		expect(screen.queryByText(t("prReview.feedback.accept"))).toBeNull();
	});

	it("shows the recorded verdict and says a refusal", async () => {
		api.getReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { "f-1": "rejected" },
		});
		api.setReviewFindingFeedback.mockResolvedValue({
			success: false,
			error: "server_project",
		});
		render(
			<ReviewFindings
				findings={[FINDING]}
				selectedIds={new Set()}
				onSelectionChange={vi.fn()}
				projectId="p1"
				prNumber={3}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.getByText(t("prReview.feedback.reject")).closest("button"),
			).toHaveAttribute("aria-pressed", "true"),
		);
		fireEvent.click(screen.getByText(t("prReview.feedback.accept")));
		expect(
			await screen.findByText(t("prReview.feedback.errors.server_project")),
		).toBeInTheDocument();
		expect(api.setReviewFindingFeedback).toHaveBeenCalledWith("p1", 3, {
			findingId: "f-1",
			verdict: "accepted",
		});
	});
});
