/**
 * « Proposer le sprint » in the planning view: the settings, the wait, the
 * cards offered with their reason and the capacity line, trimming and
 * completing the proposal, then adding it in one move the view can undo.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Sprint, SprintProposal, Task } from "../../../shared/types";
import { EMPTY_FILTERS } from "../../lib/kanban-filter";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useProjectStore } from "../../stores/project-store";
import { offeredIds, useSprintProposalStore } from "../../stores/sprint-proposal-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { SprintBanner } from "./SprintBanner";
import { SprintEditDialog } from "./SprintDialogs";
import { SprintPlanningDialog } from "./SprintPlanningDialog";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../hooks/use-toast", () => ({ toast }));

const PLANNED: Sprint = { id: "sp-0000000b", name: "Sprint-02", state: "planned", createdAt: "t" };
const CLOSED: Sprint = {
	id: "sp-0000000c",
	name: "Sprint-01",
	state: "closed",
	createdAt: "t",
	closedAt: "2026-11-27",
	report: { done: 3, donePoints: 12, carried: 0, carriedPoints: 0, carriedTo: null },
};

const card = (id: string, score: number, sprintId?: string) =>
	({
		id,
		specId: id,
		title: `Card ${id}`,
		status: "backlog",
		createdAt: "2026-11-01T00:00:00Z",
		metadata: { sprintId, smartEstimate: { complexityScore: score } },
	}) as unknown as Task;

const PROPOSAL: SprintProposal = {
	sprintId: PLANNED.id,
	capacity: 12,
	committed: 0,
	picks: [
		{ taskId: "blocker", points: 2, reason: "dependency", dependencyOf: "main" },
		{ taskId: "main", points: 5, reason: "goal", note: "Le cœur du paiement" },
		{ taskId: "bug", points: 3, reason: "bug" },
		{ taskId: "key", points: 1, reason: "unblocks", unblocks: 2 },
	],
	points: 11,
	below: [{ taskId: "big", points: 8, total: 19 }],
	unestimated: ["x"],
	blocked: ["y", "z"],
	goal: "Payer en ligne",
	summary: "Un sprint autour du paiement.",
	mode: "ai",
	variant: "balanced",
};

const updateTask = vi.fn(async (id: string, updates: { metadata?: object }) => {
	const task = useTaskStore.getState().tasks.find((t) => t.id === id);
	const data = { ...task, metadata: { ...task?.metadata, ...updates.metadata } };
	useTaskStore.setState({ tasks: useTaskStore.getState().tasks.map((t) => (t.id === id ? (data as Task) : t)) });
	return { success: true, data };
});
const saveSprint = vi.fn(async (_projectId: string, draft: Sprint) => ({
	success: true,
	data: useSprintStore.getState().sprints.map((sprint) => (sprint.id === draft.id ? { ...sprint, ...draft } : sprint)),
}));
const proposeSprint = vi.fn(async (_request: unknown) => ({ success: true, data: PROPOSAL }) as object);

function project(role?: "viewer" | "member"): Project {
	return { id: "p1", name: "P", path: "/p", remote: role ? { role } : undefined } as unknown as Project;
}

beforeEach(() => {
	updateTask.mockClear();
	saveSprint.mockClear();
	proposeSprint.mockClear();
	proposeSprint.mockImplementation(async () => ({ success: true, data: PROPOSAL }));
	toast.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = { updateTask, saveSprint, proposeSprint };
	useProjectStore.setState({ projects: [project()], selectedProjectId: "p1" });
	useTaskStore.setState({
		tasks: [card("blocker", 2), card("main", 5), card("bug", 3), card("key", 1), card("big", 8)],
	});
	useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS, sprint: PLANNED.id } });
	useSprintStore.setState({ projectId: "p1", sprints: [PLANNED, CLOSED], planningId: null });
	useSprintProposalStore.getState().dismiss();
});

afterEach(() => cleanup());

function board() {
	return render(
		<>
			<SprintBanner />
			<SprintPlanningDialog />
		</>,
	);
}

async function proposed() {
	const user = userEvent.setup();
	board();
	await user.click(screen.getByTestId("kanban-sprint-propose"));
	await user.click(within(screen.getByTestId("sprint-proposal-settings")).getByRole("button", { name: "Propose" }));
	await screen.findByTestId("sprint-proposal-ready");
	return user;
}

describe("Propose the sprint", () => {
	it("opens from the banner on settings prefilled with the capacity, and says what is sent", async () => {
		const user = userEvent.setup();
		board();
		await user.click(screen.getByTestId("kanban-sprint-propose"));
		const settings = screen.getByTestId("sprint-proposal-settings");
		expect(within(settings).getByText("Capacity: 12 pts")).toBeInTheDocument();
		expect(within(settings).getByText("100 %")).toBeInTheDocument();
		expect(within(settings).getByText(/Never who works on a card/)).toBeInTheDocument();

		await user.type(within(settings).getByLabelText("Sprint goal"), "Pay online");
		fireEvent.change(within(settings).getByLabelText("Capacity: 12 pts"), { target: { value: "9" } });
		expect(within(settings).getByText("75 %")).toBeInTheDocument();
		await user.click(within(settings).getByRole("button", { name: "Bugs first" }));
		await user.click(within(settings).getByRole("button", { name: "Propose" }));
		expect(proposeSprint).toHaveBeenCalledWith({
			projectId: "p1",
			sprintId: PLANNED.id,
			variant: "bugs",
			goal: "Pay online",
			capacity: 9,
		});
	});

	it("leaves the sprint's own goal and capacity to the main process", async () => {
		useSprintStore.setState({ sprints: [{ ...PLANNED, goal: "Own goal" }, CLOSED] });
		const user = userEvent.setup();
		board();
		await user.click(screen.getByTestId("kanban-sprint-propose"));
		expect(screen.getByLabelText("Sprint goal")).toHaveValue("Own goal");
		await user.click(screen.getByRole("button", { name: "Propose" }));
		expect(proposeSprint).toHaveBeenCalledWith({ projectId: "p1", sprintId: PLANNED.id, variant: "balanced" });
	});

	it("shows the places being filled while the model composes", async () => {
		let answer: (value: object) => void = vi.fn();
		proposeSprint.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
		const user = userEvent.setup();
		board();
		await user.click(screen.getByTestId("kanban-sprint-propose"));
		await user.click(screen.getByRole("button", { name: "Propose" }));
		expect(screen.getByTestId("sprint-proposal-thinking")).toHaveTextContent("Composing the sprint…");
		expect(screen.getAllByTestId("sprint-proposal-skeleton")).toHaveLength(3);
		await act(async () => answer({ success: true, data: PROPOSAL }));
		expect(screen.getByTestId("sprint-proposal-ready")).toBeInTheDocument();
		expect(screen.queryByTestId("sprint-proposal-skeleton")).not.toBeInTheDocument();
	});

	it("offers the cards with their reason, the capacity line and what falls below it", async () => {
		const user = await proposed();
		const ready = screen.getByTestId("sprint-proposal-ready");
		expect(within(ready).getByText("Proposal · 4 cards · 11 pts")).toBeInTheDocument();
		expect(within(ready).getByText("Composed by AI")).toBeInTheDocument();
		expect(within(ready).getByText("1 backlog card without an estimate is not counted.")).toBeInTheDocument();
		expect(within(ready).getByText("2 cards wait on a card that cannot join this sprint.")).toBeInTheDocument();
		expect(within(ready).queryByText("Un sprint autour du paiement.")).not.toBeInTheDocument();
		await user.click(within(ready).getByRole("button", { name: "Why these cards" }));
		expect(within(ready).getByText("Un sprint autour du paiement.")).toBeInTheDocument();

		const side = screen.getByTestId("sprint-planning-sprint");
		expect(within(side).getByText("Needed by “Card main”")).toBeInTheDocument();
		expect(within(side).getByText("Le cœur du paiement")).toBeInTheDocument();
		expect(within(side).getByText("Bug to fix")).toBeInTheDocument();
		expect(within(side).getByText("Unblocks 2 cards")).toBeInTheDocument();
		expect(within(side).getByTestId("sprint-proposal-line")).toHaveTextContent("Capacity line · 12 pts");
		expect(within(side).getByText("With it: 19 / 12 pts")).toBeInTheDocument();
		expect(within(side).queryByText("No cards in this sprint yet.")).not.toBeInTheDocument();
		expect(screen.getByTestId("sprint-capacity-proposed")).toBeInTheDocument();
	});

	it("takes a card out with what was proposed only for it, puts it back, and adds one from below", async () => {
		const user = await proposed();
		const side = screen.getByTestId("sprint-planning-sprint");
		const main = side.querySelector('[data-task="main"][data-proposed]') as HTMLElement;
		await user.click(within(main).getByRole("button", { name: "Take out of the proposal" }));
		expect(screen.getByText("Proposal · 2 cards · 4 pts")).toBeInTheDocument();
		expect(side.querySelector('[data-task="blocker"]')).toHaveAttribute("data-proposed", "out");
		await user.click(within(main).getByRole("button", { name: "Put back in the proposal" }));
		expect(screen.getByText("Proposal · 4 cards · 11 pts")).toBeInTheDocument();

		const big = side.querySelector('[data-task="big"]') as HTMLElement;
		await user.click(within(big).getByRole("button", { name: "Add to the proposal" }));
		expect(screen.getByText("Proposal · 5 cards · 19 pts")).toBeInTheDocument();
		await user.click(within(big).getByRole("button", { name: "Take out of the proposal" }));
		expect(screen.getByText("Proposal · 4 cards · 11 pts")).toBeInTheDocument();
	});

	it("adds the offered cards in one move, which Undo takes back", async () => {
		const user = await proposed();
		await user.click(screen.getByTestId("sprint-proposal-accept"));
		await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(4));
		expect(updateTask.mock.calls.map(([id]) => id)).toEqual(["blocker", "main", "bug", "key"]);
		expect(updateTask).toHaveBeenCalledWith("main", { metadata: { sprintId: PLANNED.id, carriedFrom: undefined } });
		expect(screen.queryByTestId("sprint-proposal-ready")).not.toBeInTheDocument();
		expect(screen.getByText("4 cards added to the sprint")).toBeInTheDocument();
		updateTask.mockClear();
		await user.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(4));
		expect(updateTask).toHaveBeenCalledWith("main", { metadata: { sprintId: undefined, carriedFrom: undefined } });
	});

	it("keeps the proposal when the cards could not be added", async () => {
		const user = await proposed();
		updateTask.mockImplementationOnce(async () => ({ success: false, error: "locked" }) as never);
		await user.click(screen.getByTestId("sprint-proposal-accept"));
		await waitFor(() => expect(toast).toHaveBeenCalled());
		expect(screen.getByTestId("sprint-proposal-ready")).toBeInTheDocument();
	});

	it("does not offer again a card that already joined the sprint", async () => {
		await proposed();
		const backlog = screen.getByTestId("sprint-planning-backlog");
		// Offered, so shown on the sprint side only.
		expect(backlog.querySelector('[data-task="bug"]')).toBeNull();
		expect(backlog.querySelector('[data-task="big"]')).not.toBeNull();
		// Moved meanwhile by another way (its card menu): the proposal no longer counts it.
		await act(async () => {
			await useSprintStore.getState().assign(["bug"], PLANNED.id);
		});
		await waitFor(() => expect(screen.getByText("Proposal · 4 cards · 8 pts")).toBeInTheDocument());
		const side = screen.getByTestId("sprint-planning-sprint");
		expect(side.querySelectorAll('[data-task="bug"]')).toHaveLength(1);
	});

	it("words a reason without its detail, and skips cards it cannot show", async () => {
		useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks, card("in", 2, PLANNED.id)] });
		proposeSprint.mockImplementation(async () => ({
			success: true,
			data: {
				...PROPOSAL,
				picks: [
					{ taskId: "blocker", points: 2, reason: "dependency" },
					{ taskId: "key", points: 1, reason: "unblocks" },
					{ taskId: "gone", points: 1, reason: "fits" },
				],
				below: [
					{ taskId: "in", points: 2, total: 5 },
					{ taskId: "gone", points: 1, total: 4 },
				],
			},
		}));
		await proposed();
		const side = screen.getByTestId("sprint-planning-sprint");
		expect(within(side).getByText("Needed by “”")).toBeInTheDocument();
		expect(within(side).getByText("Unblocks 1 card")).toBeInTheDocument();
		expect(side.querySelector('[data-task="gone"]')).toBeNull();
		expect(side.querySelector('[data-task="in"][data-proposed]')).toBeNull();
	});

	it("uses the suggested goal on the sprint", async () => {
		const user = await proposed();
		const goal = screen.getByTestId("sprint-proposal-goal");
		expect(goal).toHaveTextContent("Suggested goal: Payer en ligne");
		await user.click(within(goal).getByRole("button", { name: "Use it" }));
		expect(saveSprint).toHaveBeenCalledWith("p1", expect.objectContaining({ id: PLANNED.id, goal: "Payer en ligne" }));
	});

	it("asks again with another intent", async () => {
		const user = await proposed();
		proposeSprint.mockClear();
		await user.click(within(screen.getByTestId("sprint-proposal-ready")).getByRole("button", { name: "More careful (80 %)" }));
		expect(proposeSprint).toHaveBeenCalledWith(expect.objectContaining({ variant: "careful" }));
		await screen.findByTestId("sprint-proposal-ready");
	});

	it("says when the rules proposed and nothing fits, and can be dismissed", async () => {
		proposeSprint.mockImplementation(async () => ({
			success: true,
			data: { ...PROPOSAL, picks: [], below: [], unestimated: [], blocked: [], goal: undefined, summary: undefined, mode: "rules" },
		}));
		const user = await proposed();
		const ready = screen.getByTestId("sprint-proposal-ready");
		expect(within(ready).getByText("Proposed by the rules")).toBeInTheDocument();
		expect(within(ready).getByText(/Nothing to propose/)).toBeInTheDocument();
		expect(screen.getByTestId("sprint-proposal-accept")).toBeDisabled();
		await user.click(within(ready).getByRole("button", { name: "Dismiss" }));
		expect(screen.getByTestId("sprint-proposal-open")).toBeInTheDocument();
	});

	it("says when the proposal failed and tries again", async () => {
		proposeSprint.mockImplementationOnce(async () => ({ success: false, error: "server_unreachable" }));
		const user = userEvent.setup();
		board();
		await user.click(screen.getByTestId("kanban-sprint-propose"));
		await user.click(screen.getByRole("button", { name: "Propose" }));
		const failed = await screen.findByTestId("sprint-proposal-failed");
		expect(failed).toHaveTextContent("The proposal failed (server_unreachable).");
		await user.click(within(failed).getByRole("button", { name: "Try again" }));
		await screen.findByTestId("sprint-proposal-ready");
		await user.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
		expect(screen.getByTestId("sprint-proposal-open")).toBeInTheDocument();
		await user.click(screen.getByTestId("sprint-proposal-open"));
		await user.click(within(screen.getByTestId("sprint-proposal-settings")).getByRole("button", { name: "Close" }));
		expect(screen.getByTestId("sprint-proposal-open")).toBeInTheDocument();
	});

	it("reports a thrown call and a missing bridge as a failure", async () => {
		proposeSprint.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		await useSprintProposalStore.getState().propose(PLANNED.id);
		expect(useSprintProposalStore.getState()).toMatchObject({ phase: "failed", error: "boom" });
		proposeSprint.mockImplementationOnce(async () => {
			throw "not an error";
		});
		await useSprintProposalStore.getState().propose(PLANNED.id);
		expect(useSprintProposalStore.getState()).toMatchObject({ phase: "failed", error: "unknown" });
		(globalThis as { electronAPI?: unknown }).electronAPI = {};
		await useSprintProposalStore.getState().propose(PLANNED.id);
		expect(useSprintProposalStore.getState()).toMatchObject({ phase: "failed", error: "unavailable" });
		useSprintStore.setState({ projectId: null });
		await useSprintProposalStore.getState().propose(PLANNED.id);
		expect(useSprintProposalStore.getState()).toMatchObject({ phase: "failed", error: "no_project" });
	});

	it("keeps only the latest answer and ignores what does not apply", async () => {
		let first: (value: object) => void = vi.fn();
		proposeSprint.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)));
		const store = useSprintProposalStore.getState();
		const older = store.propose(PLANNED.id, { variant: "bugs" });
		await store.propose(PLANNED.id, { variant: "goal" });
		first({ success: true, data: { ...PROPOSAL, variant: "bugs" } });
		await older;
		expect(useSprintProposalStore.getState().proposal?.variant).toBe("balanced");
		expect(useSprintProposalStore.getState().ask.variant).toBe("goal");

		store.toggleAdded("main");
		expect(useSprintProposalStore.getState().added).toEqual([]);
		store.dismiss();
		store.toggleRemoved("main");
		expect(useSprintProposalStore.getState().removed.size).toBe(0);
		expect(offeredIds(null, new Set(), [])).toEqual([]);
		store.openSettings(PLANNED.id, { goal: "G" });
		store.openSettings(PLANNED.id);
		expect(useSprintProposalStore.getState().ask.goal).toBe("G");
	});

	it("shows nothing of it to a viewer of a server project", () => {
		useProjectStore.setState({ projects: [project("viewer")], selectedProjectId: "p1" });
		useSprintProposalStore.getState().openSettings(PLANNED.id);
		useSprintStore.setState({ planningId: PLANNED.id });
		board();
		expect(screen.queryByTestId("kanban-sprint-propose")).not.toBeInTheDocument();
		expect(screen.queryByTestId("sprint-proposal-settings")).not.toBeInTheDocument();
		expect(screen.queryByTestId("sprint-proposal-open")).not.toBeInTheDocument();
	});

	it("opens a new sprint's planning view on the proposal's settings", async () => {
		const created: Sprint = { id: "sp-0000000d", name: "Sprint-03", state: "planned", createdAt: "t" };
		saveSprint.mockImplementationOnce(async () => ({ success: true, data: [PLANNED, CLOSED, created] }));
		const user = userEvent.setup();
		render(
			<>
				<SprintEditDialog open onOpenChange={vi.fn()} />
				<SprintPlanningDialog />
			</>,
		);
		await user.type(screen.getByLabelText("Name"), "Sprint-03");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByTestId("sprint-proposal-settings")).toBeInTheDocument();
		expect(useSprintProposalStore.getState().sprintId).toBe(created.id);
	});
});
