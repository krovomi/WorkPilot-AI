/**
 * KanbanBoard — the board as the app mounts it: real stores, real columns and
 * cards, only the IPC bridge stood in. dnd-kit's pointer sensors cannot run in
 * jsdom, so the DndContext hands its three handlers to the test, which drives
 * them with the events dnd-kit would send.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Task, TaskStatus } from "../../../shared/types";
import { ViewStateProvider } from "../../contexts/ViewStateContext";
import { useAppEmulatorStore } from "../../stores/app-emulator-store";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useKanbanSettingsStore } from "../../stores/kanban-settings-store";
import { useProjectEnvStore } from "../../stores/project-env-store";
import { useProjectStore } from "../../stores/project-store";
import { kickQueue, useTaskStore } from "../../stores/task-store";
import { useBoardUndoStore } from "../../stores/board-undo-store";
import { usePendingDeleteStore } from "../../stores/pending-delete-store";
import { KanbanBoard } from "../KanbanBoard";
import { Toaster } from "../ui/toaster";
import { TooltipProvider } from "../ui/tooltip";
import { pickSubmenuItem } from "../../../__tests__/helpers/menus";

type DragHandlers = {
	onDragStart?: (e: unknown) => void;
	onDragOver?: (e: unknown) => void;
	onDragEnd?: (e: unknown) => Promise<void> | void;
};
const dnd: DragHandlers = {};

vi.mock("@dnd-kit/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/core")>();
	return {
		...actual,
		DndContext: (
			props: Parameters<typeof actual.DndContext>[0] & { children: ReactNode },
		) => {
			dnd.onDragStart = props.onDragStart as DragHandlers["onDragStart"];
			dnd.onDragOver = props.onDragOver as DragHandlers["onDragOver"];
			dnd.onDragEnd = props.onDragEnd as DragHandlers["onDragEnd"];
			return <actual.DndContext {...props} />;
		},
	};
});

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001-t1",
		projectId: "p1",
		title: "Task one",
		description: "",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-10T10:00:00Z"),
		updatedAt: new Date(),
		metadata: {},
		...overrides,
	} as Task;
}

function Board(props: Partial<Parameters<typeof KanbanBoard>[0]>) {
	const tasks = useTaskStore((s) => s.tasks);
	return (
		<KanbanBoard
			tasks={tasks}
			onTaskClick={props.onTaskClick ?? vi.fn()}
			{...props}
		/>
	);
}

function renderBoard(
	tasks: Task[],
	props: Partial<Parameters<typeof KanbanBoard>[0]> = {},
) {
	useTaskStore.setState({ tasks });
	return render(
		<ViewStateProvider>
			<TooltipProvider>
				<Board {...props} />
				<Toaster />
			</TooltipProvider>
		</ViewStateProvider>,
	);
}

const drag = {
	start: (id: string) => act(() => dnd.onDragStart?.({ active: { id } })),
	over: (id: string, overId: string | null) =>
		act(() =>
			dnd.onDragOver?.({ active: { id }, over: overId ? { id: overId } : null }),
		),
	end: (id: string, overId: string | null) =>
		act(async () => {
			await dnd.onDragEnd?.({
				active: { id },
				over: overId ? { id: overId } : null,
			});
		}),
};

/** The floating bar of bulk actions over a selection. */
function bulkBar(): HTMLElement {
	return screen.getByText(/tasks? selected/).parentElement as HTMLElement;
}

function liveRegion(): HTMLElement {
	return document.querySelector('[aria-live="polite"][aria-atomic="true"]') as HTMLElement;
}

function column(status: string): HTMLElement {
	const el = document.querySelector<HTMLElement>(
		`[data-column-status="${status}"]`,
	);
	if (!el) throw new Error(`no column ${status}`);
	return el;
}

let api: RendererApi;

function installApi(overrides: Record<string, unknown> = {}) {
	api = installRendererApi({
		updateTaskStatus: vi.fn(async () => ({ success: true })),
		checkPlanConflicts: vi.fn(async () => ({
			success: true,
			data: { conflictingTasks: [], totalConflictingFiles: 0 },
		})),
		...overrides,
	});
}

beforeAll(() => {
	// jsdom has no scrollBy; the board scrolls while an import is dragged.
	Element.prototype.scrollBy = vi.fn();
	// …nor pointer capture, which a toast's swipe handler calls on click.
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.releasePointerCapture = () => undefined;
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = vi.fn();
			disconnect = vi.fn();
			unobserve = vi.fn();
		},
	);
});

