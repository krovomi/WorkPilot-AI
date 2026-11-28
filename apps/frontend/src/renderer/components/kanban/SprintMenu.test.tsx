/**
 * The toolbar's « Sprints » menu: the sprints with their progress, the
 * board filtered by sprint or backlog, the actions a person may take, and
 * the card menu's « Sprint » entry.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Sprint, Task } from "../../../shared/types";
import { EMPTY_FILTERS, NO_SPRINT } from "../../lib/kanban-filter";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useProjectStore } from "../../stores/project-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { ConfirmDialogHost } from "../ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { SprintChoiceMenuItems } from "./SprintChoiceMenuItems";
import { SprintMenu } from "./SprintMenu";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../hooks/use-toast", () => ({ toast }));

const sprints: Sprint[] = [
	{
		id: "sp-0000000a",
		name: "Sprint 12",
		goal: "Checkout ready",
		state: "active",
		createdAt: "t",
		startDate: "2026-12-01",
		endDate: "2026-12-14",
	},
	{ id: "sp-0000000b", name: "Sprint 13", state: "planned", createdAt: "t", startDate: "2026-12-15" },
	{
		id: "sp-0000000c",
		name: "Sprint 11",
		state: "closed",
		createdAt: "t",
		closedAt: "2026-11-01",
		endDate: "2026-11-30",
		report: { done: 4, donePoints: 21, carried: 1, carriedPoints: 3, carriedTo: "sp-0000000a" },
	},
];

const card = (id: string, status: Task["status"], sprintId?: string, score?: number) =>
	({
		id,
		specId: id,
		title: id,
		status,
		metadata: { sprintId, smartEstimate: score ? { complexityScore: score } : undefined },
	}) as unknown as Task;

const listSprints = vi.fn(async () => ({ success: true, data: sprints }));
const change = vi.fn(async (..._args: unknown[]) => ({ success: true, data: sprints }) as { success: boolean; data?: Sprint[]; error?: string });
const updateTask = vi.fn(async (id: string, updates: { metadata?: object }) => {
	const task = useTaskStore.getState().tasks.find((t) => t.id === id);
	return { success: true, data: { ...task, metadata: { ...task?.metadata, ...updates.metadata } } };
});

function project(role?: "viewer" | "member"): Project {
	return { id: "p1", name: "P", path: "/p", remote: role ? { role } : undefined } as unknown as Project;
}

beforeEach(() => {
	change.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		listSprints,
		saveSprint: change,
		startSprint: change,
		completeSprint: change,
		deleteSprint: change,
		updateTask,
	};
	useProjectStore.setState({ projects: [project()], selectedProjectId: "p1" });
	useTaskStore.setState({
		tasks: [card("a", "done", "sp-0000000a", 5), card("b", "in_progress", "sp-0000000a"), card("c", "backlog")],
	});
	useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS } });
	useSprintStore.setState({ projectId: null, sprints: [] });
});

async function open(count = 3) {
	const user = userEvent.setup();
	render(
		<>
			<SprintMenu />
			<ConfirmDialogHost />
		</>,
	);
	await waitFor(() => expect(useSprintStore.getState().sprints).toHaveLength(count));
	await user.click(screen.getByTestId("kanban-sprint-menu"));
	return user;
}

describe("SprintMenu", () => {
	it("lists the sprints with their progress, the velocity and the report of a closed one", async () => {
		await open();
		expect(listSprints).toHaveBeenCalledWith("p1");
		const active = document.querySelector('[data-sprint="sp-0000000a"]') as HTMLElement;
		expect(within(active).getByText("1/2 cards · 5/5 pts")).toBeInTheDocument();
		expect(within(active).getByText("1 not estimated")).toBeInTheDocument();
		expect(screen.getByText("Velocity: 21 pts")).toBeInTheDocument();
		expect(screen.getByText("Done: 4 cards (21 pts) · carried over: 1")).toBeInTheDocument();
		// One sprint is active: the planned one cannot start yet.
		const planned = document.querySelector('[data-sprint="sp-0000000b"]') as HTMLElement;
		expect(within(planned).getByRole("button", { name: /Start/ })).toBeDisabled();
	});

	it("filters the board by sprint, by backlog, then shows every card again", async () => {
		const user = await open();
		await user.click(screen.getByRole("button", { name: "Sprint 13" }));
		expect(useKanbanFilterStore.getState().filters.sprint).toBe("sp-0000000b");
		await user.click(screen.getByRole("button", { name: /Backlog/ }));
		expect(useKanbanFilterStore.getState().filters.sprint).toBe(NO_SPRINT);
		await user.click(screen.getByRole("button", { name: /All cards/ }));
		expect(useKanbanFilterStore.getState().filters.sprint).toBeUndefined();
	});

	it("shows a viewer of a server project the sprints without the actions", async () => {
		useProjectStore.setState({ projects: [project("viewer")] });
		await open();
		expect(screen.getByText("Sprint 12")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /New sprint/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Complete sprint/ })).toBeNull();
	});

	it("creates a sprint from its dialog, refusing an end before the start", async () => {
		const user = await open();
		await user.click(screen.getByRole("button", { name: /New sprint/ }));
		const dialog = screen.getByRole("dialog");
		const create = within(dialog).getByRole("button", { name: "Create" });
		expect(create).toBeDisabled();
		await user.type(within(dialog).getByLabelText("Name"), "Sprint 14");
		await user.type(within(dialog).getByLabelText("Goal"), "Search");
		const start = within(dialog).getByLabelText("Start");
		const end = within(dialog).getByLabelText("End");
		await user.type(start, "2026-12-10");
		await user.type(end, "2026-12-01");
		expect(within(dialog).getByText("The sprint cannot end before it starts.")).toBeInTheDocument();
		expect(create).toBeDisabled();
		await user.clear(end);
		await user.type(end, "2026-12-24");
		await user.click(create);
		expect(change).toHaveBeenCalledWith("p1", {
			name: "Sprint 14",
			goal: "Search",
			startDate: "2026-12-10",
			endDate: "2026-12-24",
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("edits a sprint, and says so when the save fails", async () => {
		change.mockResolvedValueOnce({ success: false, error: "closed" });
		const user = await open();
		const active = document.querySelector('[data-sprint="sp-0000000a"]') as HTMLElement;
		await user.click(within(active).getByRole("button", { name: /Edit/ }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByLabelText("Name")).toHaveValue("Sprint 12");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(change).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "sp-0000000a", name: "Sprint 12" }));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "The sprint could not be saved." })));
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
	});

	it("completes the active sprint, moving the unfinished cards where the person chose", async () => {
		const user = await open();
		await user.click(screen.getByRole("button", { name: /Complete sprint/ }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("1 cards done (5 pts), 1 unfinished.")).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: /Backlog/ }));
		await user.click(within(dialog).getByRole("button", { name: /Sprint 13/ }));
		await user.click(within(dialog).getByRole("button", { name: "Complete sprint" }));
		await waitFor(() => expect(change).toHaveBeenCalledWith("p1", "sp-0000000a", expect.objectContaining({ carriedTo: "sp-0000000b" })));
		expect(useTaskStore.getState().tasks.find((t) => t.id === "b")?.metadata?.sprintId).toBe("sp-0000000b");
	});

	it("starts and deletes a planned sprint once confirmed", async () => {
		useSprintStore.setState({ projectId: "p1", sprints: sprints.filter((s) => s.state !== "active") });
		listSprints.mockResolvedValueOnce({ success: true, data: sprints.filter((s) => s.state !== "active") });
		const user = userEvent.setup();
		render(
			<>
				<SprintMenu />
				<ConfirmDialogHost />
			</>,
		);
		await user.click(screen.getByTestId("kanban-sprint-menu"));
		useKanbanFilterStore.getState().setSprint("sp-0000000b");
		const planned = document.querySelector('[data-sprint="sp-0000000b"]') as HTMLElement;
		await user.click(within(planned).getByRole("button", { name: /Start/ }));
		expect(change).toHaveBeenCalledWith("p1", "sp-0000000b", { cards: 0, points: 0 });
		change.mockResolvedValueOnce({ success: true, data: [] });
		await user.click(within(planned).getByRole("button", { name: /Delete/ }));
		await user.click(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(change).toHaveBeenCalledWith("p1", "sp-0000000b"));
		await waitFor(() => expect(useKanbanFilterStore.getState().filters.sprint).toBeUndefined());
	});

	it("shows the sprints' days, and reads nothing without a project", async () => {
		await open();
		expect(screen.getByText("Dec 1 – Dec 14")).toBeInTheDocument();
		expect(screen.getByText("Dec 15")).toBeInTheDocument();
		expect(screen.getByText("Nov 30")).toBeInTheDocument();
		cleanup();
		listSprints.mockClear();
		useProjectStore.setState({ selectedProjectId: null });
		render(<SprintMenu />);
		expect(listSprints).not.toHaveBeenCalled();
	});

	it("lets a member of a server project change the sprints, not a role it does not know", async () => {
		useProjectStore.setState({ projects: [project("member")] });
		await open();
		expect(screen.getByRole("button", { name: /New sprint/ })).toBeInTheDocument();
		cleanup();
		useProjectStore.setState({ projects: [{ ...project("member"), remote: {} } as Project] });
		await open();
		expect(screen.queryByRole("button", { name: /New sprint/ })).toBeNull();
	});

	it("keeps a sprint when the deletion is cancelled, and the filter when another sprint goes", async () => {
		const plannedOnly = [
			...sprints.filter((s) => s.state !== "active"),
			{ id: "sp-0000000d", name: "Sprint 14", state: "planned", createdAt: "t" } as Sprint,
		];
		listSprints.mockResolvedValue({ success: true, data: plannedOnly });
		const user = await open(3);
		useKanbanFilterStore.getState().setSprint("sp-0000000d");
		const planned = () => document.querySelector('[data-sprint="sp-0000000b"]') as HTMLElement;
		await user.click(within(planned()).getByRole("button", { name: /Delete/ }));
		await user.click(await screen.findByRole("button", { name: "Cancel" }));
		expect(change).not.toHaveBeenCalled();
		if (!planned()) await user.click(screen.getByTestId("kanban-sprint-menu"));
		await user.click(within(planned()).getByRole("button", { name: /Delete/ }));
		await user.click(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(change).toHaveBeenCalledWith("p1", "sp-0000000b"));
		expect(useKanbanFilterStore.getState().filters.sprint).toBe("sp-0000000d");
		listSprints.mockResolvedValue({ success: true, data: sprints });
	});

	it("does not save an empty name, nor twice while saving", async () => {
		let finish: (value: unknown) => void = () => undefined;
		change.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)) as never);
		const user = await open();
		await user.click(screen.getByRole("button", { name: /New sprint/ }));
		const name = within(screen.getByRole("dialog")).getByLabelText("Name");
		const form = name.closest("form") as HTMLFormElement;
		fireEvent.submit(form);
		expect(change).not.toHaveBeenCalled();
		await user.type(name, "S");
		fireEvent.submit(form);
		fireEvent.submit(form);
		expect(change).toHaveBeenCalledTimes(1);
		finish({ success: true, data: sprints });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes a sprint to the backlog when no sprint is planned, and says when a card did not move", async () => {
		listSprints.mockResolvedValue({ success: true, data: sprints.filter((s) => s.state !== "planned") });
		updateTask.mockResolvedValueOnce({ success: false, error: "locked" } as never);
		const user = await open(2);
		await user.click(screen.getByRole("button", { name: /Complete sprint/ }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByRole("button", { name: /Backlog/ })).toHaveAttribute("aria-pressed", "true");
		await user.click(within(dialog).getByRole("button", { name: "Complete sprint" }));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({ title: "1 card could not be moved: the sprint was not changed." }),
			),
		);
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		listSprints.mockResolvedValue({ success: true, data: sprints });
	});

	it("offers a card the open sprints and the backlog, never a closed sprint", async () => {
		useSprintStore.setState({ projectId: "p1", sprints });
		const onSelect = vi.fn();
		const user = userEvent.setup();
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>menu</DropdownMenuTrigger>
				<DropdownMenuContent>
					<SprintChoiceMenuItems current="sp-0000000a" onSelect={onSelect} />
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		await user.click(screen.getByText("menu"));
		expect(screen.queryByText("Sprint 11")).toBeNull();
		await user.click(screen.getByText("Sprint 13"));
		expect(onSelect).toHaveBeenCalledWith("sp-0000000b");
	});
});
