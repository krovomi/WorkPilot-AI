/**
 * The board cut into lanes (BoardLanes) and the toolbar menu that picks the
 * grouping (LaneGroupingMenu).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyColumnGroups } from "../../lib/kanban-columns";
import { FLAGGED_LANE, laneDropId, NO_VALUE_LANE } from "../../lib/kanban-lanes";
import { useLaneOverStore } from "../../hooks/useLaneDrag";
import { DEFAULT_LANE_PREFERENCES, useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import type { TaskStatusColumn } from "../../../shared/constants/task";
import type { Task } from "../../../shared/types";
import { BoardLanes } from "./BoardLanes";
import { LaneGroupingMenu } from "./LaneGroupingMenu";

const card = (id: string, metadata: Task["metadata"] = {}, specId = id) =>
	({ id, specId, title: `Card ${id}`, status: "backlog", metadata }) as Task;

const getProjectContext = vi.fn();
const COLUMNS: TaskStatusColumn[] = ["backlog", "done"];

function board(backlog: Task[], done: Task[] = []) {
	const tasksByStatus = { ...emptyColumnGroups(), backlog, done };
	const renderColumn = vi.fn((status: TaskStatusColumn, tasks: Task[], droppableId?: string) => (
		<div key={droppableId ?? status} data-testid={droppableId ?? status}>
			{tasks.map((task) => task.title).join(", ")}
		</div>
	));
	render(<BoardLanes projectId="p" columnOrder={COLUMNS} tasksByStatus={tasksByStatus} renderColumn={renderColumn} />);
	return renderColumn;
}

beforeEach(() => {
	localStorage.clear();
	getProjectContext.mockReset().mockResolvedValue({ success: false });
	(globalThis as { electronAPI?: unknown }).electronAPI = { getProjectContext };
	useKanbanLanesStore.setState({ ...DEFAULT_LANE_PREFERENCES, projectId: null });
	useLaneOverStore.setState({ lane: null });
	useTaskStore.setState({ tasks: [] });
});

describe("BoardLanes", () => {
	it("names a sprint's lane with its state, and an unknown sprint as such", () => {
		useSprintStore.setState({
			sprints: [
				{ id: "sp-0000000b", name: "Sprint 13", state: "planned", createdAt: "t" },
				{ id: "sp-0000000a", name: "Sprint 12", state: "active", createdAt: "t" },
			],
		});
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ grouping: "sprint" }));
		board([card("a", { sprintId: "sp-0000000a" }), card("x", { sprintId: "sp-0000000f" })]);
		const names = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
		expect(names).toEqual(["Sprint 12 · Active", "Sprint 13 · Planned", "Unknown sprint", "Backlog (no sprint)"]);
	});

	it("renders the columns in one row without a grouping", () => {
		const renderColumn = board([card("a")]);
		expect(screen.queryByTestId("kanban-lanes")).toBeNull();
		expect(screen.getByTestId("backlog")).toHaveTextContent("Card a");
		expect(renderColumn).toHaveBeenCalledWith("backlog", [expect.objectContaining({ id: "a" })]);
	});

	it("cuts the columns into priority lanes, blocked cards first", () => {
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ grouping: "priority" }));
		board([card("a", { priority: "high" }), card("b", { flagged: true }), card("c")], [card("d", { priority: "high" })]);
		const lanes = screen.getAllByRole("region");
		expect(lanes.map((lane) => lane.getAttribute("aria-label"))).toEqual([
			"Blocked",
			"Urgent",
			"High",
			"Medium",
			"Low",
			"No priority",
		]);
		const highLane = within(lanes[2]);
		expect(highLane.getByTestId(laneDropId("high", "backlog"))).toHaveTextContent("Card a");
		expect(highLane.getByTestId(laneDropId("high", "done"))).toHaveTextContent("Card d");
		expect(highLane.getByText("2")).toBeInTheDocument();
		expect(within(lanes[0]).getByTestId(laneDropId(FLAGGED_LANE, "backlog"))).toHaveTextContent("Card b");
		expect(within(lanes[5]).getByTestId(laneDropId(NO_VALUE_LANE, "backlog"))).toHaveTextContent("Card c");
	});

	it("folds a lane and remembers it", async () => {
		const user = userEvent.setup();
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ grouping: "source" }));
		board([card("a")]);
		const header = screen.getByRole("button", { name: /Manual/ });
		expect(header).toHaveAttribute("aria-expanded", "true");
		await user.click(header);
		expect(header).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId(laneDropId("manual", "backlog"))).toBeNull();
		expect(JSON.parse(localStorage.getItem("kanban-lanes-p") ?? "{}").collapsed).toEqual({ source: ["manual"] });
	});

	it("names a split task's lane after the task that was split", () => {
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ grouping: "parent" }));
		useTaskStore.setState({ tasks: [card("001-big", {})] });
		board([card("002", { splitGroup: { parent: "001-big" } } as Task["metadata"])]);
		expect(screen.getByRole("region", { name: "Card 001-big" })).toBeInTheDocument();
	});

	it("offers the project's services as sub-projects", async () => {
		getProjectContext.mockResolvedValue({
			success: true,
			data: { projectIndex: { services: { web: { name: "web", path: "apps/web" }, api: { path: "api" } } } },
		});
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ grouping: "area", areas: ["docs"] }));
		board([card("a", { area: "web" })]);
		await waitFor(() =>
			expect(screen.getAllByRole("region").map((lane) => lane.getAttribute("aria-label"))).toEqual([
				"api",
				"docs",
				"web",
				"No sub-project",
			]),
		);
		expect(getProjectContext).toHaveBeenCalledWith("p");
	});
});

describe("BoardLanes as a list", () => {
	function list(backlog: Task[], done: Task[] = []) {
		const onOpenTask = vi.fn();
		const tasksByStatus = { ...emptyColumnGroups(), backlog, done };
		render(
			<BoardLanes
				projectId="p"
				columnOrder={COLUMNS}
				tasksByStatus={tasksByStatus}
				renderColumn={() => null}
				onOpenTask={onOpenTask}
			/>,
		);
		return onOpenTask;
	}
	const titles = () =>
		within(screen.getByRole("table"))
			.queryAllByRole("row")
			.slice(1)
			.map((row) => within(row).queryAllByRole("cell")[0]?.textContent)
			.filter(Boolean);

	beforeEach(() => {
		useSprintStore.setState({ sprints: [{ id: "sp-0000000a", name: "Sprint 12", state: "active", createdAt: "t" }] });
	});

	it("shows each card's fields, opens a card and sorts by a column", async () => {
		const user = userEvent.setup();
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ layout: "list" }));
		const metadata = {
			priority: "high",
			sprintId: "sp-0000000a",
			area: "web",
			flagged: true,
			kind: "bug_fix",
			smartEstimate: { complexityScore: 3 },
		} as Task["metadata"];
		const onOpenTask = list(
			[{ ...card("b", metadata), title: "Beta", updatedAt: "2026-11-02T10:00:00Z" } as unknown as Task],
			[{ ...card("a", { sprintId: "sp-0000000f" }), title: "Alpha" } as Task],
		);
		expect(screen.queryByTestId("kanban-lanes")).toBeNull();
		expect(titles()).toEqual(["Beta", "Alpha"]);
		const [beta, alpha] = screen.getAllByRole("row").slice(1);
		expect(within(beta).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
			"Beta",
			"Planning",
			"High",
			"Sprint 12",
			"web",
			"3",
			expect.stringMatching(/2026/),
		]);
		expect(within(beta).getByLabelText("Blocked")).toBeInTheDocument();
		// The bug's colour, and a neutral dot for a card without a type.
		expect(beta.querySelector("span[style]")).not.toBeNull();
		expect(alpha.querySelector("span[style]")).toBeNull();
		expect(within(alpha).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
			"Alpha",
			"Done",
			"—",
			"Unknown sprint",
			"—",
			"—",
			"—",
		]);

		await user.click(within(alpha).getByRole("button", { name: "Alpha" }));
		expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

		const header = screen.getByRole("columnheader", { name: "Card" });
		await user.click(within(header).getByRole("button"));
		expect(header).toHaveAttribute("aria-sort", "ascending");
		expect(titles()).toEqual(["Alpha", "Beta"]);
		await user.click(within(header).getByRole("button"));
		expect(header).toHaveAttribute("aria-sort", "descending");
		expect(titles()).toEqual(["Beta", "Alpha"]);
		await user.click(within(header).getByRole("button"));
		expect(header).toHaveAttribute("aria-sort", "none");
	});

	it("cuts the list into the lanes' sections, folds one, and says when nothing matches", async () => {
		const user = userEvent.setup();
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ layout: "list", grouping: "priority" }));
		list([card("a", { priority: "high" }), card("b")]);
		const high = screen.getByRole("rowgroup", { name: "High" });
		expect(within(high).getByText("Card a")).toBeInTheDocument();
		expect(within(screen.getByRole("rowgroup", { name: "No priority" })).getByText("Card b")).toBeInTheDocument();
		const fold = within(high).getByRole("button", { name: /High/ });
		await user.click(fold);
		expect(fold).toHaveAttribute("aria-expanded", "false");
		expect(within(high).queryByText("Card a")).toBeNull();
		expect(screen.queryByText("No card matches the filters.")).toBeNull();
	});

	it("says when no card matches", () => {
		localStorage.setItem("kanban-lanes-p", JSON.stringify({ layout: "list" }));
		list([]);
		expect(screen.getByText("No card matches the filters.")).toBeInTheDocument();
	});
});

describe("LaneGroupingMenu", () => {
	it("picks a grouping, pins blocked cards and adds a sub-project", async () => {
		const user = userEvent.setup();
		act(() => useKanbanLanesStore.getState().loadForProject("p"));
		render(<LaneGroupingMenu />);
		await user.click(screen.getByRole("button", { name: "Swimlanes" }));
		const pin = screen.getByRole("switch", { name: "Blocked cards in a lane of their own, first" });
		expect(pin).toBeDisabled();
		expect(screen.getByRole("button", { name: /Origin/ })).toHaveTextContent("read only");
		await user.click(screen.getByRole("button", { name: "Sub-project" }));
		expect(useKanbanLanesStore.getState().grouping).toBe("area");
		expect(screen.getByRole("button", { name: "Lanes: Sub-project" })).toBeInTheDocument();
		await user.click(pin);
		expect(useKanbanLanesStore.getState().pinFlagged).toBe(false);
		const name = screen.getByRole("textbox", { name: "Add a sub-project" });
		await user.type(name, "mobile{Enter}");
		expect(useKanbanLanesStore.getState().areas).toEqual(["mobile"]);
		await user.type(name, "mobile");
		await user.click(screen.getByRole("button", { name: "Add a sub-project" }));
		expect(screen.getByText("This sub-project is already there, or the name is not valid.")).toBeInTheDocument();
	});
});