beforeEach(() => {
	localStorage.clear();
	installApi();
	useProjectStore.setState({
		projects: [
			{
				id: "p1",
				name: "Demo",
				path: "/work/demo",
				autoBuildPath: "",
				settings: { maxParallelTasks: 1 },
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never,
		],
		selectedProjectId: "p1",
		activeProjectId: "p1",
	});
	useProjectEnvStore.setState({ envConfig: null } as never);
	useTaskStore.setState({ tasks: [], taskOrder: null, pipelineStatuses: {} });
	useKanbanSettingsStore.getState().loadPreferences("p1");
	// The filter store skips a reload for the project it already holds.
	useKanbanFilterStore.setState({ projectId: null } as never);
	useKanbanFilterStore.getState().loadForProject("p1");
	usePendingDeleteStore.setState({ ids: new Set() });
	useBoardUndoStore.getState().clear();
});

afterEach(() => {
	vi.useRealTimers();
	api.restore();
});

describe("KanbanBoard — columns", () => {
	it("puts each task in its column, errors under human review, newest first", () => {
		renderBoard([
			makeTask({ id: "a", title: "Old plan", createdAt: new Date("2026-11-01") }),
			makeTask({ id: "b", title: "New plan", createdAt: new Date("2026-11-09") }),
			makeTask({ id: "c", title: "Broken", status: "error" }),
			makeTask({ id: "d", title: "Shipped", status: "done" }),
		]);
		const backlog = within(column("backlog")).getAllByRole("heading", {
			level: 3,
		});
		expect(backlog.map((h) => h.textContent)).toEqual(["New plan", "Old plan"]);
		expect(
			within(column("human_review")).getByRole("heading", { name: "Broken" }),
		).toBeInTheDocument();
		expect(
			within(column("done")).getByRole("heading", { name: "Shipped" }),
		).toBeInTheDocument();
		expect(within(column("queue")).getByText("Queue is empty")).toBeInTheDocument();
	});

	it("follows the stored manual order and puts new cards on top", () => {
		useTaskStore.setState({
			taskOrder: {
				backlog: ["a", "b", "gone"],
				queue: [],
				in_progress: [],
				ai_review: [],
				human_review: [],
				build_failed: [],
				pr_created: [],
				done: [],
				error: [],
			} as never,
		});
		renderBoard([
			makeTask({ id: "a", title: "First" }),
			makeTask({ id: "b", title: "Second" }),
			makeTask({ id: "n", title: "Fresh", createdAt: new Date("2026-11-12") }),
			makeTask({ id: "m", title: "Fresher", createdAt: new Date("2026-11-13") }),
		]);
		const titles = within(column("backlog"))
			.getAllByRole("heading", { level: 3 })
			.map((h) => h.textContent);
		expect(titles).toEqual(["Fresher", "Fresh", "First", "Second"]);
		// The stale id left the stored order.
		expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["a", "b"]);
	});

	it("sorts by the chosen field instead of the manual order", () => {
		useKanbanFilterStore.setState({
			sort: { field: "title", direction: "asc" },
		} as never);
		renderBoard([
			makeTask({ id: "z", title: "Zeta" }),
			makeTask({ id: "a", title: "Alpha" }),
		]);
		const titles = within(column("backlog"))
			.getAllByRole("heading", { level: 3 })
			.map((h) => h.textContent);
		expect(titles).toEqual(["Alpha", "Zeta"]);
	});

	it("hides archived cards until asked, and abandoned ones on demand", async () => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({ id: "arch", title: "Old", status: "done", metadata: { archivedAt: "2026-11-01" } as never }),
			makeTask({ id: "ab", title: "Set aside", metadata: { abandoned: true } as never }),
		]);
		expect(screen.queryByRole("heading", { name: "Old" })).not.toBeInTheDocument();
		await user.click(
			within(column("done")).getByRole("button", { name: /Show archived/i }),
		);
		expect(screen.getByRole("heading", { name: "Old" })).toBeInTheDocument();

		expect(screen.getByRole("heading", { name: "Set aside" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /1 abandoned/ }));
		expect(
			screen.queryByRole("heading", { name: "Set aside" }),
		).not.toBeInTheDocument();
	});

	it("refreshes on demand and opens a card", async () => {
		const user = userEvent.setup();
		const onRefresh = vi.fn();
		const onTaskClick = vi.fn();
		renderBoard([makeTask()], { onRefresh, onTaskClick });
		await user.click(screen.getByRole("button", { name: "Refresh Tasks" }));
		expect(onRefresh).toHaveBeenCalled();
		// Away from the delete corner (jsdom cards measure 0 × 0).
		fireEvent.click(screen.getByRole("option", { name: "Task one" }), {
			clientX: 50,
			clientY: 50,
		});
		expect(onTaskClick).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t1" }),
		);
	});

	it("shows the spinner label while refreshing", () => {
		renderBoard([], { onRefresh: vi.fn(), isRefreshing: true });
		expect(screen.getByRole("button", { name: /Refreshing/ })).toBeDisabled();
	});

	it("lists idle cards and opens one from the list", async () => {
		const user = userEvent.setup();
		const onTaskClick = vi.fn();
		renderBoard(
			[
				makeTask({
					id: "idle",
					title: "Forgotten",
					status: "human_review",
					reviewReason: "completed",
					subtasks: [{ id: "s", title: "s", description: "", status: "completed" }] as never,
					updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
				}),
			],
			{ onTaskClick },
		);
		await user.click(screen.getByRole("button", { name: /1 idle/ }));
		const row = await screen.findByText("Idle tasks");
		expect(row).toBeInTheDocument();
		const entry = screen
			.getAllByText("Forgotten")
			.find((el) => el.closest("button") && !el.closest('[role="option"]'));
		await user.click(entry as HTMLElement);
		expect(onTaskClick).toHaveBeenCalledWith(
			expect.objectContaining({ id: "idle" }),
		);
	});

	it("sums the applied formula estimates into a cost forecast", async () => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({
				id: "f",
				status: "queue",
				metadata: {
					appliedFormula: {
						provider: "anthropic",
						model: "sonnet",
						effort: "low",
						expectedCostUsd: 1.5,
						successProbability: 0.9,
						perTokenBilled: true,
						appliedAt: "2026-11-01",
					},
				} as never,
			}),
			makeTask({ id: "g", status: "in_progress" }),
		]);
		const chip = screen
			.getAllByRole("status")
			.find((el) => el.textContent?.includes("€"));
		expect(chip).toBeDefined();
		await user.hover(chip as HTMLElement);
		expect(
			(await screen.findAllByText("Board cost forecast")).length,
		).toBeGreaterThan(0);
	});

	it("publishes plan conflicts and blockers to the cards", async () => {
		installApi({
			checkPlanConflicts: vi.fn(async (id: string) =>
				id === "q1"
					? {
							success: true,
							data: {
								conflictingTasks: [{ taskTitle: "Other" }],
								totalConflictingFiles: 2,
							},
						}
					: id === "q2"
						? Promise.reject(new Error("offline"))
						: { success: true, data: { conflictingTasks: [], totalConflictingFiles: 0 } },
			),
		});
		renderBoard([
			makeTask({ id: "q1", title: "Queued", status: "queue" }),
			makeTask({ id: "q2", title: "Queued 2", status: "queue" }),
			makeTask({ id: "dep", title: "Prereq" }),
			makeTask({
				id: "child",
				title: "Child",
				metadata: { blockedBy: ["dep", "missing"] } as never,
			}),
		]);
		expect(await screen.findByText("Conflict 1")).toBeInTheDocument();
		expect(screen.getByText("1 blocker")).toBeInTheDocument();
	});

	it("collapses, expands, locks and limits columns, and saves the choice", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const save = vi.spyOn(useKanbanSettingsStore.getState(), "savePreferences");
		renderBoard([makeTask()]);

		const openOptions = async (status: string) =>
			user.click(
				within(column(status)).getByRole("button", { name: "Column options" }),
			);

		for (const status of ["queue", "ai_review", "human_review"]) {
			await openOptions(status);
			await user.click(
				await screen.findByRole("menuitem", { name: "Collapse column" }),
			);
		}
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(useKanbanSettingsStore.getState().columnPreferences?.queue?.isCollapsed).toBe(true);
		await user.click(screen.getByRole("button", { name: "Expand all columns" }));
		expect(useKanbanSettingsStore.getState().columnPreferences?.queue?.isCollapsed).toBe(false);

		await openOptions("done");
		await user.click(
			await screen.findByRole("menuitem", { name: "Lock column width" }),
		);
		expect(useKanbanSettingsStore.getState().columnPreferences?.done?.isLocked).toBe(true);
		await user.click(
			within(column("done").parentElement as HTMLElement).getByRole("button", {
				name: "Unlock column width",
			}),
		);
		expect(useKanbanSettingsStore.getState().columnPreferences?.done?.isLocked).toBe(false);

		await user.click(
			within(column("backlog")).getByRole("button", { name: "Set WIP limit" }),
		);
		const input = await screen.findByPlaceholderText("No limit");
		await user.type(input, "0{Enter}");
		expect(useKanbanSettingsStore.getState().columnPreferences?.backlog?.wipLimit).toBeUndefined();
		await user.click(
			within(column("backlog")).getByRole("button", { name: "Set WIP limit" }),
		);
		await user.type(await screen.findByPlaceholderText("No limit"), "1");
		await user.click(screen.getAllByRole("button", { name: "Set WIP limit" }).at(-1) as HTMLElement);
		expect(useKanbanSettingsStore.getState().columnPreferences?.backlog?.wipLimit).toBe(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(save).toHaveBeenCalledWith("p1");
	});

	it("resizes a column with the mouse and saves the width", () => {
		const save = vi.spyOn(useKanbanSettingsStore.getState(), "savePreferences");
		renderBoard([]);
		const handle = column("backlog").parentElement?.querySelector(
			".cursor-col-resize",
		) as HTMLElement;
		fireEvent.mouseDown(handle, { clientX: 100 });
		expect(document.body.style.cursor).toBe("col-resize");
		fireEvent.mouseMove(document, { clientX: 160 });
		const width = useKanbanSettingsStore.getState().columnPreferences?.backlog?.width;
		expect(width).toBeGreaterThan(0);
		fireEvent.mouseUp(document);
		expect(save).toHaveBeenCalledWith("p1");
		expect(document.body.style.cursor).toBe("");
	});

	it("resizes a column by touch", () => {
		renderBoard([]);
		const handle = column("queue").parentElement?.querySelector(
			".cursor-col-resize",
		) as HTMLElement;
		fireEvent.touchStart(handle, { touches: [{ clientX: 100 }] });
		fireEvent.touchMove(document, { touches: [{ clientX: 50 }] });
		fireEvent.touchMove(document, { touches: [] });
		fireEvent.touchEnd(document);
		expect(
			useKanbanSettingsStore.getState().columnPreferences?.queue?.width,
		).toBeDefined();
	});
});

