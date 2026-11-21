/**
 * SortableFeatureCard — a feature on the roadmap's Kanban: its priority,
 * phase, complexity and impact, where it came from, its action, and how it
 * looks while it is dragged. Real dnd-kit, real i18n.
 */
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import i18n from "../../../shared/i18n";
import type { Roadmap, RoadmapFeature } from "../../../shared/types";
import { SortableFeatureCard } from "../SortableFeatureCard";
import { TooltipProvider } from "../ui/tooltip";

function makeFeature(overrides: Partial<RoadmapFeature> = {}): RoadmapFeature {
	return {
		id: "f1",
		title: "Dark mode",
		description: "Let people pick a dark theme",
		rationale: "",
		priority: "must",
		complexity: "low",
		impact: "high",
		phaseId: "p1",
		dependencies: [],
		status: "planned",
		acceptanceCriteria: [],
		userStories: [],
		...overrides,
	} as RoadmapFeature;
}

const ROADMAP = {
	phases: [
		{ id: "p1", name: "Foundations and groundwork" },
		{ id: "p2", name: "Polish" },
	],
} as Roadmap;

type CardProps = Parameters<typeof SortableFeatureCard>[0];

function renderCards(features: RoadmapFeature[], props: Partial<CardProps> = {}) {
	const onClick = vi.fn();
	const utils = render(
		<TooltipProvider>
			<DndContext>
				<SortableContext items={features.map((f) => f.id)}>
					{features.map((feature) => (
						<SortableFeatureCard
							key={feature.id}
							feature={feature}
							roadmap={ROADMAP}
							onClick={onClick}
							{...props}
						/>
					))}
				</SortableContext>
			</DndContext>
		</TooltipProvider>,
	);
	return { ...utils, onClick };
}

/** The sortable wrapper (drag handle) around a card, found by its title. */
function handleOf(title: string): HTMLElement {
	return screen
		.getByRole("heading", { name: title })
		.closest('[aria-roledescription="sortable"]') as HTMLElement;
}

