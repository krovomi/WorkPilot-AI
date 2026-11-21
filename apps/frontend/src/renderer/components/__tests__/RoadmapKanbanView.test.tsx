/** @vitest-environment jsdom */
/**
 * The roadmap's kanban: one column per status, feature cards that say where
 * they come from, and a drop that moves a feature to another status and
 * saves. jsdom has no layout for dnd-kit to measure, so the drag events are
 * given to the board's own handlers, captured from its DndContext.
 */
import "@testing-library/jest-dom/vitest";
import type { DndContextProps } from "@dnd-kit/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { useRoadmapStore } from "../../stores/roadmap-store";
import { analysis, feature, phase, roadmap } from "../roadmap/__tests__/fixtures";
import { RoadmapKanbanView } from "../RoadmapKanbanView";
import { TooltipProvider } from "../ui/tooltip";

let dnd: DndContextProps = {};
vi.mock("@dnd-kit/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/core")>();
	return {
		...actual,
		DndContext: (props: DndContextProps) => {
			dnd = props;
			return <actual.DndContext {...props} />;
		},
		// The real overlay waits for a pointer drag; show what the board gives it.
		DragOverlay: ({ children }: { children?: React.ReactNode }) => <div data-testid="drag-overlay">{children}</div>,
	};
});

const drag = (name: "onDragStart" | "onDragOver" | "onDragEnd", activeId: string, overId: string | null) =>
	act(() => {
		(dnd[name] as (event: unknown) => void)({
			active: { id: activeId },
			over: overId === null ? null : { id: overId },
		});
	});

const features = [
	feature("a", { status: "under_review", title: "Alpha", phaseId: "p1" }),
	feature("b", { status: "planned", title: "Beta", linkedSpecId: "spec-b", votes: 12, source: { provider: "canny" } }),
	feature("c", { status: "in_progress", title: "Gamma", competitorInsightIds: ["pp1"], source: { provider: "github_issue" } }),
	feature("d", { status: "done", title: "Delta", source: { provider: "jira" as never }, votes: 0 }),
];

beforeEach(async () => {
	await i18n.changeLanguage("en");
	dnd = {};
});
afterEach(cleanup);

const board = (props: Partial<React.ComponentProps<typeof RoadmapKanbanView>> = {}) => {
	const rm = roadmap({ features, phases: [phase("p1", { name: "Foundations and groundwork" })] });
	useRoadmapStore.setState({ roadmap: rm, competitorAnalysis: analysis() });
	return render(
		<TooltipProvider delayDuration={0}>
			<RoadmapKanbanView roadmap={rm} onFeatureClick={vi.fn()} {...props} />
		</TooltipProvider>,
	);
};

const column = (name: string) => screen.getByRole("heading", { name }).closest(".wp-card") as HTMLElement;