describe("KanbanBoard — drag and drop", () => {
	it("moves a card to another column, announces it and keeps the order", async () => {
		renderBoard([makeTask()]);
		drag.start("t1");
		expect(liveRegion().textContent).toContain("Picked up task: Task one");
		drag.over("t1", "queue");
		drag.over("t1", "queue");
		await drag.end("t1", "queue");
		expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("t1", "queue", undefined);
		expect(useTaskStore.getState().tasks[0].status).toBe("queue");
		expect(useTaskStore.getState().taskOrder?.queue?.[0]).toBe("t1");
		expect(document.body.textContent).toContain('Dropped task "Task one" into Queue');
	});

	it("cancels a drop outside any column", async () => {
		renderBoard([makeTask()]);
		drag.start("t1");
		drag.over("t1", null);
		await drag.end("t1", null);
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Move cancelled.");
	});

	it("reorders cards within a column", async () => {
		renderBoard([
			makeTask({ id: "a", title: "A", createdAt: new Date("2026-11-02") }),
			makeTask({ id: "b", title: "B", createdAt: new Date("2026-11-01") }),
		]);
		drag.start("a");
		drag.over("a", "b");
		await drag.end("a", "b");
		expect(useTaskStore.getState().taskOrder?.backlog).toEqual(["b", "a"]);
		expect(document.body.textContent).toContain('Dropped task "A".');
	});

	it("refuses a manual reorder while a sort is active", async () => {
		useKanbanFilterStore.setState({ sort: { field: "title", direction: "asc" } } as never);
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		await drag.end("a", "b");
		expect(
			await screen.findByText(/Manual reordering is disabled/),
		).toBeInTheDocument();
	});

	it("moves a card dropped on a card of another column", async () => {
		renderBoard([
			makeTask({ id: "a", title: "A" }),
			makeTask({ id: "q", title: "Q", status: "queue" }),
		]);
		await drag.end("a", "q");
		expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("a", "queue", undefined);
	});

	it("refuses Open PR for a card without a pull request", async () => {
		renderBoard([
			makeTask({ id: "a", title: "A", status: "human_review" }),
			makeTask({ id: "p", title: "P", status: "pr_created", metadata: { prUrl: "u" } as never }),
		]);
		await drag.end("a", "pr_created");
		expect(await screen.findByText(/has no pull request yet/)).toBeInTheDocument();
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});

	it("sends a card to the queue when In Progress is full, and says when a prerequisite is overridden", async () => {
		renderBoard([
			makeTask({ id: "run", title: "Running", status: "in_progress" }),
			makeTask({ id: "dep", title: "Prereq" }),
			makeTask({ id: "a", title: "A", metadata: { blockedBy: ["dep"] } as never }),
		]);
		await drag.end("a", "in_progress");
		expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("a", "queue", undefined);
		expect(
			(await screen.findAllByText("Started despite its prerequisites")).length,
		).toBeGreaterThan(0);
	});

	it("promotes the next queued task when a running one leaves", async () => {
		renderBoard([
			makeTask({ id: "run", title: "Running", status: "in_progress" }),
			makeTask({ id: "q", title: "Waiting", status: "queue" }),
		]);
		await drag.end("run", "human_review");
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith(
				"q",
				"in_progress",
				undefined,
			),
		);
	});

	it("keeps a task moved back to the queue from being promoted again", async () => {
		renderBoard([
			makeTask({ id: "run", title: "Running", status: "in_progress" }),
		]);
		await drag.end("run", "queue");
		const calls = api.fn("updateTaskStatus").mock.calls;
		expect(calls).toEqual([["run", "queue", undefined]]);
	});

	it("offers to clean up the worktree when a move to Done finds one", async () => {
		const user = userEvent.setup();
		installApi({
			updateTaskStatus: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					worktreeExists: true,
					worktreePath: "/wt/a",
				})
				.mockResolvedValueOnce({ success: false, error: "busy" })
				.mockResolvedValue({ success: true }),
		});
		renderBoard([makeTask({ id: "a", title: "A", status: "human_review" })]);
		await drag.end("a", "done");
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("/wt/a")).toBeInTheDocument();
		const confirm = within(dialog).getAllByRole("button").at(-1) as HTMLElement;
		await user.click(confirm);
		expect(await within(dialog).findByText("busy")).toBeInTheDocument();
		await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
		);
		expect(api.fn("updateTaskStatus")).toHaveBeenLastCalledWith("a", "done", {
			forceCleanup: true,
		});
	});

	it("reports a move the main process refused", async () => {
		installApi({ updateTaskStatus: vi.fn(async () => ({ success: false, error: "denied" })) });
		renderBoard([makeTask()]);
		await drag.end("t1", "queue");
		expect(await screen.findByText("denied")).toBeInTheDocument();
	});

	it("reorders columns by dragging their handles", async () => {
		renderBoard([]);
		const before = useKanbanSettingsStore.getState().columnOrder;
		drag.start("col-backlog");
		drag.over("col-backlog", "col-queue");
		await drag.end("col-backlog", "col-queue");
		const after = useKanbanSettingsStore.getState().columnOrder;
		expect(after.indexOf("backlog")).toBe(before.indexOf("queue"));
		expect(document.body.textContent).toMatch(/Queue|Planning/);
		// Dropping a column on itself changes nothing.
		await drag.end("col-queue", "col-queue");
		expect(useKanbanSettingsStore.getState().columnOrder).toEqual(after);
	});

	it("ignores the drag of an unknown card", async () => {
		renderBoard([]);
		drag.start("azure-devops-1");
		drag.start("ghost");
		drag.over("ghost", "nowhere");
		await drag.end("ghost", "queue");
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});
});

