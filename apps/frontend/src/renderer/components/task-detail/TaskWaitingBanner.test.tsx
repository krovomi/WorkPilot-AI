/**
 * @vitest-environment jsdom
 *
 * "Waiting for you": the items come and go with the state the stores hold,
 * no item means no banner, and an item leads to the card that handles it.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import type { TaskPermissionRequest } from "../../../shared/types/task-permission";

vi.mock("./SpecInterviewDialog", () => ({ SpecInterviewBanner: () => null }));
vi.mock("./ExecutionFormulaBanner", () => ({ ExecutionFormulaBanner: () => null }));
vi.mock("./TaskMetadata", () => ({ TaskMetadata: () => <p>the description</p> }));
vi.mock("./GoalCard", () => ({ GoalCard: () => <p>goal card</p> }));
vi.mock("./PrFollowupCard", () => ({ PrFollowupCard: () => null }));
vi.mock("./BestOfNCard", () => ({ BestOfNCard: () => null }));
vi.mock("./McpAppsCard", () => ({ McpAppsCard: () => null }));
vi.mock("./TaskJevCard", () => ({ TaskJevCard: () => null }));
vi.mock("./SpecTraceabilityCard", () => ({ SpecTraceabilityCard: () => null }));
vi.mock("./UiUxDesignCard", () => ({ UiUxDesignCard: () => null }));
vi.mock("./VisualReviewCard", () => ({ VisualReviewCard: () => null }));
vi.mock("./VerifyLoopCard", () => ({ VerifyLoopCard: () => null }));
vi.mock("./WorkflowProfileCard", () => ({ WorkflowProfileCard: () => null }));
vi.mock("./DocumentInsightsCard", () => ({ DocumentInsightsCard: () => null }));
vi.mock("./HermesLearningCard", () => ({ HermesLearningCard: () => null }));
vi.mock("./BrainTaskCard", () => ({ BrainTaskCard: () => null }));
vi.mock("./RtkSavingsCard", () => ({ RtkSavingsCard: () => null }));

import { usePrFollowupStore } from "../../stores/pr-followup-store";
import { useTaskPanelStore } from "../../stores/task-panel-store";
import { useTaskPermissionStore } from "../../stores/task-permission-store";
import { useTaskStore } from "../../stores/task-store";
import { TaskOverview } from "./TaskOverview";
import { TaskWaitingBanner } from "./TaskWaitingBanner";

const task = {
	id: "t1",
	specId: "001",
	status: "backlog",
	subtasks: [],
	logs: [],
} as unknown as Task;

const question: TaskPermissionRequest = {
	taskId: "t1",
	requestId: "r1",
	agent: "Gemini CLI",
	title: "Run the migration?",
	kind: "execute",
	options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
	locations: [],
	expiresAt: "2026-11-02T09:00:00Z",
};

const banner = () => screen.queryByRole("region", { name: "Waiting for you" });

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useTaskPermissionStore.setState({ byTask: {} });
	useTaskStore.setState({ pipelineStatuses: {} });
	usePrFollowupStore.setState({ byTask: {} });
	useTaskPanelStore.setState({ section: "progress", pendingReveal: null });
});
afterEach(cleanup);

describe("TaskWaitingBanner", () => {
	it("renders no banner when nothing waits for the person", () => {
		render(<TaskWaitingBanner task={task} onShowOverview={vi.fn()} />);
		expect(banner()).toBeNull();
	});

	it("shows an agent's question while it waits, and drops it once answered", () => {
		render(<TaskWaitingBanner task={task} onShowOverview={vi.fn()} />);
		act(() => useTaskPermissionStore.getState().add(question));
		expect(
			within(banner() as HTMLElement).getByRole("button", {
				name: "An agent is waiting for your answer to a question",
			}),
		).toBeInTheDocument();
		act(() => useTaskPermissionStore.getState().remove("t1", "r1"));
		expect(banner()).toBeNull();
	});

	it("shows a red CI pushed by the pipeline poller, not while a repair runs", () => {
		render(<TaskWaitingBanner task={task} onShowOverview={vi.fn()} />);
		const status = { taskId: "t1", projectId: "p1", state: "failed", checkedAt: "now" } as const;
		act(() => useTaskStore.getState().setPipelineStatus(status));
		expect(screen.getByRole("button", { name: "CI is red on the task's branch" })).toBeInTheDocument();
		act(() => useTaskStore.getState().setPipelineStatus({ ...status, autoFixInProgress: true }));
		expect(banner()).toBeNull();
	});

	it("follows the task: a plan to approve, then nothing once it is approved", () => {
		const { rerender } = render(
			<TaskWaitingBanner
				task={{ ...task, status: "human_review", reviewReason: "plan_review" }}
				onShowOverview={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "A plan is waiting for your approval" })).toBeInTheDocument();
		rerender(<TaskWaitingBanner task={{ ...task, status: "in_progress" }} onShowOverview={vi.fn()} />);
		expect(banner()).toBeNull();
	});

	it("leads a failed build to the failure banner below it", () => {
		const failed = { ...task, status: "error", errorMessage: "planner gave up" } as Task;
		render(<TaskWaitingBanner task={failed} onShowOverview={vi.fn()} />);
		const target = screen.getByText("planner gave up").closest("[tabindex='-1']") as HTMLElement;
		target.scrollIntoView = vi.fn();
		fireEvent.click(screen.getByRole("button", { name: "The build failed: see why" }));
		expect(target.scrollIntoView).toHaveBeenCalled();
		expect(target).toHaveFocus();
	});

	it("opens the tab of the card that handles an item, and brings the card into view", () => {
		useTaskPanelStore.setState({ section: "costs" });
		const onShowOverview = vi.fn();
		const unmet = { ...task, status: "done", goal: { status: "unmet", reason: "exit 1" } } as Task;
		render(
			<>
				<TaskWaitingBanner task={unmet} onShowOverview={onShowOverview} />
				<TaskOverview task={unmet} />
			</>,
		);
		expect(screen.getByRole("tab", { name: /Costs & context/ })).toHaveAttribute("aria-selected", "true");

		fireEvent.click(screen.getByRole("button", { name: "The goal is not met" }));

		expect(onShowOverview).toHaveBeenCalled();
		expect(screen.getByRole("tab", { name: /Progress/ })).toHaveAttribute("aria-selected", "true");
		const slot = screen.getByText("goal card").closest("[data-panel-card]");
		expect(slot).toHaveAttribute("data-panel-card", "goal");
		expect(slot).toHaveFocus();
		expect(useTaskPanelStore.getState().pendingReveal).toBeNull();
	});
});
