/** @vitest-environment jsdom */
/**
 * The pieces of the roadmap view, each with its own props: the header band,
 * the empty state, a feature card, a phase card, the detail panel and the
 * four tabs. Every value the roadmap stores as a code (priority, complexity,
 * impact, status, severity) reads in the app's language.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { TooltipProvider } from "../../ui/tooltip";
import { FeatureCard } from "../FeatureCard";
import { FeatureDetailPanel } from "../FeatureDetailPanel";
import { PhaseCard } from "../PhaseCard";
import { RoadmapEmptyState } from "../RoadmapEmptyState";
import { RoadmapHeader } from "../RoadmapHeader";
import { RoadmapTabs } from "../RoadmapTabs";
import { analysis, feature, phase, roadmap } from "./fixtures";

const wrap = (ui: React.ReactElement) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("RoadmapEmptyState", () => {
	it("offers to generate the roadmap", () => {
		const onGenerate = vi.fn();
		wrap(<RoadmapEmptyState onGenerate={onGenerate} />);
		expect(screen.getByText("No Roadmap Yet")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Generate Roadmap" }));
		expect(onGenerate).toHaveBeenCalledTimes(1);
	});
});

describe("RoadmapHeader", () => {
	const handlers = () => ({ onAddFeature: vi.fn(), onRefresh: vi.fn(), onViewCompetitorAnalysis: vi.fn() });

	it("shows the vision, the audience, the counts and the priorities, in the app's language", async () => {
		const h = handlers();
		const rm = roadmap({
			targetAudience: { primary: "Developers", secondary: ["Managers", "QA"] },
			phases: [phase("p1"), phase("p2")],
			features: [feature("a"), feature("b", { priority: "could" }), feature("c", { priority: "zany" as never })],
		});
		wrap(<RoadmapHeader roadmap={rm} competitorAnalysis={null} {...h} />);
		expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
		expect(screen.getByText("Ship the best widgets")).toBeInTheDocument();
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByText("Target: Developers")).toBeInTheDocument();
		expect(screen.getByText("3 features")).toBeInTheDocument();
		expect(screen.getByText("2 phases")).toBeInTheDocument();
		expect(screen.getByText("1 must")).toBeInTheDocument();
		expect(screen.getByText("1 could")).toBeInTheDocument();
		expect(screen.getByText("1 zany")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Competitor Analysis" })).not.toBeInTheDocument();

		fireEvent.focus(screen.getByText("+2 more personas"));
		expect((await screen.findAllByText("• Managers")).length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("button", { name: "Add Feature" }));
		fireEvent.click(screen.getByRole("button", { name: "Regenerate Roadmap" }));
		expect(h.onAddFeature).toHaveBeenCalledTimes(1);
		expect(h.onRefresh).toHaveBeenCalledTimes(1);
	});

	it("counts one feature and one phase in the singular, in French, for a roadmap without audience", async () => {
		await i18n.changeLanguage("fr");
		// A roadmap file written before audiences were saved has none.
		const rm = roadmap({ targetAudience: undefined as never, status: "draft" });
		wrap(<RoadmapHeader roadmap={rm} competitorAnalysis={null} {...handlers()} />);
		expect(screen.getByText("1 fonctionnalité")).toBeInTheDocument();
		expect(screen.getByText("1 phase")).toBeInTheDocument();
		expect(screen.getByText("Brouillon")).toBeInTheDocument();
		expect(screen.queryByText(/Cible/)).not.toBeInTheDocument();
		expect(screen.queryByText(/personas/)).not.toBeInTheDocument();
	});

	it("opens the competitor analysis when there is one, and says what it found", () => {
		const h = handlers();
		wrap(<RoadmapHeader roadmap={roadmap()} competitorAnalysis={analysis()} {...h} />);
		const button = screen.getByRole("button", { name: "Competitor Analysis" });
		expect(button).toHaveAttribute("title", "Analyzed 1 competitors with 3 pain points identified");
		fireEvent.click(button);
		expect(h.onViewCompetitorAnalysis).toHaveBeenCalledTimes(1);
	});
});

describe("FeatureCard", () => {
	it("reads its priority, complexity and impact, and opens on a click", async () => {
		const onClick = vi.fn();
		const onConvertToSpec = vi.fn();
		const f = feature("one", { complexity: "low", impact: "medium", priority: "should" });
		wrap(<FeatureCard feature={f} onClick={onClick} onConvertToSpec={onConvertToSpec} onGoToTask={vi.fn()} hasCompetitorInsight />);
		expect(screen.getByText("Should have")).toBeInTheDocument();
		expect(screen.getByText("Low complexity")).toBeInTheDocument();
		expect(screen.getByText("Medium impact")).toBeInTheDocument();
		fireEvent.focus(screen.getByText("Competitor Insight"));
		expect((await screen.findAllByText("This feature addresses competitor pain points")).length).toBeGreaterThan(0);

		fireEvent.click(screen.getByText("Feature one"));
		expect(onClick).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Build" }));
		expect(onConvertToSpec).toHaveBeenCalledWith(f);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("goes to the linked task, and offers nothing for a done feature", () => {
		const onClick = vi.fn();
		const onGoToTask = vi.fn();
		const { rerender } = wrap(
			<FeatureCard feature={feature("one", { linkedSpecId: "spec-9" })} onClick={onClick} onConvertToSpec={vi.fn()} onGoToTask={onGoToTask} />,
		);
		expect(screen.queryByText("Competitor Insight")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Go to Task" }));
		expect(onGoToTask).toHaveBeenCalledWith("spec-9");
		expect(onClick).not.toHaveBeenCalled();

		rerender(
			<TooltipProvider>
				<FeatureCard feature={feature("one", { status: "done" })} onClick={onClick} onConvertToSpec={vi.fn()} onGoToTask={onGoToTask} />
			</TooltipProvider>,
		);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});

describe("PhaseCard", () => {
	it("shows the phase, its progress, its milestones and its first five features", () => {
		const onFeatureSelect = vi.fn();
		const onConvertToSpec = vi.fn();
		const onGoToTask = vi.fn();
		const features = [
			feature("done", { status: "done", priority: "could" }),
			feature("linked", { linkedSpecId: "spec-1", competitorInsightIds: ["pp1"] }),
			feature("todo"),
			feature("four"),
			feature("five"),
			feature("six"),
			feature("seven"),
		];
		const p = phase("p1", {
			order: 2,
			status: "in_progress",
			milestones: [
				{ id: "m1", title: "Beta out", description: "", features: [], status: "achieved" },
				{ id: "m2", title: "GA", description: "", features: [], status: "planned" },
			],
		});
		wrap(<PhaseCard phase={p} features={features} onFeatureSelect={onFeatureSelect} onConvertToSpec={onConvertToSpec} onGoToTask={onGoToTask} />);

		expect(screen.getByRole("heading", { name: "Phase p1" })).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText("In progress")).toBeInTheDocument();
		expect(screen.getByText("1/7 features")).toBeInTheDocument();
		expect(screen.getByText("Beta out")).toHaveClass("line-through");
		expect(screen.getByText("GA")).not.toHaveClass("line-through");
		expect(screen.getByText("Features (7)")).toBeInTheDocument();
		expect(screen.getByText("+2 more features")).toBeInTheDocument();
		expect(screen.queryByText("Feature six")).not.toBeInTheDocument();
		expect(screen.getByText("Could have")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Feature todo/ }));
		expect(onFeatureSelect).toHaveBeenCalledWith(features[2]);
		fireEvent.click(screen.getByRole("button", { name: /View Task/ }));
		expect(onGoToTask).toHaveBeenCalledWith("spec-1");
		fireEvent.click(screen.getAllByRole("button", { name: /Build/ })[0]);
		expect(onConvertToSpec).toHaveBeenCalledWith(features[2]);
		expect(onFeatureSelect).toHaveBeenCalledTimes(1);
	});

	it("shows a completed phase with a check and an empty one at zero", () => {
		wrap(
			<PhaseCard phase={phase("p1", { status: "completed", order: 4 })} features={[]} onFeatureSelect={vi.fn()} onConvertToSpec={vi.fn()} onGoToTask={vi.fn()} />,
		);
		expect(screen.getByText("Completed")).toBeInTheDocument();
		expect(screen.queryByText("4")).not.toBeInTheDocument();
		expect(screen.getByText("0/0 features")).toBeInTheDocument();
		expect(screen.queryByText("Milestones")).not.toBeInTheDocument();
		expect(screen.queryByText(/more features/)).not.toBeInTheDocument();
	});

	it("shows a planned phase with its number", () => {
		wrap(<PhaseCard phase={phase("p1", { order: 3 })} features={[]} onFeatureSelect={vi.fn()} onConvertToSpec={vi.fn()} onGoToTask={vi.fn()} />);
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("Planned")).toBeInTheDocument();
	});
});

describe("FeatureDetailPanel", () => {
	const full = feature("one", {
		priority: "wont",
		complexity: "high",
		impact: "low",
		dependencies: ["auth", "billing"],
		userStories: ["As a dev I want speed"],
		acceptanceCriteria: ["It is fast"],
	});

	it("shows every part of the feature and the pain points it answers", () => {
		const insights = analysis().competitors[0].painPoints;
		wrap(
			<FeatureDetailPanel feature={full} onClose={vi.fn()} onConvertToSpec={vi.fn()} onGoToTask={vi.fn()} onDelete={vi.fn()} competitorInsights={insights} />,
		);
		expect(screen.getByRole("heading", { name: "Feature one" })).toBeInTheDocument();
		expect(screen.getByText("Won't have")).toBeInTheDocument();
		expect(screen.getByText("High complexity")).toBeInTheDocument();
		expect(screen.getByText("High")).toBeInTheDocument();
		expect(screen.getByText("Low")).toBeInTheDocument();
		expect(screen.getByText("Why one")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText(/As a dev I want speed/)).toBeInTheDocument();
		expect(screen.getByText("It is fast")).toBeInTheDocument();
		expect(screen.getByText("billing")).toBeInTheDocument();
		expect(screen.getByText("Slow sync")).toBeInTheDocument();
		expect(screen.getByText("High severity")).toHaveClass("text-destructive");
		expect(screen.getByText("Medium severity")).toHaveClass("text-warning");
		expect(screen.getByText("Low severity")).toHaveClass("text-success");
	});

	it("leaves out the empty parts and converts an open feature", () => {
		const onConvertToSpec = vi.fn();
		const f = feature("bare");
		wrap(<FeatureDetailPanel feature={f} onClose={vi.fn()} onConvertToSpec={onConvertToSpec} onGoToTask={vi.fn()} onDelete={vi.fn()} />);
		expect(screen.queryByText("User Stories")).not.toBeInTheDocument();
		expect(screen.queryByText("Acceptance Criteria")).not.toBeInTheDocument();
		expect(screen.getAllByText("Dependencies")).toHaveLength(1);
		expect(screen.queryByText("Addresses Competitor Pain Points")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		expect(onConvertToSpec).toHaveBeenCalledWith(f);
	});

	it("goes to the linked task, and offers nothing for a done feature", () => {
		const onGoToTask = vi.fn();
		const { rerender } = wrap(
			<FeatureDetailPanel feature={feature("x", { linkedSpecId: "spec-3" })} onClose={vi.fn()} onConvertToSpec={vi.fn()} onGoToTask={onGoToTask} onDelete={vi.fn()} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Go to Task" }));
		expect(onGoToTask).toHaveBeenCalledWith("spec-3");
		rerender(
			<FeatureDetailPanel feature={feature("x", { status: "done" })} onClose={vi.fn()} onConvertToSpec={vi.fn()} onGoToTask={onGoToTask} onDelete={vi.fn()} />,
		);
		expect(screen.queryByRole("button", { name: /Go to Task|Convert/ })).not.toBeInTheDocument();
	});

	it("closes, and deletes only once confirmed", () => {
		const onClose = vi.fn();
		const onDelete = vi.fn();
		wrap(<FeatureDetailPanel feature={full} onClose={onClose} onConvertToSpec={vi.fn()} onGoToTask={vi.fn()} onDelete={onDelete} />);
		fireEvent.click(screen.getByRole("button", { name: "Close feature details" }));
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Delete feature" }));
		expect(screen.getByText('This will permanently remove "Feature one" from your roadmap.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Delete Feature?")).not.toBeInTheDocument();
		expect(onDelete).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Delete feature" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onDelete).toHaveBeenCalledWith("one");
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

describe("RoadmapTabs", () => {
	function Tabbed(props: { onFeatureSelect: (f: unknown) => void; onConvertToSpec: (f: unknown) => void }) {
		const [tab, setTab] = useState("kanban");
		const rm = roadmap({
			phases: [phase("p1"), phase("p2", { name: "Later" })],
			features: [
				feature("a", { priority: "must", competitorInsightIds: ["pp1"] }),
				feature("b", { priority: "could", phaseId: "p2", complexity: "low", impact: "low" }),
			],
		});
		return (
			<RoadmapTabs
				roadmap={rm}
				activeTab={tab}
				onTabChange={setTab}
				onFeatureSelect={props.onFeatureSelect}
				onConvertToSpec={props.onConvertToSpec}
				onGoToTask={vi.fn()}
			/>
		);
	}

	it("shows the kanban first, then the phases, every feature and the features by priority", () => {
		const onFeatureSelect = vi.fn();
		const onConvertToSpec = vi.fn();
		wrap(<Tabbed onFeatureSelect={onFeatureSelect} onConvertToSpec={onConvertToSpec} />);
		const tablist = screen.getByRole("tablist", { name: "Roadmap views" });
		expect(within(tablist).getByRole("tab", { name: /Kanban/ })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Planned")).toBeInTheDocument();

		fireEvent.click(within(tablist).getByRole("tab", { name: /Phases/ }));
		expect(screen.getByRole("heading", { name: "Later" })).toBeInTheDocument();
		expect(screen.getAllByText("Features (1)", { selector: "h4" })).toHaveLength(2);

		fireEvent.click(within(tablist).getByRole("tab", { name: /All Features/ }));
		fireEvent.click(screen.getByText("Feature b"));
		expect(onFeatureSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b" }));
		expect(screen.getByText("Competitor Insight")).toBeInTheDocument();

		fireEvent.click(within(tablist).getByRole("tab", { name: /By Priority/ }));
		expect(screen.getAllByText("0 features")).toHaveLength(2);
		expect(screen.getAllByText("1 features")).toHaveLength(2);
		expect(screen.getByText("Insight")).toBeInTheDocument();
		expect(screen.getByText("Low complexity")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Feature a/ }));
		expect(onFeatureSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
	});
});