describe("KanbanBoard — selection and bulk actions", () => {
	const select = async (user: ReturnType<typeof userEvent.setup>, title: string) =>
		user.click(screen.getByRole("checkbox", { name: `Select task: ${title}` }));

	it("moves selected backlog cards together", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		await select(user, "A");
		await select(user, "B");
		expect(screen.getByText("2 tasks selected")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^Queue$/ }));
		await waitFor(() =>
			expect(screen.getByText(/2 task\(s\) moved successfully/)).toBeInTheDocument(),
		);
		expect(screen.queryByText("2 tasks selected")).not.toBeInTheDocument();
	});

	it("reports the cards a bulk move could not move", async () => {
		const user = userEvent.setup();
		installApi({
			updateTaskStatus: vi
				.fn()
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: false, error: "x" }),
		});
		renderBoard([makeTask({ id: "a", title: "A", status: "queue" }), makeTask({ id: "b", title: "B", status: "queue" })]);
		await user.click(
			within(column("queue")).getByRole("checkbox", { name: "Select all" }),
		);
		await user.click(screen.getByRole("button", { name: /^Planning$/ }));
		expect(await screen.findByText("Failed to move 1 of 2 tasks")).toBeInTheDocument();
	});

	it.each([
		["in_progress", ["Queue", "AI Review"]],
		["ai_review", ["In Progress", "Human Review"]],
		["queue", ["Planning", "In Progress"]],
	] as const)("offers the next and previous column for %s cards", async (status, labels) => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A", status })]);
		await select(user, "A");
		for (const label of labels) {
			expect(screen.getByRole("button", { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
		}
		await user.click(screen.getByRole("button", { name: new RegExp(`^${labels[1]}$`) }));
		await waitFor(() => expect(api.fn("updateTaskStatus")).toHaveBeenCalled());
	});

	it("warns that cards from different columns cannot move together", async () => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({ id: "a", title: "A" }),
			makeTask({ id: "b", title: "B", status: "queue" }),
		]);
		await select(user, "A");
		await select(user, "B");
		expect(
			screen.getAllByText("Different columns — move unavailable").length,
		).toBeGreaterThan(0);
		await drag.start("a");
		await drag.end("a", "in_progress");
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});

	it("drags a selection to a valid column, refuses an invalid one", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		await select(user, "A");
		await select(user, "B");
		drag.start("a");
		drag.over("a", "done");
		await drag.end("a", "done");
		expect(
			(await screen.findAllByText("Cannot move selected tasks to this column")).length,
		).toBeGreaterThan(0);
		await drag.end("a", "queue");
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenCalledTimes(2),
		);
	});

	it("asks before completing reviewed cards, then opens the PR flow", async () => {
		const user = userEvent.setup();
		const reviewed = (id: string, title: string) =>
			makeTask({
				id,
				title,
				status: "human_review",
				reviewReason: "completed",
				subtasks: [{ id: "s", title: "s", description: "", status: "completed" }] as never,
			});
		renderBoard([reviewed("a", "A"), reviewed("b", "B")]);
		await select(user, "A");
		await select(user, "B");
		await drag.end("a", "done");
		expect(await screen.findByText("Complete Selected Tasks")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(screen.getByRole("button", { name: /Complete & Create PRs/ }));
		await user.click(await screen.findByRole("button", { name: "Confirm & Create PRs" }));
		expect(await screen.findAllByRole("dialog")).not.toHaveLength(0);
	});

	it("opens the PR flow for selected done cards", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A", status: "done" })]);
		await select(user, "A");
		await user.click(screen.getByRole("button", { name: /Create PRs/ }));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("deletes the selection after confirmation, then undoes it", async () => {
		const user = userEvent.setup();
		installApi({
			deleteTask: vi.fn(async () => ({ success: true })),
			createTask: vi.fn(async () => ({ success: true, data: makeTask({ id: "a2" }) })),
		});
		// Cards with a worktree hold work: their deletion is confirmed first.
		renderBoard([
			makeTask({ id: "a", title: "A", location: "worktree" }),
			makeTask({ id: "b", title: "B" }),
		]);
		await select(user, "A");
		await user.click(
			within(bulkBar()).getByRole("button", { name: /^Delete$/ }),
		);
		expect(await screen.findByText("Delete Selected Tasks")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Delete 1 Tasks" }));
		expect(await screen.findByText("Successfully deleted 1 task(s)")).toBeInTheDocument();
		expect(api.fn("deleteTask")).toHaveBeenCalledWith("a");
		await user.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalled());
	});

	it("keeps the cards a bulk delete failed on selected", async () => {
		const user = userEvent.setup();
		installApi({ deleteTask: vi.fn(async () => ({ success: false, error: "locked" })) });
		renderBoard([makeTask({ id: "a", title: "A", location: "worktree" })]);
		await select(user, "A");
		await user.click(
			within(bulkBar()).getByRole("button", { name: /^Delete$/ }),
		);
		await user.click(await screen.findByRole("button", { name: "Delete 1 Tasks" }));
		expect(await screen.findByText("Failed to delete some tasks")).toBeInTheDocument();
		expect(screen.getByText("1 tasks selected")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Clear Selection/ }));
		expect(screen.queryByText("1 tasks selected")).not.toBeInTheDocument();
	});

	it("selects and deselects a whole column", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		const all = within(column("backlog")).getByRole("checkbox", { name: "Select all" });
		await user.click(all);
		expect(screen.getByText("2 tasks selected")).toBeInTheDocument();
		await user.click(
			within(column("backlog")).getByRole("checkbox", { name: "Deselect all" }),
		);
		expect(screen.queryByText("2 tasks selected")).not.toBeInTheDocument();
	});
});

