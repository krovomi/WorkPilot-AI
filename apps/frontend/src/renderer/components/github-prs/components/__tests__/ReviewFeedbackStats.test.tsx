/**
 * @vitest-environment jsdom
 */
/**
 * The project-wide feedback panel (#361, lot 2): folded until opened, then
 * the acceptance rate per category, the learned rules with their reset, and
 * the conventions file; in English and in French.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import i18n from "@shared/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewFeedbackStats } from "../ReviewFeedbackStats";
import { ReviewFindings } from "../ReviewFindings";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`reviewFeedback:${key}`, options) as string;

const api = {
	getReviewFeedbackStats: vi.fn(),
	resetReviewFeedbackRule: vi.fn(),
	writeReviewConventions: vi.fn(),
	getReviewFindingFeedback: vi.fn(),
	setReviewFindingFeedback: vi.fn(),
};

const RULES = [
	{
		signature: "0123456789abcdef",
		category: "style",
		label: "Missing docstring on `foo`",
		rejections: 7,
		accepts: 1,
		status: "dropped" as const,
		topReason: "too_pedantic" as const,
	},
	{
		signature: "fedcba9876543210",
		category: "quality",
		label: "Prefer an early return",
		rejections: 3,
		accepts: 0,
		status: "downgraded" as const,
		topReason: null,
	},
];

const STATS = {
	threshold: 3,
	categories: [
		{ category: "style", accepted: 1, rejected: 6, notApplicable: 1 },
		{ category: "quality", accepted: 2, rejected: 0, notApplicable: 0 },
	],
	rules: RULES,
};

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

async function openPanel() {
	render(<ReviewFeedbackStats projectId="p1" />);
	fireEvent.click(screen.getByRole("button", { name: t("show") }));
	await waitFor(() => expect(api.getReviewFeedbackStats).toHaveBeenCalledWith("p1"));
}

describe("ReviewFeedbackStats", () => {
	it("reads nothing until opened", () => {
		render(<ReviewFeedbackStats projectId="p1" />);
		expect(api.getReviewFeedbackStats).not.toHaveBeenCalled();
		expect(screen.queryByText(t("subtitle"))).toBeNull();
	});

	it("shows the rates and the learned rules, and resets one", async () => {
		api.getReviewFeedbackStats.mockResolvedValue({ success: true, stats: STATS });
		api.resetReviewFeedbackRule.mockResolvedValue({
			success: true,
			stats: { ...STATS, rules: [RULES[1]] },
		});
		await openPanel();

		expect(await screen.findByText(t("overall", { rate: 30, total: 10 }))).toBeVisible();
		expect(screen.getByText(t("rate", { rate: 13 }))).toBeVisible();
		expect(screen.getByText(t("rate", { rate: 100 }))).toBeVisible();
		expect(screen.getByText(t("status.dropped"))).toBeVisible();
		expect(screen.getByText(t("status.downgraded"))).toBeVisible();
		expect(screen.getByText(/Too pedantic/)).toBeVisible();
		expect(screen.getByText(t("rulesHint", { threshold: 3 }))).toBeVisible();

		fireEvent.click(
			screen.getByRole("button", {
				name: t("resetLabel", { label: RULES[0].label }),
			}),
		);
		await waitFor(() =>
			expect(api.resetReviewFeedbackRule).toHaveBeenCalledWith(
				"p1",
				"0123456789abcdef",
			),
		);
		await waitFor(() => expect(screen.queryByText(RULES[0].label)).toBeNull());
	});

	it("says when nothing was rated, and when nothing was learned", async () => {
		api.getReviewFeedbackStats
			.mockResolvedValueOnce({
				success: true,
				stats: { threshold: 3, categories: [], rules: [] },
			})
			.mockResolvedValueOnce({
				success: true,
				stats: { ...STATS, rules: [] },
			});
		await openPanel();
		expect(await screen.findByText(t("empty"))).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: t("refresh") }));
		expect(await screen.findByText(t("noRules"))).toBeVisible();
	});

	it("shows that it is loading, and a refusal", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.getReviewFeedbackStats.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await openPanel();
		expect(screen.getByText(t("loading"))).toBeVisible();
		await act(async () => answer({ success: false, error: "server_project" }));
		expect(screen.getByRole("alert")).toHaveTextContent(t("errors.server_project"));
		expect(screen.queryByText(t("loading"))).toBeNull();
	});

	it("writes the conventions file and says where", async () => {
		api.getReviewFeedbackStats.mockResolvedValue({ success: true, stats: STATS });
		api.writeReviewConventions.mockResolvedValue({
			success: true,
			path: ".workpilot/review-conventions.md",
			rules: 2,
		});
		await openPanel();
		fireEvent.click(screen.getByRole("button", { name: t("conventions.write") }));
		expect(await screen.findByRole("status")).toHaveTextContent(
			t("conventions.written", {
				path: ".workpilot/review-conventions.md",
				count: 2,
			}),
		);
	});

	it("folds again", async () => {
		api.getReviewFeedbackStats.mockResolvedValue({ success: true, stats: STATS });
		await openPanel();
		fireEvent.click(screen.getByRole("button", { name: t("hide") }));
		expect(screen.queryByText(t("subtitle"))).toBeNull();
		expect(api.getReviewFeedbackStats).toHaveBeenCalledTimes(1);
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		api.getReviewFeedbackStats.mockResolvedValue({ success: true, stats: STATS });
		render(<ReviewFeedbackStats projectId="p1" />);
		fireEvent.click(screen.getByRole("button", { name: "Afficher" }));
		expect(await screen.findByText("Taux d'acceptation par catégorie")).toBeVisible();
		expect(screen.getByText("Rétrogradé en bas")).toBeVisible();
	});
});

describe("ReviewFindings", () => {
	it("carries the panel only with a project", () => {
		const { unmount } = render(
			<ReviewFindings findings={[]} selectedIds={new Set()} onSelectionChange={vi.fn()} />,
		);
		expect(screen.queryByRole("region", { name: t("title") })).toBeNull();
		unmount();
		render(
			<ReviewFindings
				findings={[]}
				selectedIds={new Set()}
				onSelectionChange={vi.fn()}
				projectId="p1"
				prNumber={3}
			/>,
		);
		expect(screen.getByRole("region", { name: t("title") })).toBeVisible();
	});
});
