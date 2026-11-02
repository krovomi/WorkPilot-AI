/**
 * @vitest-environment jsdom
 *
 * The Overview tab, in three tabs: Progress, Quality, Costs & context.
 *
 * The cards are stubbed: each one has its own tests. Under test here is the
 * layout — which tab a card lands in, a card with nothing to show leaving no
 * slot, a tab whose cards are all silent saying so, the keyboard, and the tab
 * kept for the session.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const show = { goal: true, jev: true, hermes: true, rtk: false };

vi.mock("./SpecInterviewDialog", () => ({ SpecInterviewBanner: () => null }));
vi.mock("./ExecutionFormulaBanner", () => ({ ExecutionFormulaBanner: () => null }));
vi.mock("../task-permission/TaskPermissionPrompt", () => ({ TaskPermissionPrompt: () => null }));
vi.mock("./CiPipelineCard", () => ({ CiPipelineCard: () => null }));
vi.mock("./PrFollowupCard", () => ({ PrFollowupCard: () => null }));
vi.mock("./TaskMetadata", () => ({ TaskMetadata: () => <p>the description</p> }));
vi.mock("./GoalCard", () => ({ GoalCard: () => (show.goal ? <p>goal card</p> : null) }));
vi.mock("./BestOfNCard", () => ({ BestOfNCard: () => null }));
vi.mock("./McpAppsCard", () => ({ McpAppsCard: () => null }));
vi.mock("./TaskJevCard", () => ({ TaskJevCard: () => (show.jev ? <p>jev card</p> : null) }));
vi.mock("./SpecTraceabilityCard", () => ({ SpecTraceabilityCard: () => null }));
vi.mock("./UiUxDesignCard", () => ({ UiUxDesignCard: () => null }));
vi.mock("./VisualReviewCard", () => ({ VisualReviewCard: () => null }));
vi.mock("./VerifyLoopCard", () => ({ VerifyLoopCard: () => null }));
vi.mock("./WorkflowProfileCard", () => ({ WorkflowProfileCard: () => null }));
vi.mock("./DocumentInsightsCard", () => ({ DocumentInsightsCard: () => null }));
vi.mock("./HermesLearningCard", () => ({
	HermesLearningCard: () => (show.hermes ? <p>hermes inbox</p> : null),
}));
vi.mock("./BrainTaskCard", () => ({ BrainTaskCard: () => null }));
vi.mock("./RtkSavingsCard", () => ({ RtkSavingsCard: () => (show.rtk ? <p>rtk savings</p> : null) }));

import { useHermesStore } from "../../stores/hermes-store";
import { useTaskPanelStore } from "../../stores/task-panel-store";
import { TaskOverview } from "./TaskOverview";

const task = { id: "t1", specId: "001" } as unknown as Task;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	Object.assign(show, { goal: true, jev: true, hermes: true, rtk: false });
	useHermesStore.getState().reset();
	useTaskPanelStore.setState({ section: "progress", pendingReveal: null });
});
afterEach(cleanup);

const panel = (name: string) => {
	const tab = screen.getByRole("tab", { name: new RegExp(name) });
	const id = tab.getAttribute("aria-controls");
	const el = id ? document.getElementById(id) : null;
	if (!el) throw new Error(`no panel for ${name}`);
	return el;
};

it("offers three tabs, Progress selected first", () => {
	render(<TaskOverview task={task} />);
	const tabs = within(screen.getByRole("tablist", { name: "Task panel sections" })).getAllByRole("tab");
	expect(tabs.map((tab) => tab.textContent)).toEqual(["Progress", "Quality", "Costs & context"]);
	expect(tabs[0]).toHaveAttribute("aria-selected", "true");
	expect(screen.getByRole("tabpanel")).toBe(panel("Progress"));
});

it("puts each card in its tab", () => {
	render(<TaskOverview task={task} review={<p>review panel</p>} />);
	expect(within(panel("Progress")).getByText("review panel")).toBeInTheDocument();
	expect(within(panel("Progress")).getByText("the description")).toBeInTheDocument();
	expect(within(panel("Progress")).getByText("goal card")).toBeInTheDocument();
	expect(within(panel("Quality")).getByText("jev card")).toBeInTheDocument();
	expect(within(panel("Costs & context")).getByText("hermes inbox")).toBeInTheDocument();
	// The inactive tabs stay mounted, hidden: their cards load once and can be reached.
	expect(panel("Quality")).not.toBeVisible();
});

it("leaves no slot for a card with nothing to show", () => {
	show.goal = false;
	render(<TaskOverview task={task} />);
	const slots = [...panel("Progress").querySelectorAll("[data-panel-card]")];
	const visible = slots.filter((slot) => !slot.hasAttribute("hidden")).map((slot) => slot.getAttribute("data-panel-card"));
	expect(visible).toEqual(["task"]);
	expect(panel("Progress").querySelector('[data-panel-card="goal"]')).toHaveAttribute("hidden");
});

it("says a tab whose cards are all silent has nothing to show", () => {
	show.jev = false;
	render(<TaskOverview task={task} />);
	expect(within(panel("Quality")).getByText("Nothing to show here for this task yet.")).toBeInTheDocument();
	expect(within(panel("Progress")).queryByText("Nothing to show here for this task yet.")).toBeNull();
});

it("moves between tabs with the arrows, Home and End, one tab in the Tab order", () => {
	render(<TaskOverview task={task} />);
	const progress = screen.getByRole("tab", { name: /Progress/ });
	const quality = screen.getByRole("tab", { name: /Quality/ });
	const costs = screen.getByRole("tab", { name: /Costs & context/ });
	expect([progress, quality, costs].map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

	progress.focus();
	fireEvent.keyDown(progress, { key: "ArrowRight" });
	expect(quality).toHaveAttribute("aria-selected", "true");
	expect(quality).toHaveFocus();
	expect(panel("Quality")).toBeVisible();

	fireEvent.keyDown(quality, { key: "End" });
	expect(costs).toHaveFocus();
	fireEvent.keyDown(costs, { key: "ArrowRight" });
	expect(progress).toHaveFocus();
	fireEvent.keyDown(progress, { key: "ArrowLeft" });
	expect(costs).toHaveFocus();
	fireEvent.keyDown(costs, { key: "Home" });
	expect(progress).toHaveFocus();
	expect([progress, quality, costs].map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
});

it("keeps the tab for the session: the next task opens on it", () => {
	const { unmount } = render(<TaskOverview task={task} />);
	fireEvent.click(screen.getByRole("tab", { name: /Costs & context/ }));
	unmount();
	render(<TaskOverview task={{ ...task, id: "t2" } as Task} />);
	expect(screen.getByRole("tab", { name: /Costs & context/ })).toHaveAttribute("aria-selected", "true");
});

it("shows the pending decisions on the Costs & context tab", () => {
	useHermesStore.setState({
		status: { readiness: { installed: true }, pending: ["a", "b"] },
	} as unknown as Parameters<typeof useHermesStore.setState>[0]);
	render(<TaskOverview task={task} />);
	expect(screen.getByRole("tab", { name: /Costs & context.*2 decisions waiting/ })).toBeInTheDocument();
});

it("keeps the tabs outside the scrolling area", () => {
	render(<TaskOverview task={task} />);
	expect(screen.getByRole("tablist").closest("[data-radix-scroll-area-viewport]")).toBeNull();
	expect(screen.getByText("the description").closest("[data-radix-scroll-area-viewport]")).not.toBeNull();
});