describe("KanbanBoard — per-card actions", () => {
	it("deletes one card after confirmation and restores it on undo", async () => {
		const user = userEvent.setup();
		installApi({
			deleteTask: vi.fn(async () => ({ success: true })),
			createTask: vi.fn(async () => ({ success: true, data: makeTask() })),
		});
		renderBoard([makeTask({ location: "worktree" })]);
		await user.click(screen.getByTitle("Delete"));
		expect(await screen.findByText(/Are you sure you want to delete the task "Task one"/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Delete Permanently" }));
		expect(await screen.findByText('Task "Task one" deleted successfully')).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Undo" }));
		expect(await screen.findByText("Task restored successfully")).toBeInTheDocument();
	});

	it("reports an undo whose backup is gone", async () => {
		const user = userEvent.setup();
		installApi({
			deleteTask: vi.fn(async () => ({ success: true })),
			createTask: vi.fn(async () => ({ success: false, error: "disk full" })),
		});
		renderBoard([makeTask({ location: "worktree" })]);
		await user.click(screen.getByTitle("Delete"));
		await user.click(await screen.findByRole("button", { name: "Delete Permanently" }));
		await user.click(await screen.findByRole("button", { name: "Undo" }));
		expect(await screen.findByText("Failed to restore task")).toBeInTheDocument();
	});

	it("reports a single delete that failed", async () => {
		const user = userEvent.setup();
		installApi({ deleteTask: vi.fn(async () => ({ success: false, error: "locked" })) });
		renderBoard([makeTask({ location: "worktree" })]);
		await user.click(screen.getByTitle("Delete"));
		await user.click(await screen.findByRole("button", { name: "Delete Permanently" }));
		expect(await screen.findByText("Failed to delete some tasks")).toBeInTheDocument();
	});

	it("opens the duplicate dialog for a card", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask()]);
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("moves a card from its menu", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask()]);
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await pickSubmenuItem(user, "Move to", "Queue");
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("t1", "queue", undefined),
		);
	});

	it("opens the app preview and the PR files of a card", async () => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({ id: "d", title: "D", status: "done", metadata: { prUrl: "https://x/pull/1" } as never }),
		]);
		await user.click(screen.getByTitle("Preview application"));
		expect(useAppEmulatorStore.getState()).toMatchObject({ isOpen: true });
		await user.click(screen.getByRole("button", { name: "View modified files" }));
		await waitFor(() => expect(api.fn("getPRDetails")).toHaveBeenCalled());
		// PR number 1 of that URL, for that card.
		expect(api.fn("getPRDetails").mock.calls[0]).toEqual(
			expect.arrayContaining([1, "d"]),
		);
	});

	it("archives every done card of the board", async () => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({ id: "d1", title: "D1", status: "done" }),
			makeTask({ id: "d2", title: "D2", status: "done" }),
		]);
		await user.click(
			within(column("done")).getByRole("button", { name: "Archive all done tasks" }),
		);
		await waitFor(() =>
			expect(api.fn("archiveTasks")).toHaveBeenCalledWith("p1", ["d1", "d2"], undefined),
		);
	});

	it("queues the whole backlog, then promotes up to the parallel limit", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		await user.click(
			within(column("backlog")).getByRole("button", { name: "Column options" }),
		);
		await user.click(await screen.findByRole("menuitem", { name: "Add All to Queue" }));
		expect(await screen.findByText("Moved 2 tasks to queue.")).toBeInTheDocument();
		const promotions = api
			.fn("updateTaskStatus")
			.mock.calls.filter((c) => c[1] === "in_progress");
		expect(promotions).toHaveLength(1);
	});

	it("saves the queue settings", async () => {
		const user = userEvent.setup();
		installApi({ updateProjectSettings: vi.fn(async () => ({ success: true })) });
		renderBoard([]);
		await user.click(
			within(column("queue")).getByRole("button", { name: "Queue Settings" }),
		);
		const dialog = await screen.findByRole("dialog");
		const input = within(dialog).getByRole("spinbutton");
		await user.clear(input);
		await user.type(input, "4");
		await user.click(within(dialog).getByRole("button", { name: /Save/ }));
		await waitFor(() =>
			expect(api.fn("updateProjectSettings")).toHaveBeenCalledWith("p1", {
				maxParallelTasks: 4,
			}),
		);
	});

	it("reports queue settings that could not be saved", async () => {
		const user = userEvent.setup();
		installApi({ updateProjectSettings: vi.fn(async () => ({ success: false })) });
		renderBoard([]);
		await user.click(
			within(column("queue")).getByRole("button", { name: "Queue Settings" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: /Save/ }));
		expect(await screen.findByText(/Failed to save/i)).toBeInTheDocument();
	});

	it("promotes queued work when the queue is kicked", async () => {
		renderBoard([makeTask({ id: "q", title: "Q", status: "queue" })]);
		await act(async () => {
			kickQueue();
		});
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("q", "in_progress", undefined),
		);
	});
});

describe("KanbanBoard — trackers", () => {
	it("shows the Azure DevOps and Jira buttons with their connection state", async () => {
		installApi({
			checkAzureDevOpsConnection: vi.fn(async () => ({
				success: true,
				data: { connected: true, projectName: "Proj" },
			})),
			checkJiraConnection: vi.fn(async () => ({ success: true, data: { connected: false } })),
		});
		useProjectEnvStore.setState({
			envConfig: {
				azureDevOpsEnabled: true,
				azureDevOpsRepository: "repo-x",
				azureDevOpsPat: "x",
				jiraEnabled: true,
				jiraProjectKey: "PROJ",
				jiraApiToken: "y",
			},
		} as never);
		const user = userEvent.setup();
		renderBoard([]);
		const jira = await screen.findByTitle("Jira not connected — click to configure");
		expect(jira).toHaveTextContent("PROJ");
		expect(screen.getByRole("button", { name: /repo-x/ })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /repo-x/ }));
		await user.click(jira);
		expect(api.fn("checkAzureDevOpsConnection")).toHaveBeenCalledWith("p1");
	});

	it("sends an unconfigured tracker to its settings", async () => {
		installApi({
			checkAzureDevOpsConnection: vi.fn(async () => Promise.reject(new Error("x"))),
			checkJiraConnection: vi.fn(async () => Promise.reject(new Error("x"))),
		});
		useProjectEnvStore.setState({
			envConfig: { azureDevOpsEnabled: true, jiraEnabled: true },
		} as never);
		const onOpenAzureDevOpsSettings = vi.fn();
		const onOpenJiraSettings = vi.fn();
		const user = userEvent.setup();
		renderBoard([], { onOpenAzureDevOpsSettings, onOpenJiraSettings });
		await user.click(await screen.findByRole("button", { name: /Azure DevOps/ }));
		await user.click(screen.getByRole("button", { name: /^Jira/ }));
		expect(onOpenAzureDevOpsSettings).toHaveBeenCalled();
		expect(onOpenJiraSettings).toHaveBeenCalled();
	});
});

