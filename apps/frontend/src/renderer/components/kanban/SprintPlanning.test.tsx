/**
 * The board's sprint banner and the sprint planning view: the active sprint
 * named above the board, its cards shown on demand, and cards moved between
 * the backlog and the sprint.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Sprint, Task } from "../../../shared/types";
import { EMPTY_FILTERS, NO_SPRINT } from "../../lib/kanban-filter";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useProjectStore } from "../../stores/project-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { SprintBanner } from "./SprintBanner";
import { SprintEditDialog } from "./SprintDialogs";
import { SprintPlanningDialog } from "./SprintPlanningDialog";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../hooks/use-toast", () => ({ toast }));

const ACTIVE: Sprint = {
	id: "sp-0000000a",
	name: "Sprint-01",
	goal: "Checkout ready",
	state: "active",
	createdAt: "t",
	startDate: "2026-11-28",
	endDate: "2026-12-02",
};
const PLANNED: Sprint = { id: "sp-0000000b", name: "Sprint-02", state: "planned", createdAt: "t" };
const CLOSED: Sprint = {
	id: "sp-0000000c",
	name: "Sprint-00",
	state: "closed",
	createdAt: "t",
	closedAt: "2026-11-27",
	report: { done: 2, donePoints: 5, carried: 0, carriedPoints: 0, carriedTo: null },
};

const card = (id: string, status: Task["status"], sprintId?: string, score?: number) =>
	({
		id,
		specId: id,
		title: `Card ${id}`,
		status,
		createdAt: "2026-11-01T00:00:00Z",
		metadata: { sprintId, smartEstimate: score ? { complexityScore: score } : undefined },
	}) as unknown as Task;

const updateTask = vi.fn(async (id: string, updates: { metadata?: object }) => {
	const task = useTaskStore.getState().tasks.find((t) => t.id === id);
	return { success: true, data: { ...task, metadata: { ...task?.metadata, ...updates.metadata } } };
});
const saveSprint = vi.fn(async (_projectId: string, draft: Sprint) => ({
	success: true,
	data: useSprintStore.getState().sprints.map((sprint) => (sprint.id === draft.id ? { ...sprint, ...draft } : sprint)),
}));

function project(role?: "viewer" | "member"): Project {
	return { id: "p1", name: "P", path: "/p", remote: role ? { role } : undefined } as unknown as Project;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-28T12:00:00") });
	updateTask.mockClear();
	saveSprint.mockClear();
	toast.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = { updateTask, saveSprint };
	useProjectStore.setState({ projects: [project()], selectedProjectId: "p1" });
	useTaskStore.setState({
		tasks: [
			card("a", "done", ACTIVE.id, 3),
			card("b", "backlog", undefined, 8),
			card("c", "in_progress"),
			card("d", "done"),
		],
	});
	useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS } });
	useSprintStore.setState({ projectId: "p1", sprints: [ACTIVE, PLANNED, CLOSED], planningId: null });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function board() {
	return render(
		<>
			<SprintBanner />
			<SprintPlanningDialog />
		</>,
	);
}

describe("SprintBanner", () => {
	it("names the active sprint above the board with its days, days left and progress", () => {
		board();
		const banner = screen.getByTestId("kanban-sprint-banner");
		expect(within(banner).getByText("Sprint-01")).toBeInTheDocument();
		expect(within(banner).getByText("Checkout ready")).toBeInTheDocument();
		expect(within(banner).getByText("4 days left")).toBeInTheDocument();
		expect(within(banner).getByText("1/1 cards · 3/3 pts")).toBeInTheDocument();
	});

	it("shows only the sprint's cards, then every card again", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		board();
		await user.click(screen.getByRole("button", { name: "Show only this sprint" }));
		expect(useKanbanFilterStore.getState().filters.sprint).toBe(ACTIVE.id);
		await user.click(screen.getByRole("button", { name: "Show every card" }));
		expect(useKanbanFilterStore.getState().filters.sprint).toBeUndefined();
	});

	it("talks about the filtered sprint, says when an empty one needs planning, and hides on the backlog", () => {
		useKanbanFilterStore.setState({ filters: { ...EMPTY_FILTERS, sprint: PLANNED.id } });
		const { rerender } = board();
		const banner = screen.getByTestId("kanban-sprint-banner");
		expect(within(banner).getByText("Sprint-02")).toBeInTheDocument();
		expect(within(banner).getByText("No card in this sprint yet: plan it to add some.")).toBeInTheDocument();
		// Another sprint is active: this one cannot start yet.
		expect(within(banner).getByRole("button", { name: /Start/ })).toBeDisabled();

		useKanbanFilterStore.setState({ filters: { ...EMPTY_FILTERS, sprint: NO_SPRINT } });
		rerender(
			<>
				<SprintBanner />
				<SprintPlanningDialog />
			</>,
		);
		expect(screen.queryByTestId("kanban-sprint-banner")).toBeNull();
	});

	it("shows nothing without a sprint to talk about", () => {
		useSprintStore.setState({ sprints: [PLANNED] });
		board();
		expect(screen.queryByTestId("kanban-sprint-banner")).toBeNull();
	});

	it("gives a viewer of a server project the sprint without the planning or closing actions", () => {
		useProjectStore.setState({ projects: [project("viewer")] });
		board();
		expect(screen.getByText("Sprint-01")).toBeInTheDocument();
		expect(screen.queryByTestId("kanban-sprint-plan")).toBeNull();
		expect(screen.queryByRole("button", { name: /Complete sprint/ })).toBeNull();
	});
});

describe("SprintPlanningDialog", () => {
	it("opens from the banner with the open backlog cards on one side and the sprint's on the other", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		board();
		await user.click(screen.getByTestId("kanban-sprint-plan"));
		const backlog = screen.getByTestId("sprint-planning-backlog");
		const sprint = screen.getByTestId("sprint-planning-sprint");
		// The finished card « d » is not offered.
		expect(within(backlog).getByText("Card b")).toBeInTheDocument();
		expect(within(backlog).getByText("Card c")).toBeInTheDocument();
		expect(within(backlog).queryByText("Card d")).toBeNull();
		expect(within(sprint).getByText("Card a")).toBeInTheDocument();
		// The velocity of the closed sprint is 5 pts; the sprint holds 3.
		const gauge = screen.getByTestId("sprint-capacity");
		expect(within(gauge).getByText("/ 5 pts")).toBeInTheDocument();
		expect(within(gauge).getByTestId("sprint-capacity-verdict")).toHaveTextContent("2 pts of room");
	});

	it("adds ticked cards to the sprint, warns past the velocity, and sends one back", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		await user.click(within(backlog).getByRole("checkbox", { name: "Card b" }));
		await user.click(within(backlog).getByRole("checkbox", { name: "Card c" }));
		await user.click(within(backlog).getByRole("button", { name: "Add 2 cards to the sprint" }));
		await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(2));
		expect(updateTask).toHaveBeenCalledWith("b", { metadata: { sprintId: ACTIVE.id } });
		const sprint = screen.getByTestId("sprint-planning-sprint");
		await waitFor(() => expect(within(sprint).getByText("Card b")).toBeInTheDocument());
		expect(screen.getByTestId("sprint-capacity-verdict")).toHaveTextContent("6 pts over");
		expect(screen.getByRole("status")).toHaveTextContent("2 cards added to the sprint");

		const row = within(sprint).getByText("Card c").closest("li") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Back to the backlog" }));
		await waitFor(() => expect(updateTask).toHaveBeenLastCalledWith("c", { metadata: { sprintId: undefined } }));
		await waitFor(() => expect(within(backlog).getByText("Card c")).toBeInTheDocument());
	});

	it("searches the backlog and switches to another open sprint", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		await user.type(within(backlog).getByLabelText("Search the backlog"), "zzz");
		expect(within(backlog).getByText("No backlog card matches this search.")).toBeInTheDocument();
		// Only the open sprints are offered; the closed one is not.
		expect(screen.queryByRole("button", { name: "Sprint-00" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Sprint-02" }));
		expect(useSprintStore.getState().planningId).toBe(PLANNED.id);
		expect(screen.getByRole("heading", { name: "Plan « Sprint-02 »" })).toBeInTheDocument();
		expect(within(screen.getByTestId("sprint-planning-sprint")).getByText(/This sprint has no card yet/)).toBeInTheDocument();
	});

	it("tells the person when a card could not be moved", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		updateTask.mockResolvedValueOnce({ success: false } as never);
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		const row = within(backlog).getByText("Card b").closest("li") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Add to the sprint" }));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 card could not be moved: the sprint was not changed." })),
		);
	});

	it("does not open on a closed sprint", () => {
		useSprintStore.setState({ planningId: CLOSED.id });
		board();
		expect(screen.queryByTestId("sprint-planning")).toBeNull();
		expect(useSprintStore.getState().planningId).toBeNull();
	});

	it("opens on a sprint right after it is created", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		const created: Sprint = { id: "sp-0000000d", name: "Sprint-03", state: "planned", createdAt: "t" };
		saveSprint.mockResolvedValueOnce({ success: true, data: [ACTIVE, PLANNED, CLOSED, created] });
		render(
			<>
				<SprintEditDialog open onOpenChange={() => undefined} />
				<SprintPlanningDialog />
			</>,
		);
		await user.type(screen.getByLabelText("Name"), "Sprint-03");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(useSprintStore.getState().planningId).toBe(created.id));
		expect(await screen.findByRole("heading", { name: "Plan « Sprint-03 »" })).toBeInTheDocument();
	});
});

describe("SprintPlanningDialog, planning helps", () => {
	it("moves the ticked cards together by dragging them to the sprint, then undoes the move", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		const sprint = screen.getByTestId("sprint-planning-sprint");
		await user.click(within(backlog).getByRole("checkbox", { name: "Card b" }));
		await user.click(within(backlog).getByRole("checkbox", { name: "Card c" }));
		const data = new Map<string, string>();
		const dataTransfer = {
			setData: (type: string, value: string) => data.set(type, value),
			getData: (type: string) => data.get(type) ?? "",
			get types() {
				return [...data.keys()];
			},
			effectAllowed: "",
			dropEffect: "",
		};
		const row = within(backlog).getByText("Card b").closest("li") as HTMLElement;
		fireEvent.dragStart(row, { dataTransfer });
		fireEvent.dragOver(sprint, { dataTransfer });
		expect(sprint).toHaveAttribute("data-drop-over", "true");
		fireEvent.drop(sprint, { dataTransfer });
		await waitFor(() => expect(within(sprint).getByText("Card c")).toBeInTheDocument());
		expect(within(sprint).getByText("Card b")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(within(backlog).getByText("Card b")).toBeInTheDocument());
		expect(within(backlog).getByText("Card c")).toBeInTheDocument();
	});

	it("sends a card across with the arrow key", async () => {
		vi.useRealTimers();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		fireEvent.keyDown(within(backlog).getByRole("button", { name: "Card b" }), { key: "ArrowRight" });
		await waitFor(() => expect(updateTask).toHaveBeenCalledWith("b", { metadata: { sprintId: ACTIVE.id } }));
	});

	it("filters the backlog to the cards without an estimate, which offer « Estimate »", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		await user.click(within(backlog).getByRole("button", { name: "Not estimated · 1" }));
		expect(within(backlog).queryByText("Card b")).toBeNull();
		const row = within(backlog).getByText("Card c").closest("li") as HTMLElement;
		expect(within(row).getByRole("button", { name: "Estimate" })).toBeInTheDocument();
	});

	it("marks a card carried over and one waiting on a backlog card, and adds the missing one", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		const closing: Sprint = { ...CLOSED, report: { ...(CLOSED.report as NonNullable<Sprint["report"]>), carriedTo: ACTIVE.id } };
		useSprintStore.setState({ sprints: [ACTIVE, PLANNED, closing], planningId: ACTIVE.id });
		const carried = card("e", "in_progress", ACTIVE.id, 2);
		carried.metadata = { ...carried.metadata, carriedFrom: CLOSED.id, blockedBy: ["b"] };
		useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks, carried] });
		board();
		const sprint = screen.getByTestId("sprint-planning-sprint");
		expect(within(sprint).getByText("Carried over from Sprint-00")).toBeInTheDocument();
		expect(within(sprint).getByText("Waits on « Card b »")).toBeInTheDocument();
		const missing = screen.getByTestId("sprint-planning-missing");
		await user.click(within(missing).getByRole("button", { name: "Add it too" }));
		await waitFor(() => expect(within(sprint).getByText("Card b")).toBeInTheDocument());
		expect(screen.queryByTestId("sprint-planning-missing")).toBeNull();
	});

	it("lowers the capacity below the velocity, then goes back to it", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const gauge = screen.getByTestId("sprint-capacity");
		expect(within(gauge).getByText("100 %")).toBeInTheDocument();
		await user.click(within(gauge).getByRole("button", { name: "Lower the capacity" }));
		await waitFor(() => expect(saveSprint).toHaveBeenCalledWith("p1", expect.objectContaining({ id: ACTIVE.id, capacity: 4 })));
		expect(await within(gauge).findByText("80 %")).toBeInTheDocument();
		await user.click(within(gauge).getByRole("button", { name: "Back to the velocity" }));
		await waitFor(() => expect(saveSprint).toHaveBeenLastCalledWith("p1", expect.objectContaining({ capacity: null })));
	});

	it("gives a first sprint a target instead of a velocity, and starts a planned sprint from the view", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		const startSprint = vi.fn(async () => ({ success: true, data: [{ ...PLANNED, state: "active" }] }));
		(globalThis as { electronAPI?: unknown }).electronAPI = { updateTask, saveSprint, startSprint };
		useSprintStore.setState({ sprints: [PLANNED], planningId: PLANNED.id });
		useTaskStore.setState({ tasks: [card("f", "backlog", PLANNED.id, 5)] });
		board();
		const gauge = screen.getByTestId("sprint-capacity");
		expect(within(gauge).getByText(/No sprint finished yet: the target is 20 pts/)).toBeInTheDocument();
		expect(within(gauge).getAllByText("Target").length).toBeGreaterThan(0);
		await user.click(screen.getByRole("button", { name: "Start the sprint" }));
		await waitFor(() => expect(startSprint).toHaveBeenCalledWith("p1", PLANNED.id, { cards: 1, points: 5 }));
	});

	it("lets a viewer of a server project read the plan without moving anything", () => {
		useProjectStore.setState({ projects: [project("viewer")] });
		useSprintStore.setState({ planningId: ACTIVE.id });
		board();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		expect(within(backlog).getByText("Card b")).toBeInTheDocument();
		expect(within(backlog).queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Lower the capacity" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Start the sprint" })).toBeNull();
	});
});