describe("RoadmapKanbanView", () => {
	it("puts each feature in the column of its status, with its count", () => {
		board();
		for (const [name, title] of [
			["Under review", "Alpha"],
			["Planned", "Beta"],
			["In progress", "Gamma"],
			["Done", "Delta"],
		]) {
			expect(within(column(name)).getByText(title)).toBeInTheDocument();
			expect(within(column(name)).getByText("1")).toBeInTheDocument();
		}
	});

	it("says what each card is and acts on it", async () => {
		const onFeatureClick = vi.fn();
		const onConvertToSpec = vi.fn();
		const onGoToTask = vi.fn();
		board({ onFeatureClick, onConvertToSpec, onGoToTask });

		const alpha = column("Under review");
		expect(within(alpha).getByText("Must have")).toBeInTheDocument();
		expect(within(alpha).getByText("Medium complexity")).toBeInTheDocument();
		expect(within(alpha).getByText("High impact")).toBeInTheDocument();
		expect(within(alpha).getByText("Foundations and groundwork")).toHaveClass("truncate");
		fireEvent.click(within(alpha).getByText("Alpha"));
		expect(onFeatureClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
		fireEvent.click(within(alpha).getByRole("button", { name: "Build" }));
		expect(onConvertToSpec).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
		expect(onFeatureClick).toHaveBeenCalledTimes(1);

		const beta = column("Planned");
		expect(within(beta).getByText("Canny")).toBeInTheDocument();
		expect(within(beta).getByText("12")).toBeInTheDocument();
		fireEvent.click(within(beta).getByRole("button", { name: "Task" }));
		expect(onGoToTask).toHaveBeenCalledWith("spec-b");

		expect(within(column("In progress")).getByText("GitHub Issues")).toBeInTheDocument();
		fireEvent.focus(within(column("In progress")).getByText("GitHub Issues"));
		expect((await screen.findAllByText("Imported from GitHub Issues")).length).toBeGreaterThan(0);

		const delta = column("Done");
		expect(within(delta).getByText("External")).toBeInTheDocument();
		expect(within(delta).queryByRole("button", { name: /Build|Task/ })).not.toBeInTheDocument();
		expect(within(delta).queryByText("0")).not.toBeInTheDocument();
	});

	it("offers no build button without a handler, and no task button handler is required", () => {
		board();
		expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
		fireEvent.click(within(column("Planned")).getByRole("button", { name: "Task" }));
	});

	it("shows an empty column, and invites the drop while a card is over it", () => {
		const rm = roadmap({ features: [feature("a", { status: "planned", title: "Alpha" })] });
		render(
			<TooltipProvider>
				<RoadmapKanbanView roadmap={rm} onFeatureClick={vi.fn()} />
			</TooltipProvider>,
		);
		expect(within(column("Done")).getByText("No features")).toBeInTheDocument();
		expect(within(column("Done")).getByText("Drag features here")).toBeInTheDocument();
		drag("onDragStart", "a", null);
		drag("onDragOver", "a", "done");
		expect(within(column("Done")).getByText("Drop here")).toBeInTheDocument();
		drag("onDragOver", "a", null);
		expect(within(column("Done")).queryByText("Drop here")).not.toBeInTheDocument();
	});

	it("moves a feature dropped on another column or on a card of another column, and saves", () => {
		const onSave = vi.fn();
		board({ onSave });
		drag("onDragStart", "a", null);
		drag("onDragOver", "a", "b");
		drag("onDragEnd", "a", "done");
		expect(useRoadmapStore.getState().roadmap?.features.find((f) => f.id === "a")?.status).toBe("done");
		expect(onSave).toHaveBeenCalledTimes(1);

		drag("onDragEnd", "b", "c");
		expect(useRoadmapStore.getState().roadmap?.features.find((f) => f.id === "b")?.status).toBe("in_progress");
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it("changes nothing for a drop in the same column, outside, or on something unknown", () => {
		const onSave = vi.fn();
		board({ onSave });
		drag("onDragEnd", "a", "under_review");
		drag("onDragEnd", "a", null);
		drag("onDragEnd", "ghost", "done");
		drag("onDragEnd", "a", "nowhere");
		drag("onDragStart", "ghost", null);
		drag("onDragOver", "a", "nowhere");
		expect(onSave).not.toHaveBeenCalled();
		expect(useRoadmapStore.getState().roadmap?.features.find((f) => f.id === "a")?.status).toBe("under_review");
	});

	it("shows the dragged feature with its status while it moves", () => {
		board();
		drag("onDragStart", "c", null);
		const overlay = screen.getByTestId("drag-overlay");
		expect(within(overlay).getByText("Gamma")).toBeInTheDocument();
		expect(within(overlay).getByText("In progress")).toBeInTheDocument();
		drag("onDragEnd", "c", null);
		expect(overlay).toBeEmptyDOMElement();
	});

	it("lifts a card picked up from the keyboard above the others, until the drag is cancelled", async () => {
		board();
		const card = within(column("Under review")).getByText("Alpha").closest("[aria-roledescription]") as HTMLElement;
		fireEvent.keyDown(card, { code: "Space", key: " " });
		expect(card.style.zIndex).toBe("50");
		expect(card).toHaveClass("dragging-placeholder");
		// The sensor listens for the keys that end a drag from the next tick.
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
		fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
		expect(card.style.zIndex).toBe("");
	});
});