describe("KanbanBoard — importing work items", () => {
	function dropItems(
		target: HTMLElement,
		payload: unknown,
		// Off every column's (empty, jsdom) box: the board falls back to the
		// drop target's own column.
		at: { clientX: number; clientY: number } = { clientX: 100, clientY: 100 },
	) {
		const data = typeof payload === "string" ? payload : JSON.stringify(payload);
		const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.assign(event, {
			dataTransfer: { getData: () => data, dropEffect: "none" },
			...at,
		});
		act(() => {
			target.dispatchEvent(event);
		});
	}

	function dragOverItems(target: HTMLElement, payload: unknown, clientX = 5) {
		const event = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		const dataTransfer = { getData: () => JSON.stringify(payload), dropEffect: "none" };
		Object.assign(event, { dataTransfer, clientX, clientY: 5 });
		act(() => {
			target.dispatchEvent(event);
		});
		return dataTransfer;
	}

	it("imports dropped Azure DevOps items into the column, with their metadata", async () => {
		const user = userEvent.setup();
		installApi({
			createTask: vi.fn(async (_p: string, title: string) => ({
				success: true,
				data: makeTask({ id: `new-${title}`, title }),
			})),
		});
		const onRefresh = vi.fn();
		renderBoard([], { onRefresh });
		const items = [
			{ id: 101, title: "Login bug", url: "u1", state: "New", workItemType: "Bug", priority: 1, acceptanceCriteria: "- works" },
			{ id: 102, title: "Story", url: "u2", state: "New", workItemType: "User Story", priority: 2 },
			{ id: 103, title: "Chore", url: "u3", state: "New", workItemType: "Task", priority: 3 },
			{ id: 104, title: "Epic", url: "u4", state: "New", workItemType: "Epic", priority: 4 },
		];
		const over = dragOverItems(column("queue"), { type: "azure-devops-workitems", workItems: items });
		expect(over.dropEffect).toBe("copy");
		dropItems(column("queue"), { type: "azure-devops-workitems", workItems: items });
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(4));
		const [, , , metadata] = api.fn("createTask").mock.calls[0];
		expect(metadata).toMatchObject({
			azureDevOpsIdentifier: "101",
			priority: "urgent",
			category: "bug_fix",
			importSource: "azure-devops",
		});
		expect(api.fn("createTask").mock.calls[3][3]).toMatchObject({
			priority: "low",
			category: "documentation",
		});
		expect(onRefresh).toHaveBeenCalled();
		expect(
			await screen.findByText("4 work item(s) imported successfully"),
		).toBeInTheDocument();
	});

	it("imports dropped Jira issues with their attachments", async () => {
		const user = userEvent.setup();
		installApi({
			getJiraAttachments: vi
				.fn()
				.mockResolvedValueOnce({ success: true, data: [{ path: "/a.png" }] })
				.mockRejectedValue(new Error("403")),
			createTask: vi
				.fn()
				.mockResolvedValueOnce({ success: true, data: makeTask({ id: "j1" }) })
				.mockResolvedValueOnce({ success: false })
				.mockRejectedValueOnce(new Error("boom"))
				.mockResolvedValue({ success: true, data: makeTask({ id: "j4" }) }),
			updateTaskStatus: vi
				.fn()
				.mockResolvedValueOnce({ success: false, error: "nope" })
				.mockResolvedValue({ success: true }),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		renderBoard([]);
		const items = [
			{ id: "PROJ-1", title: "Crash", url: "j", state: "To Do", workItemType: "Bug", priority: "Highest" },
			{ id: "PROJ-2", title: "Feature", state: "To Do", workItemType: "Story", priority: "High" },
			{ id: "PROJ-3", title: "Chore", state: "To Do", workItemType: "Task", priority: "Medium" },
			{ id: "PROJ-4", title: "Spike", state: "To Do", workItemType: "Spike", priority: "Low" },
		];
		dropItems(column("backlog"), { type: "jira-workitems", workItems: items });
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(4));
		expect(api.fn("createTask").mock.calls[0][3]).toMatchObject({
			jiraIdentifier: "PROJ-1",
			priority: "urgent",
			category: "bug_fix",
			attachedImages: [{ path: "/a.png" }],
		});
		expect(api.fn("createTask").mock.calls[3][3]).toMatchObject({
			priority: "low",
			category: "documentation",
		});
		expect(warn).toHaveBeenCalled();
		await waitFor(() => expect(api.fn("getTasks")).toHaveBeenCalled());
		warn.mockRestore();
		error.mockRestore();
	});

	it("says so when no item could be imported", async () => {
		const user = userEvent.setup();
		installApi({ createTask: vi.fn(async () => ({ success: false })) });
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		renderBoard([]);
		dropItems(column("backlog"), {
			type: "azure-devops-workitems",
			workItems: [{ id: 1, title: "X", state: "New", workItemType: "Bug" }],
		});
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
		expect(await screen.findByText("Import failed")).toBeInTheDocument();
		error.mockRestore();
	});

	it("refuses a drop on a column that cannot receive imports", () => {
		renderBoard([]);
		const over = dragOverItems(column("done"), {
			type: "jira-workitems",
			workItems: [{ id: "A-1", title: "X" }],
		});
		expect(over.dropEffect).toBe("none");
		dropItems(column("done"), {
			type: "jira-workitems",
			workItems: [{ id: "A-1", title: "X", state: "To Do", workItemType: "Bug" }],
		});
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("reports a drop it cannot read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		renderBoard([]);
		dropItems(column("backlog"), "{not json");
		expect(error).toHaveBeenCalledWith("[Import] Failed to handle drop:", expect.any(Error));
		dragOverItems(column("backlog"), undefined);
		error.mockRestore();
	});

	it("highlights the column under an external drag and clears it at the end", () => {
		renderBoard([]);
		const backlog = column("backlog");
		backlog.getBoundingClientRect = () =>
			({ left: 0, right: 300, top: 0, bottom: 500 }) as DOMRect;
		act(() => {
			document.dispatchEvent(
				new CustomEvent("jira-drag-start", { detail: { workItems: [{ id: "A-1" }] } }),
			);
		});
		const event = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		const dataTransfer = { getData: () => "", dropEffect: "none" };
		Object.assign(event, { dataTransfer, clientX: 10, clientY: 10 });
		act(() => {
			document.dispatchEvent(event);
		});
		expect(dataTransfer.dropEffect).toBe("copy");
		expect(backlog.className).toContain("drop-zone-highlight");
		const away = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		Object.assign(away, { dataTransfer, clientX: 9000, clientY: 9000 });
		act(() => {
			document.dispatchEvent(away);
			document.dispatchEvent(new CustomEvent("jira-drag-end"));
			document.dispatchEvent(new Event("dragend"));
		});
		expect(backlog.className).not.toContain("drop-zone-highlight");
	});
});

describe("KanbanBoard — edge cases", () => {
	const select = async (user: ReturnType<typeof userEvent.setup>, title: string) =>
		user.click(screen.getByRole("checkbox", { name: `Select task: ${title}` }));

	it("unselects a card clicked twice", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask({ id: "a", title: "A" })]);
		await select(user, "A");
		expect(screen.getByText("1 tasks selected")).toBeInTheDocument();
		await select(user, "A");
		expect(screen.queryByText("1 tasks selected")).not.toBeInTheDocument();
	});

	it.each([
		["backlog", "In Progress"],
		["in_progress", "Queue"],
		["ai_review", "In Progress"],
		["human_review", "AI Review"],
	] as const)("moves %s cards to %s from the bulk bar", async (status, label) => {
		const user = userEvent.setup();
		renderBoard([
			makeTask({
				id: "a",
				title: "A",
				status,
				reviewReason: "completed",
				subtasks: [{ id: "s", title: "s", description: "", status: "completed" }] as never,
			}),
		]);
		await select(user, "A");
		await user.click(
			within(bulkBar()).getByRole("button", { name: new RegExp(`^${label}$`) }),
		);
		await waitFor(() => expect(api.fn("updateTaskStatus")).toHaveBeenCalled());
	});

	it("logs the archive of done cards the main process refused", async () => {
		const user = userEvent.setup();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		installApi({ archiveTasks: vi.fn(async () => ({ success: false, error: "ro" })) });
		renderBoard([makeTask({ id: "d", title: "D", status: "done" })]);
		await user.click(
			within(column("done")).getByRole("button", { name: "Archive all done tasks" }),
		);
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("[KanbanBoard] Failed to archive tasks:", "ro"),
		);
		error.mockRestore();
	});

	it("reports an undo that throws", async () => {
		const user = userEvent.setup();
		installApi({
			deleteTask: vi.fn(async () => ({ success: true })),
			createTask: vi.fn(async () => {
				throw new Error("ipc gone");
			}),
		});
		renderBoard([makeTask({ location: "worktree" })]);
		await user.click(screen.getByTitle("Delete"));
		await user.click(await screen.findByRole("button", { name: "Delete Permanently" }));
		await user.click(await screen.findByRole("button", { name: "Undo" }));
		expect(await screen.findByText("Failed to restore task")).toBeInTheDocument();
	});

	it("keeps the worktree when the person cancels its cleanup", async () => {
		const user = userEvent.setup();
		installApi({
			updateTaskStatus: vi.fn(async () => ({
				success: false,
				worktreeExists: true,
				worktreePath: "/wt/a",
			})),
		});
		renderBoard([makeTask({ id: "a", title: "A", status: "human_review" })]);
		await drag.end("a", "done");
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: /Cancel/ }));
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
		);
	});

	it("stops promoting after a run of failures and reports the skipped tasks", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		installApi({
			updateTaskStatus: vi.fn(async (_id: string, status: string) =>
				status === "in_progress" ? { success: false, error: "no" } : { success: true },
			),
		});
		const queued = Array.from({ length: 11 }, (_, i) =>
			makeTask({ id: `q${i}`, title: `Q${i}`, status: "queue" }),
		);
		renderBoard(queued);
		await act(async () => {
			kickQueue();
		});
		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[Queue] Stopping queue processing after 10 consecutive failures",
			),
		);
		expect(warn).toHaveBeenCalledWith("[Queue] Skipped 10 task(s) that failed to promote");
		warn.mockRestore();
		error.mockRestore();
	});

	it("counts only the backlog cards that reached the queue", async () => {
		const user = userEvent.setup();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		installApi({
			updateTaskStatus: vi
				.fn()
				.mockResolvedValueOnce({ success: false, error: "x" })
				.mockResolvedValue({ success: true }),
		});
		renderBoard([makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })]);
		await user.click(
			within(column("backlog")).getByRole("button", { name: "Column options" }),
		);
		await user.click(await screen.findByRole("menuitem", { name: "Add All to Queue" }));
		expect(await screen.findByText("Moved 1 tasks to queue.")).toBeInTheDocument();
		error.mockRestore();
	});

	it("warns when the new card order could not be saved", async () => {
		const save = vi
			.spyOn(useTaskStore.getState(), "saveTaskOrder")
			.mockReturnValue(false);
		useTaskStore.setState({ saveTaskOrder: save } as never);
		renderBoard([
			makeTask({ id: "a", title: "A", createdAt: new Date("2026-11-02") }),
			makeTask({ id: "b", title: "B", createdAt: new Date("2026-11-01") }),
		]);
		await drag.end("a", "b");
		expect(await screen.findByText("Reorder not saved")).toBeInTheDocument();
		save.mockRestore();
	});

	it("imports with a review before coding, and the acceptance criteria of a Jira issue", async () => {
		const user = userEvent.setup();
		installApi({
			createTask: vi.fn(async () => ({ success: true, data: makeTask({ id: "n" }) })),
		});
		renderBoard([]);
		const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.assign(event, {
			dataTransfer: {
				getData: () =>
					JSON.stringify({
						type: "jira-workitems",
						workItems: [
							{
								id: "P-9",
								title: "With AC",
								state: "To Do",
								workItemType: "Story",
								acceptanceCriteria: "- logs in\n- logs out",
							},
						],
					}),
			},
			clientX: 100,
			clientY: 100,
		});
		act(() => {
			column("in_progress").dispatchEvent(event);
		});
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("checkbox"));
		await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalled());
		expect(api.fn("createTask").mock.calls[0][3]).toMatchObject({
			requireReviewBeforeCoding: true,
			acceptanceCriteria: expect.arrayContaining([expect.anything()]),
		});
		expect(
			await screen.findByText('Work item "With AC" imported successfully'),
		).toBeInTheDocument();
	});

	it("finds the column under the pointer when the drop lands between cards", async () => {
		renderBoard([]);
		const queue = column("queue");
		queue.getBoundingClientRect = () =>
			({ left: 300, right: 600, top: 0, bottom: 800 }) as DOMRect;
		const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.assign(event, {
			dataTransfer: {
				getData: () =>
					JSON.stringify({
						type: "azure-devops-workitems",
						workItems: [{ id: 7, title: "Seven", state: "New", workItemType: "Bug" }],
					}),
			},
			clientX: 400,
			clientY: 400,
		});
		act(() => {
			document.body.dispatchEvent(event);
		});
		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
	});

	it("scrolls the board while an import is dragged near its edges", () => {
		renderBoard([]);
		const board = document.querySelector(".overflow-x-auto.overflow-y-hidden") as HTMLElement;
		board.getBoundingClientRect = () =>
			({ left: 0, right: 1000, top: 0, bottom: 800 }) as DOMRect;
		const scroll = vi.fn();
		board.scrollBy = scroll;
		const payload = JSON.stringify({ type: "jira-workitems", workItems: [] });
		for (const clientX of [10, 990]) {
			const over = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
			Object.assign(over, { dataTransfer: { getData: () => payload }, clientX, clientY: 5 });
			act(() => {
				board.dispatchEvent(over);
			});
		}
		act(() => {
			document.dispatchEvent(new CustomEvent("azure-devops-drag-start", { detail: {} }));
		});
		for (const clientX of [10, 990]) {
			const over = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
			Object.assign(over, { dataTransfer: undefined, clientX, clientY: 5 });
			act(() => {
				document.dispatchEvent(over);
			});
		}
		expect(scroll).toHaveBeenCalledWith({ left: -10, behavior: "auto" });
		expect(scroll).toHaveBeenCalledWith({ left: 10, behavior: "auto" });
	});

	it("does not highlight an element that only looks like a column", () => {
		renderBoard([]);
		const fake = document.createElement("div");
		fake.dataset.columnStatus = "nonsense";
		document.body.appendChild(fake);
		const over = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
		Object.assign(over, {
			dataTransfer: {
				getData: () => JSON.stringify({ type: "jira-workitems", workItems: [] }),
			},
			clientX: 5,
			clientY: 5,
		});
		act(() => {
			fake.dispatchEvent(over);
		});
		expect(column("backlog").className).not.toContain("drop-zone-highlight");
		fake.remove();
	});
});

