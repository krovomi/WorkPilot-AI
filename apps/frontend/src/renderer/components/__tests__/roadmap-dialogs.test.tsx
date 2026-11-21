/** @vitest-environment jsdom */
/**
 * The roadmap's dialogs: adding a feature (saved with the roadmap, taken
 * back out when the save fails), the competitor analysis question, the
 * choice when an analysis exists, and the analysis results.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { useRoadmapStore } from "../../stores/roadmap-store";
import { AddFeatureDialog } from "../AddFeatureDialog";
import { CompetitorAnalysisDialog } from "../CompetitorAnalysisDialog";
import { CompetitorAnalysisViewer } from "../CompetitorAnalysisViewer";
import { ExistingCompetitorAnalysisDialog } from "../ExistingCompetitorAnalysisDialog";
import { analysis, phase, roadmap } from "../roadmap/__tests__/fixtures";

const saveRoadmap = vi.fn();

beforeAll(() => {
	// Radix Select measures and scrolls its options.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = { saveRoadmap };
	saveRoadmap.mockResolvedValue({ success: true });
	await i18n.changeLanguage("en");
	useRoadmapStore.setState({ roadmap: roadmap({ features: [] }) });
});
afterEach(cleanup);

const choose = async (trigger: string, option: string) => {
	fireEvent.keyDown(screen.getByLabelText(trigger), { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: option }));
};

describe("AddFeatureDialog", () => {
	const phases = [phase("p1", { name: "Now", order: 1 }), phase("p2", { name: "Later", order: 2 })];
	const open = (onOpenChange = vi.fn()) => {
		render(<AddFeatureDialog phases={phases} open onOpenChange={onOpenChange} />);
		return onOpenChange;
	};
	const add = () => screen.getByRole("button", { name: "Add Feature" });

	it("adds a feature once it has a title and a description, and saves the roadmap with it", async () => {
		const onOpenChange = open();
		expect(add()).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/Feature Title/), { target: { value: "  Dark mode " } });
		expect(add()).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: " Easier on the eyes " } });
		expect(add()).toBeEnabled();

		await choose("Phase *", "2. Later");
		await choose("Priority", "Could have");
		await choose("Complexity", "High");
		await choose("Impact", "Low impact");
		fireEvent.click(add());

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		const [added] = useRoadmapStore.getState().roadmap?.features ?? [];
		expect(added).toMatchObject({
			title: "Dark mode",
			description: "Easier on the eyes",
			rationale: "Added to the roadmap by hand.",
			phaseId: "p2",
			priority: "could",
			complexity: "high",
			impact: "low",
			status: "under_review",
		});
		expect(saveRoadmap).toHaveBeenCalledWith("proj", expect.objectContaining({ features: [added] }));
	});

	it("keeps a rationale that was written, and waits while saving", async () => {
		let finish!: (v: unknown) => void;
		saveRoadmap.mockReturnValueOnce(new Promise((r) => (finish = r)));
		const onOpenChange = open();
		fireEvent.change(screen.getByLabelText(/Feature Title/), { target: { value: "Search" } });
		fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "Find things" } });
		fireEvent.change(screen.getByLabelText(/Rationale/), { target: { value: "People ask" } });
		fireEvent.click(add());
		expect(await screen.findByRole("button", { name: "Adding..." })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onOpenChange).not.toHaveBeenCalled();
		await act(async () => finish({ success: true }));
		expect(useRoadmapStore.getState().roadmap?.features[0].rationale).toBe("People ask");
		expect(useRoadmapStore.getState().roadmap?.features[0].phaseId).toBe("p1");
	});

	it("takes the feature back out and says why when the save is refused or fails", async () => {
		saveRoadmap
			.mockResolvedValueOnce({ success: false, error: "a teammate saved first" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce("offline");
		const onOpenChange = open();
		fireEvent.change(screen.getByLabelText(/Feature Title/), { target: { value: "Export" } });
		fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "CSV" } });

		fireEvent.click(add());
		expect(await screen.findByRole("alert")).toHaveTextContent("a teammate saved first");
		expect(useRoadmapStore.getState().roadmap?.features).toEqual([]);

		fireEvent.click(add());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to add feature. Please try again."));
		fireEvent.click(add());
		await waitFor(() => expect(saveRoadmap).toHaveBeenCalledTimes(3));
		expect(screen.getByRole("alert")).toHaveTextContent("Failed to add feature. Please try again.");
		expect(useRoadmapStore.getState().roadmap?.features).toEqual([]);
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("starts over each time it opens, and needs a phase to add", () => {
		const { rerender } = render(<AddFeatureDialog phases={[]} open onOpenChange={vi.fn()} />);
		fireEvent.change(screen.getByLabelText(/Feature Title/), { target: { value: "X" } });
		fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "Y" } });
		expect(add()).toBeDisabled();
		rerender(<AddFeatureDialog phases={[]} open={false} onOpenChange={vi.fn()} />);
		rerender(<AddFeatureDialog phases={phases} open onOpenChange={vi.fn()} />);
		expect(screen.getByLabelText(/Feature Title/)).toHaveValue("");
	});

	it("closes on Cancel", () => {
		const onOpenChange = open();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("CompetitorAnalysisDialog", () => {
	it("enables or skips the analysis, then closes", () => {
		const onAccept = vi.fn();
		const onDecline = vi.fn();
		const onOpenChange = vi.fn();
		render(<CompetitorAnalysisDialog open onOpenChange={onOpenChange} onAccept={onAccept} onDecline={onDecline} />);
		fireEvent.click(screen.getByRole("button", { name: "Yes, Enable Analysis" }));
		fireEvent.click(screen.getByRole("button", { name: "No, Skip Analysis" }));
		expect(onAccept).toHaveBeenCalledTimes(1);
		expect(onDecline).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("ExistingCompetitorAnalysisDialog", () => {
	const props = () => ({ onOpenChange: vi.fn(), onUseExisting: vi.fn(), onRunNew: vi.fn(), onSkip: vi.fn() });

	it("dates the saved analysis and runs the chosen option", () => {
		const p = props();
		render(<ExistingCompetitorAnalysisDialog open {...p} analysisDate={new Date("2026-11-01T10:00:00Z")} />);
		expect(screen.getByText(/from Nov 1, 2026/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Use existing analysis/ }));
		fireEvent.click(screen.getByRole("button", { name: /Run new analysis/ }));
		fireEvent.click(screen.getByRole("button", { name: /Skip competitor analysis/ }));
		expect(p.onUseExisting).toHaveBeenCalledTimes(1);
		expect(p.onRunNew).toHaveBeenCalledTimes(1);
		expect(p.onSkip).toHaveBeenCalledTimes(1);
		expect(p.onOpenChange).toHaveBeenCalledTimes(3);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
	});

	it("says recently, in the app's language, without a date", async () => {
		await i18n.changeLanguage("fr");
		render(<ExistingCompetitorAnalysisDialog open {...props()} />);
		expect(screen.getByText(/récemment/)).toBeInTheDocument();
	});
});

describe("CompetitorAnalysisViewer", () => {
	it("shows nothing without an analysis", () => {
		const { container } = render(<CompetitorAnalysisViewer analysis={null} open onOpenChange={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("lists each competitor, its pain points by severity and the summary", () => {
		const a = analysis({
			insightsSummary: { topPainPoints: ["Sync"], differentiatorOpportunities: ["Speed"], marketTrends: ["AI"] },
		});
		a.competitors.push({
			id: "c2",
			name: "Quiet",
			url: "",
			description: "",
			relevance: "low",
			painPoints: [],
			strengths: [],
			marketPosition: "",
		});
		a.competitors[0].painPoints[2] = { ...a.competitors[0].painPoints[2], source: "", frequency: "", opportunity: "" };
		render(<CompetitorAnalysisViewer analysis={a} open onOpenChange={vi.fn()} />);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Competitor Analysis Results")).toBeInTheDocument();
		expect(within(dialog).getByRole("heading", { name: "Rival" })).toBeInTheDocument();
		expect(within(dialog).getByText("leader")).toBeInTheDocument();
		expect(within(dialog).getByRole("link", { name: /Rival/ })).toHaveAttribute("href", "https://rival.example");
		expect(within(dialog).getByText("High severity")).toBeInTheDocument();
		expect(within(dialog).getByText("Medium severity")).toBeInTheDocument();
		expect(within(dialog).getByText("Low severity")).toBeInTheDocument();
		expect(within(dialog).getByText("Frequency: often")).toBeInTheDocument();
		expect(within(dialog).getAllByText(/^Source:/)).toHaveLength(2);
		expect(within(dialog).getByText("No pain points identified")).toBeInTheDocument();
		expect(within(dialog).queryByRole("link", { name: /Quiet/ })).not.toBeInTheDocument();
		for (const item of ["• Sync", "• Speed", "• AI"]) expect(within(dialog).getByText(item)).toBeInTheDocument();
	});

	it("leaves out the summary lists that are empty, and a summary that is missing", () => {
		const { rerender } = render(<CompetitorAnalysisViewer analysis={analysis()} open onOpenChange={vi.fn()} />);
		expect(screen.getByText("Market Insights Summary")).toBeInTheDocument();
		expect(screen.queryByText("Top Pain Points:")).not.toBeInTheDocument();
		rerender(<CompetitorAnalysisViewer analysis={analysis({ insightsSummary: undefined as never })} open onOpenChange={vi.fn()} />);
		expect(screen.queryByText("Market Insights Summary")).not.toBeInTheDocument();
	});
});
