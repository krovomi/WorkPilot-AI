/**
 * KanbanColumn — one column of the board, rendered on its own: empty states,
 * the render cap on very large columns, the WIP limit popover, and the memo
 * comparators the board relies on to skip re-renders.
 */

import { DndContext } from "@dnd-kit/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Task, TaskStatus } from "../../../shared/types";
import { useSettingsStore } from "../../stores/settings-store";
import { TooltipProvider } from "../ui/tooltip";
import {
	COLUMN_RENDER_CAP,
	DroppableColumn,
	type DroppableColumnProps,
	droppableColumnPropsAreEqual,
	getEmptyStateContent,
	tasksAreEquivalent,
	WipLimitPopover,
} from "./KanbanColumn";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		specId: `spec-${id}`,
		projectId: "p1",
		title: `Task ${id}`,
		description: "",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

function baseProps(
	overrides: Partial<DroppableColumnProps> = {},
): DroppableColumnProps {
	return {
		status: "backlog",
		tasks: [],
		onTaskClick: vi.fn(),
		onStatusChange: vi.fn(),
		isOver: false,
		...overrides,
	};
}

function renderColumn(overrides: Partial<DroppableColumnProps> = {}) {
	const props = baseProps(overrides);
	const utils = render(
		<DndContext>
			<TooltipProvider>
				<DroppableColumn {...props} />
			</TooltipProvider>
		</DndContext>,
	);
	return { ...utils, props };
}

let api: RendererApi;

beforeAll(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		},
	);
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
	api = installRendererApi();
});

afterEach(() => {
	api.restore();
});

describe("empty columns", () => {
	const cases: Array<[TaskStatus, string, string | undefined]> = [
		["backlog", "No tasks planned", "column-backlog"],
		["queue", "Queue is empty", "column-queue"],
		["in_progress", "Nothing running", "column-in-progress"],
		["ai_review", "No tasks in review", "column-ai-review"],
		["human_review", "Nothing to review", "column-human-review"],
		["build_failed", "No red builds", "column-build-failed"],
		["pr_created", "No PR waiting", "column-pr-open"],
		["done", "No completed tasks", "column-done"],
	];

	it.each(cases)("%s says %s and wears its own accent", (status, message, accent) => {
		const { container } = renderColumn({ status });
		expect(screen.getByText(message)).toBeInTheDocument();
		const column = container.querySelector(`[data-column-status="${status}"]`);
		expect(column).toHaveClass(accent as string);
	});

	it("an unknown status falls back to a neutral message and border", () => {
		const status = "error" as TaskStatus;
		expect(getEmptyStateContent(status, (k) => k)).toMatchObject({
			message: "kanban.emptyDefault",
		});
		const { container } = renderColumn({ status });
		expect(container.querySelector('[data-column-status="error"]')).toHaveClass(
			"border-t-muted-foreground/30",
		);
	});

	it("an empty column under a drag invites the drop", () => {
		renderColumn({ isOver: true });
		expect(screen.getByText("Drop here")).toBeInTheDocument();
	});

	it("a collapsed empty column shows its count, no message, and expands on click", async () => {
		const onToggleCollapsed = vi.fn();
		const { container } = renderColumn({
			status: "queue",
			isCollapsed: true,
			isImportForbidden: true,
			onToggleCollapsed,
		});
		expect(screen.queryByText("Queue is empty")).toBeNull();
		expect(container.querySelector(".kanban-col-count")).toHaveTextContent("0");
		await userEvent.click(screen.getByRole("button", { name: "Expand column" }));
		expect(onToggleCollapsed).toHaveBeenCalledOnce();
	});

	it("a collapsed column under a drag invites the drop", () => {
		renderColumn({ isCollapsed: true, isOver: true });
		expect(screen.getByText("Drop here")).toBeInTheDocument();
	});
});