describe("KanbanBoard — quick selection, deferred delete and undo", () => {
	const cardsOf = (status: string) => within(column(status)).getAllByRole("option");
	const three = () => [
		makeTask({ id: "a", title: "A", createdAt: new Date("2026-11-10T12:00:00Z") }),
		makeTask({ id: "b", title: "B", createdAt: new Date("2026-11-10T11:00:00Z") }),
		makeTask({ id: "c", title: "C", createdAt: new Date("2026-11-10T10:00:00Z") }),
	];
	/** The main process merges metadata like TASK_UPDATE does. */
	const updatesMerge = () =>
		installApi({
			updateTask: vi.fn(async (id: string, updates: { metadata?: object }) => {
				const task = useTaskStore.getState().tasks.find((t) => t.id === id);
				return {
					success: true,
					data: { ...task, metadata: { ...task?.metadata, ...updates.metadata } },
				};
			}),
		});
	const priorityOf = (id: string) =>
		useTaskStore.getState().tasks.find((t) => t.id === id)?.metadata?.priority;

	it("toggles with Ctrl+click, selects a range with Shift+click, clears on Escape", async () => {
		const onTaskClick = vi.fn();
		renderBoard(three(), { onTaskClick });
		const [a, , c] = cardsOf("backlog");
		fireEvent.click(a, { ctrlKey: true });
		expect(screen.getByText("1 tasks selected")).toBeInTheDocument();
		expect(fireEvent.mouseDown(c, { shiftKey: true })).toBe(false);
		fireEvent.click(c, { shiftKey: true });
		expect(screen.getByText("3 tasks selected")).toBeInTheDocument();
		fireEvent.click(a, { metaKey: true });
		expect(screen.getByText("2 tasks selected")).toBeInTheDocument();
		// A modifier on a control, or no modifier, keeps its meaning.
		const area = column("backlog").querySelector(".flex-1.min-h-0") as HTMLElement;
		expect(fireEvent.mouseDown(area, { shiftKey: true })).toBe(true);
		fireEvent.click(area, { ctrlKey: true });
		fireEvent.click(within(a).getByRole("button", { name: "Task actions" }), {
			ctrlKey: true,
		});
		expect(screen.getByText("2 tasks selected")).toBeInTheDocument();
		expect(onTaskClick).not.toHaveBeenCalled();
		// Away from the delete corner (jsdom cards measure 0 × 0).
		fireEvent.click(a, { clientX: 50, clientY: 50 });
		expect(onTaskClick).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(screen.queryByText(/tasks selected/)).toBeNull();
	});

	it("selects a column with Ctrl+A and deletes fresh cards after a delay, with undo", async () => {
		const user = userEvent.setup();
		installApi({ deleteTask: vi.fn(async () => ({ success: true })) });
		renderBoard(three());
		fireEvent.pointerOver(column("backlog"));
		fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
		expect(screen.getByText("3 tasks selected")).toBeInTheDocument();
		fireEvent.keyDown(document.body, { key: "Delete" });
		// No confirmation: the cards go now and are deleted later.
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.queryByRole("option", { name: "A" })).toBeNull();
		expect(await screen.findByText("Successfully deleted 3 task(s)")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Undo" }));
		expect(screen.getByRole("option", { name: "A" })).toBeInTheDocument();
		expect(api.fn("deleteTask")).not.toHaveBeenCalled();
		// The undo stack's entry is spent: Ctrl+Z has nothing more to do.
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(await screen.findByText(/Could not fully undo/)).toBeInTheDocument();
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(await screen.findByText("Nothing to undo")).toBeInTheDocument();
	});

	it("deletes one fresh card for good once the delay is over, Ctrl+Z before that", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		installApi({ deleteTask: vi.fn(async () => ({ success: true })) });
		renderBoard([makeTask(), makeTask({ id: "t2", title: "Task two" })]);
		fireEvent.click(within(screen.getByRole("option", { name: "Task two" })).getByTitle("Delete"));
		expect(screen.queryByRole("option", { name: "Task two" })).toBeNull();
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(await screen.findByText("Undone: deletion of 1 task")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Task two" })).toBeInTheDocument();

		fireEvent.click(within(screen.getByRole("option", { name: "Task one" })).getByTitle("Delete"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(8000);
		});
		expect(api.fn("deleteTask")).toHaveBeenCalledWith("t1");
	});

	it("says so when a delayed deletion fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		installApi({ deleteTask: vi.fn(async () => ({ success: false, error: "locked" })) });
		renderBoard([makeTask()]);
		fireEvent.click(screen.getByTitle("Delete"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(8000);
		});
		expect(await screen.findByText("Failed to delete some tasks")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Task one" })).toBeInTheDocument();
	});

	it("sets the type and priority of a selection, and undoes it", async () => {
		const user = userEvent.setup();
		updatesMerge();
		renderBoard(three());
		const [a, b] = cardsOf("backlog");
		fireEvent.click(a, { ctrlKey: true });
		fireEvent.click(b, { ctrlKey: true });
		await user.click(within(bulkBar()).getByRole("button", { name: "Priority" }));
		await user.click(await screen.findByRole("menuitem", { name: "High" }));
		await waitFor(() => expect(priorityOf("b")).toBe("high"));
		expect(priorityOf("a")).toBe("high");
		await user.click(within(bulkBar()).getByRole("button", { name: "Type" }));
		await user.click(await screen.findByRole("menuitem", { name: "Bug" }));
		await waitFor(() => expect(api.fn("updateTask")).toHaveBeenCalledTimes(4));

		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(await screen.findByText("Undone: type change")).toBeInTheDocument();
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		await waitFor(() => expect(priorityOf("a")).toBeUndefined());
	});

	it("says how many cards of a selection could not be changed", async () => {
		const user = userEvent.setup();
		renderBoard(three());
		fireEvent.click(cardsOf("backlog")[0], { ctrlKey: true });
		await user.click(within(bulkBar()).getByRole("button", { name: "Priority" }));
		await user.click(await screen.findByRole("menuitem", { name: "Low" }));
		expect(await screen.findByText("1 task could not be changed")).toBeInTheDocument();
	});

	it("acts on the whole selection from a selected card's right-click", async () => {
		const user = userEvent.setup();
		updatesMerge();
		renderBoard(three());
		const [a, b, c] = cardsOf("backlog");
		fireEvent.click(a, { ctrlKey: true });
		fireEvent.click(b, { ctrlKey: true });
		// Not on a card outside the selection.
		fireEvent.contextMenu(c, { clientX: 5, clientY: 5 });
		expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
		await user.keyboard("{Escape}");

		fireEvent.contextMenu(a, { clientX: 5, clientY: 5 });
		expect(screen.getByRole("menu", { name: "Task menu" })).toHaveTextContent(
			"2 tasks selected",
		);
		await pickSubmenuItem(user, "Priority", "Urgent");
		await waitFor(() => expect(priorityOf("b")).toBe("urgent"));

		fireEvent.contextMenu(a, { clientX: 5, clientY: 5 });
		await pickSubmenuItem(user, "Type", "Docs");
		await waitFor(() => expect(api.fn("updateTask")).toHaveBeenCalledTimes(4));

		fireEvent.contextMenu(a, { clientX: 5, clientY: 5 });
		await user.click(screen.getByRole("menuitem", { name: "Clear Selection" }));
		expect(screen.queryByText(/tasks selected/)).toBeNull();

		fireEvent.click(a, { ctrlKey: true });
		fireEvent.click(b, { ctrlKey: true });
		fireEvent.contextMenu(b, { clientX: 5, clientY: 5 });
		await user.click(screen.getByRole("menuitem", { name: "Delete" }));
		expect(screen.queryByRole("option", { name: "A" })).toBeNull();
		expect(screen.getByRole("option", { name: "C" })).toBeInTheDocument();
	});

	it("moves a card back on Ctrl+Z, unless it has moved on since", async () => {
		const user = userEvent.setup();
		renderBoard([makeTask()]);
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await pickSubmenuItem(user, "Move to", "Queue");
		await waitFor(() => expect(api.fn("updateTaskStatus")).toHaveBeenCalledTimes(1));
		useTaskStore.getState().updateTask("t1", { status: "queue" });
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenLastCalledWith("t1", "backlog", undefined),
		);
		expect(await screen.findByText("Undone: move of 1 task")).toBeInTheDocument();
	});
});
