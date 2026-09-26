/**
 * The Overview tab, ordered by the question a person is asking.
 *
 * The cards are stubbed: each one has its own tests, and what is under test
 * here is the layout — the order of the sections, a section vanishing with its
 * title when every card in it has nothing to say, and the navigation bar
 * following suit.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const show = { plan: true, learning: true };

vi.mock("./SpecInterviewDialog", () => ({ SpecInterviewBanner: () => null }));
vi.mock("./ExecutionFormulaBanner", () => ({ ExecutionFormulaBanner: () => null }));
vi.mock("./TaskMetadata", () => ({ TaskMetadata: () => <p>the description</p> }));
vi.mock("./WorkflowProfileCard", () => ({
	WorkflowProfileCard: () => (show.plan ? <p>workflow profile</p> : null),
}));
vi.mock("./TaskJevCard", () => ({ TaskJevCard: () => null }));
vi.mock("./SpecTraceabilityCard", () => ({ SpecTraceabilityCard: () => null }));
vi.mock("./DocumentInsightsCard", () => ({ DocumentInsightsCard: () => null }));
vi.mock("./HermesLearningCard", () => ({
	HermesLearningCard: () => (show.learning ? <p>hermes inbox</p> : null),
}));
vi.mock("./BrainTaskCard", () => ({ BrainTaskCard: () => null }));
vi.mock("./RtkSavingsCard", () => ({ RtkSavingsCard: () => null }));

import { useHermesStore } from "../../stores/hermes-store";
import { TaskOverview } from "./TaskOverview";

const task = { id: "t1", specId: "001" } as unknown as Task;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	show.plan = true;
	show.learning = true;
	useHermesStore.getState().reset();
});
afterEach(cleanup);

const headings = () =>
	screen
		.getAllByRole("heading", { level: 2 })
		.filter((h) => !h.closest("[hidden]"))
		.map((h) => h.textContent);

it("puts the review first, then the task, the plan and what is learned", () => {
	render(<TaskOverview task={task} review={<p>review panel</p>} />);
	expect(headings()).toEqual(["To do", "The task", "Execution plan", "Memory & learning"]);
});

it("has no review section when the task is not waiting for one", () => {
	render(<TaskOverview task={task} />);
	expect(headings()).toEqual(["The task", "Execution plan", "Memory & learning"]);
});

it("hides a section whose cards all have nothing to say, and its shortcut", async () => {
	show.plan = false;
	render(<TaskOverview task={task} />);
	expect(headings()).toEqual(["The task", "Memory & learning"]);
	const nav = screen.getByRole("navigation", { name: "Overview sections" });
	expect(within(nav).queryByRole("button", { name: /Execution plan/ })).toBeNull();
	expect(within(nav).getByRole("button", { name: /Memory & learning/ })).toBeInTheDocument();
});

it("jumps to a section from the navigation bar", () => {
	render(<TaskOverview task={task} />);
	const nav = screen.getByRole("navigation", { name: "Overview sections" });
	const section = screen.getByRole("heading", { name: "Execution plan" }).closest("section");
	if (!section) throw new Error("section not found");
	const scroll = vi.fn();
	section.scrollIntoView = scroll;
	within(nav).getByRole("button", { name: /Execution plan/ }).click();
	expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
});