describe("render cap", () => {
	const many = Array.from({ length: COLUMN_RENDER_CAP + 5 }, (_, i) =>
		makeTask(`t${i}`),
	);

	it("mounts the first cards and reveals the rest on demand", async () => {
		renderColumn({ tasks: many });
		expect(screen.getByText(`Task t${COLUMN_RENDER_CAP - 1}`)).toBeInTheDocument();
		expect(screen.queryByText(`Task t${COLUMN_RENDER_CAP}`)).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
		expect(screen.getByText(`Task t${COLUMN_RENDER_CAP + 4}`)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(screen.queryByText(`Task t${COLUMN_RENDER_CAP}`)).toBeNull();
	});

	it("a collapsed column keeps the cap without the toggle", () => {
		renderColumn({ tasks: many, isCollapsed: true });
		expect(screen.queryByRole("button", { name: /Show 5 more/ })).toBeNull();
		expect(screen.queryByText(`Task t${COLUMN_RENDER_CAP}`)).toBeNull();
	});

	it("a collapsed column still lists its cards under the count", () => {
		const { container } = renderColumn({
			tasks: [makeTask("solo")],
			isCollapsed: true,
		});
		expect(screen.getByText("Task solo")).toBeInTheDocument();
		expect(container.querySelector(".kanban-col-count")).toHaveTextContent("1");
	});
});

describe("WIP limit", () => {
	function renderPopover(wipLimit?: number) {
		const onSetWipLimit = vi.fn();
		render(
			<TooltipProvider>
				<WipLimitPopover wipLimit={wipLimit} onSetWipLimit={onSetWipLimit} />
			</TooltipProvider>,
		);
		return onSetWipLimit;
	}

	async function open() {
		await userEvent.click(screen.getByRole("button", { name: "Set WIP limit" }));
		return screen.getByRole("spinbutton");
	}

	it("saves a number typed then confirmed with Enter", async () => {
		const onSetWipLimit = renderPopover();
		const input = await open();
		await userEvent.type(input, "4{Enter}");
		expect(onSetWipLimit).toHaveBeenCalledWith(4);
	});

	it("treats zero or an empty field as no limit", async () => {
		const onSetWipLimit = renderPopover(3);
		const input = await open();
		expect(input).toHaveValue(3);
		await userEvent.clear(input);
		await userEvent.type(input, "0");
		const confirm = screen
			.getAllByRole("button", { name: "Set WIP limit" })
			.find((b) => b.closest("[role='dialog']"));
		await userEvent.click(confirm as HTMLElement);
		expect(onSetWipLimit).toHaveBeenCalledWith(undefined);
	});

	it("removes an existing limit", async () => {
		const onSetWipLimit = renderPopover(3);
		await open();
		await userEvent.click(screen.getByRole("button", { name: "Remove limit" }));
		expect(onSetWipLimit).toHaveBeenCalledWith(undefined);
	});

	it("offers no removal when there is no limit", async () => {
		renderPopover();
		await open();
		expect(screen.queryByRole("button", { name: "Remove limit" })).toBeNull();
	});

	it("the column header shows the count against the limit and warns past it", () => {
		const { container } = renderColumn({
			tasks: [makeTask("a"), makeTask("b"), makeTask("c")],
			wipLimit: 2,
			onSetWipLimit: vi.fn(),
		});
		const count = container.querySelector(".kanban-col-count");
		expect(count).toHaveTextContent("3/2");
		expect(count).toHaveAttribute("data-warn");
		expect(within(container).getByText("3 tasks, limit 2")).toBeInTheDocument();
		expect(container.querySelector(".kanban-col-gauge-bar > span")).toHaveStyle({ width: "100%" });
	});

	it("a WIP limit not yet exceeded shows the count calmly", () => {
		const { container } = renderColumn({
			tasks: [makeTask("a")],
			wipLimit: 2,
			onSetWipLimit: vi.fn(),
		});
		const count = container.querySelector(".kanban-col-count");
		expect(count).toHaveTextContent("1/2");
		expect(count).not.toHaveAttribute("data-warn");
	});

	it("« En cours » shows its parallel slots and turns its icon while agents work", () => {
		const { container } = renderColumn({
			status: "in_progress",
			tasks: [makeTask("a", { status: "in_progress" }), makeTask("b", { status: "in_progress" })],
			maxParallelTasks: 2,
		});
		expect(container.querySelector(".kanban-col-count")).toHaveAttribute("data-warn");
		expect(container.querySelectorAll(".kanban-col-gauge-seg[data-on]")).toHaveLength(2);
		expect(within(container).getByText("2 of 2 parallel slots in use")).toBeInTheDocument();
		expect(container.querySelector(".kanban-col-icon-busy")).not.toBeNull();
	});
});

describe("column summary", () => {
	const urgent = () =>
		[makeTask("u", { metadata: { priority: "urgent" } } as Partial<Task>)];

	const initial = useSettingsStore.getState().settings;
	afterEach(() => {
		useSettingsStore.setState({ settings: initial });
	});

	it("sums the column up under its title", () => {
		renderColumn({ tasks: urgent() });
		expect(screen.getByLabelText("Column summary")).toHaveTextContent("1 urgent");
	});

	it("is hidden when the setting is off", () => {
		useSettingsStore.setState({ settings: { ...initial, kanbanColumnSummary: false } });
		const { container } = renderColumn({ tasks: urgent() });
		expect(screen.queryByLabelText("Column summary")).toBeNull();
		expect(container.querySelector(".kanban-col-meta")).toBeNull();
	});

	it("keeps the gauge row when the setting is off and the column has a limit", () => {
		useSettingsStore.setState({ settings: { ...initial, kanbanColumnSummary: false } });
		const { container } = renderColumn({ tasks: urgent(), wipLimit: 3 });
		expect(container.querySelector(".kanban-col-meta .kanban-col-gauge")).not.toBeNull();
		expect(screen.queryByLabelText("Column summary")).toBeNull();
	});

	it("keeps an empty row in a column with nothing to sum up, so the cards line up", () => {
		const { container } = renderColumn({ status: "ai_review", tasks: [makeTask("a")] });
		expect(container.querySelector(".kanban-col-meta")).toBeEmptyDOMElement();
	});
});

describe("memo comparators", () => {
	const a = makeTask("a");
	const b = makeTask("b");

	it("tasks are equivalent when ids, status, phase and update time match", () => {
		expect(tasksAreEquivalent([a, b], [a, b])).toBe(true);
		expect(tasksAreEquivalent([a, b], [{ ...a }, { ...b }])).toBe(true);
	});

	it("tasks differ on length, order, status, phase or update time", () => {
		expect(tasksAreEquivalent([a], [a, b])).toBe(false);
		expect(tasksAreEquivalent([a, b], [b, a])).toBe(false);
		expect(tasksAreEquivalent([a], [{ ...a, status: "queue" }])).toBe(false);
		expect(
			tasksAreEquivalent(
				[a],
				[{ ...a, executionProgress: { phase: "coding" } } as Task],
			),
		).toBe(false);
		expect(
			tasksAreEquivalent([a], [{ ...a, updatedAt: new Date("2026-11-02") }]),
		).toBe(false);
	});

	it("the column skips a re-render only when nothing it shows changed", () => {
		const props = baseProps({ tasks: [a, b], selectedTaskIds: new Set(["a"]) });
		expect(droppableColumnPropsAreEqual(props, { ...props })).toBe(true);
		expect(
			droppableColumnPropsAreEqual(props, {
				...props,
				tasks: [{ ...a }, { ...b }],
				selectedTaskIds: new Set(["a"]),
			}),
		).toBe(true);

		const changes: Partial<DroppableColumnProps>[] = [
			{ status: "queue" },
			{ isOver: true },
			{ isImportForbidden: true },
			{ onTaskClick: vi.fn() },
			{ onStatusChange: vi.fn() },
			{ onAddClick: vi.fn() },
			{ onArchiveAll: vi.fn() },
			{ onQueueSettings: vi.fn() },
			{ onQueueAll: vi.fn() },
			{ maxParallelTasks: 2 },
			{ wipLimit: 2 },
			{ onSetWipLimit: vi.fn() },
			{ archivedCount: 1 },
			{ showArchived: true },
			{ onToggleArchived: vi.fn() },
			{ onSelectAll: vi.fn() },
			{ onDeselectAll: vi.fn() },
			{ onToggleSelect: vi.fn() },
			{ onCardSelectGesture: vi.fn() },
			{ isCollapsed: true },
			{ columnWidth: 300 },
			{ isResizing: true },
			{ onResizeStart: vi.fn() },
			{ onResizeEnd: vi.fn() },
			{ isLocked: true },
			{ onToggleLocked: vi.fn() },
			{ onViewPRFiles: vi.fn() },
			{ onPreviewApp: vi.fn() },
			{ dragHandleProps: { listeners: undefined, attributes: {} as never } },
			{ selectedTaskIds: undefined },
			{ selectedTaskIds: new Set(["a", "b"]) },
			{ selectedTaskIds: new Set(["b"]) },
			{ tasks: [a] },
		];
		for (const change of changes) {
			expect(
				droppableColumnPropsAreEqual(props, { ...props, ...change }),
				JSON.stringify(Object.keys(change)),
			).toBe(false);
		}
	});
});