// jsdom lays nothing out; stack the cards 100px apart so dnd-kit can tell
// which one the dragged card is over.
const realRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
	Element.prototype.getBoundingClientRect = function (this: Element) {
		const title = this.querySelector?.("h3")?.textContent;
		const index = title === "Dark mode" ? 0 : title === "Offline mode" ? 1 : -1;
		if (index < 0) return realRect.call(this);
		const top = index * 100;
		return {
			x: 0,
			y: top,
			top,
			left: 0,
			width: 200,
			height: 100,
			right: 200,
			bottom: top + 100,
			toJSON: () => ({}),
		} as DOMRect;
	};
});
afterAll(() => {
	Element.prototype.getBoundingClientRect = realRect;
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("SortableFeatureCard — content", () => {
	it("shows the priority, the phase, the title, the description and translated levels", () => {
		renderCards([makeFeature()]);
		expect(screen.getByText("Must have")).toBeInTheDocument();
		expect(screen.getByText("Foundations ...")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Dark mode" })).toBeInTheDocument();
		expect(screen.getByText("Let people pick a dark theme")).toBeInTheDocument();
		expect(screen.getByText("Low complexity")).toBeInTheDocument();
		expect(screen.getByText("High impact")).toBeInTheDocument();
		expect(screen.queryByText("low")).not.toBeInTheDocument();
		expect(screen.queryByText("high")).not.toBeInTheDocument();
	});

	it("names the whole phase on hover, and a short one in full", async () => {
		renderCards([makeFeature({ phaseId: "p2", complexity: "high", impact: "low" })]);
		const badge = screen.getByText("Polish");
		fireEvent.focus(badge);
		expect((await screen.findAllByText("Phase: Polish")).length).toBeGreaterThan(0);
		expect(screen.getByText("High complexity")).toBeInTheDocument();
		expect(screen.getByText("Low impact")).toBeInTheDocument();
	});

	it("shows no phase without a roadmap or for an unknown phase", () => {
		render(
			<TooltipProvider>
				<DndContext>
					<SortableContext items={["f1"]}>
						<SortableFeatureCard
							feature={makeFeature({ phaseId: "gone", complexity: "medium", impact: "medium" })}
							onClick={vi.fn()}
						/>
					</SortableContext>
				</DndContext>
			</TooltipProvider>,
		);
		expect(screen.queryByText(/^Phase/)).not.toBeInTheDocument();
		expect(screen.getByText("Medium complexity")).toBeInTheDocument();
		expect(screen.getByText("Medium impact")).toBeInTheDocument();
	});

	it("flags a feature that answers competitors", async () => {
		renderCards([makeFeature({ competitorInsightIds: ["c1"] })]);
		const badge = document.querySelector(".lucide-trending-up")?.closest(
			"div",
		) as HTMLElement;
		fireEvent.focus(badge);
		expect(
			(
				await screen.findAllByText(
					"This feature addresses competitor pain points",
				)
			).length,
		).toBeGreaterThan(0);
	});

	it("shows no competitor flag for an empty list", () => {
		renderCards([makeFeature({ competitorInsightIds: [] })]);
		expect(document.querySelector(".lucide-trending-up")).toBeNull();
	});
});

describe("SortableFeatureCard — imported features", () => {
	it("shows the votes and Canny as the source", async () => {
		renderCards([
			makeFeature({ votes: 12, source: { provider: "canny" } }),
		]);
		fireEvent.focus(screen.getByText("12"));
		expect(
			(await screen.findAllByText("12 votes from user feedback")).length,
		).toBeGreaterThan(0);
		fireEvent.focus(screen.getByText("Canny"));
		expect(
			(await screen.findAllByText("Imported from Canny")).length,
		).toBeGreaterThan(0);
	});

	it("names GitHub, not its code, as the source of an imported issue", async () => {
		renderCards([makeFeature({ votes: 0, source: { provider: "github_issue" } })]);
		expect(screen.queryByText("0")).not.toBeInTheDocument();
		fireEvent.focus(screen.getByText("External"));
		expect(
			(await screen.findAllByText("Imported from GitHub")).length,
		).toBeGreaterThan(0);
		expect(screen.queryByText(/github_issue/)).not.toBeInTheDocument();
	});

	it("names a source it does not know as the roadmap file wrote it", async () => {
		renderCards([
			makeFeature({ source: { provider: "jira" as never } }),
		]);
		fireEvent.focus(screen.getByText("External"));
		expect(
			(await screen.findAllByText("Imported from jira")).length,
		).toBeGreaterThan(0);
	});

	it("does not mark a feature written in the app", () => {
		renderCards([makeFeature({ source: { provider: "internal" } })]);
		expect(screen.queryByText("External")).not.toBeInTheDocument();
		expect(screen.queryByText("Canny")).not.toBeInTheDocument();
	});
});

describe("SortableFeatureCard — actions", () => {
	it("opens the feature on click", () => {
		const { onClick } = renderCards([makeFeature()]);
		fireEvent.click(screen.getByRole("heading", { name: "Dark mode" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("builds a feature into a task without opening it", () => {
		const onConvertToSpec = vi.fn();
		const feature = makeFeature();
		const { onClick } = renderCards([feature], { onConvertToSpec });
		fireEvent.click(screen.getByRole("button", { name: "Build" }));
		expect(onConvertToSpec).toHaveBeenCalledWith(feature);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("offers no build for a done feature or without a handler", () => {
		const { unmount } = renderCards([makeFeature({ status: "done" })], {
			onConvertToSpec: vi.fn(),
		});
		expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
		unmount();
		renderCards([makeFeature()]);
		expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
	});

	it("goes to the linked task without opening the feature", () => {
		const onGoToTask = vi.fn();
		const { onClick } = renderCards([makeFeature({ linkedSpecId: "007-dark" })], {
			onGoToTask,
			onConvertToSpec: vi.fn(),
		});
		expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Task" }));
		expect(onGoToTask).toHaveBeenCalledWith("007-dark");
		expect(onClick).not.toHaveBeenCalled();
	});

	it("shows the linked task even when nothing can open it", () => {
		renderCards([makeFeature({ linkedSpecId: "007-dark" })]);
		fireEvent.click(screen.getByRole("button", { name: "Task" }));
		expect(screen.getByRole("button", { name: "Task" })).toBeInTheDocument();
	});
});

describe("SortableFeatureCard — drag", () => {
	it("fades the dragged card and rings the one it is over", async () => {
		renderCards([makeFeature(), makeFeature({ id: "f2", title: "Offline mode" })]);
		const dragged = handleOf("Dark mode");
		const target = handleOf("Offline mode");
		await act(async () => {
			fireEvent.keyDown(dragged, { code: "Space", key: " " });
		});
		expect(dragged).toHaveClass("opacity-40");
		expect(dragged.style.zIndex).toBe("50");
		expect(target).not.toHaveClass("ring-2");
		for (let i = 0; i < 4; i++) {
			await act(async () => {
				fireEvent.keyDown(dragged, { code: "ArrowDown", key: "ArrowDown" });
			});
		}
		expect(target).toHaveClass("ring-2");
		expect(dragged).not.toHaveClass("ring-2");
		await act(async () => {
			fireEvent.keyDown(dragged, { code: "Escape", key: "Escape" });
		});
		expect(dragged).not.toHaveClass("opacity-40");
		expect(target).not.toHaveClass("ring-2");
	});
});
