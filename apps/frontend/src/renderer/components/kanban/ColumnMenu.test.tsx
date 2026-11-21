/**
 * A column's actions: one list in its "⋯" menu and on a right-click in the
 * column (not on a card, nor in a text field). Each action shows only where
 * it applies.
 */

import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Task, TaskStatus } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { TooltipProvider } from "../ui/tooltip";
import { DroppableColumn, type DroppableColumnProps } from "./KanbanColumn";

function makeTask(id: string, status: TaskStatus = "backlog"): Task {
	return {
		id,
		specId: `spec-${id}`,
		projectId: "p1",
		title: `Task ${id}`,
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
	} as Task;
}

function renderColumn(overrides: Partial<DroppableColumnProps> = {}) {
	const props: DroppableColumnProps = {
		status: "backlog",
		tasks: [],
		onTaskClick: vi.fn(),
		onStatusChange: vi.fn(),
		isOver: false,
		...overrides,
	};
	const utils = render(
		<DndContext>
			<TooltipProvider>
				<DroppableColumn {...props} />
			</TooltipProvider>
		</DndContext>,
	);
	const column = utils.container.querySelector<HTMLElement>("[data-column-status]");
	if (!column) throw new Error("no column");
	return { ...utils, props, column };
}

const items = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
const rightClick = (target: Element) =>
	fireEvent.contextMenu(target, { clientX: 20, clientY: 30 });

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
	useProjectStore.setState({ selectedProjectId: "p-menu", activeProjectId: null });
	useTaskStore.setState({ tasks: [] });
	api = installRendererApi();
});

afterEach(() => {
	api.restore();
});

describe("column right-click menu", () => {
	it("adds a card from Planification's menu", async () => {
		const user = userEvent.setup();
		const { column } = renderColumn({
			tasks: [makeTask("a")],
			onAddClick: vi.fn(),
			onQueueAll: vi.fn(),
			onToggleLocked: vi.fn(),
			onToggleCollapsed: vi.fn(),
		});
		rightClick(column);
		expect(screen.getByRole("menu", { name: "Column options" })).toBeInTheDocument();
		expect(items()).toEqual([
			"Add a card",
			"Add All to Queue",
			"Lock column width",
			"Collapse column",
		]);
		await user.click(screen.getByRole("menuitem", { name: "Add a card" }));
		expect(screen.getByRole("textbox", { name: "Describe the new card" })).toBeInTheDocument();
	});

	it("leaves a right-click on a card or in a text field to them", async () => {
		const user = userEvent.setup();
		const { container, column } = renderColumn({
			tasks: [makeTask("a")],
			onAddClick: vi.fn(),
		});
		const card = container.querySelector(".kanban-card");
		if (!card) throw new Error("no card");
		rightClick(card);
		expect(screen.queryByRole("menu", { name: "Column options" })).toBeNull();
		await user.click(within(column).getByRole("button", { name: "Add a card" }));
		rightClick(screen.getByRole("textbox", { name: "Describe the new card" }));
		expect(screen.queryByRole("menu", { name: "Column options" })).toBeNull();
	});

	it("offers the queue settings in File d'attente, the archive in Done", () => {
		const first = renderColumn({ status: "queue", onQueueSettings: vi.fn(), onQueueAll: vi.fn() });
		rightClick(first.column);
		expect(items()).toEqual(["Queue Settings"]);
		first.unmount();

		const onArchiveAll = vi.fn();
		const done = renderColumn({
			status: "done",
			tasks: [makeTask("d", "done")],
			onArchiveAll,
			archivedCount: 2,
			onToggleArchived: vi.fn(),
		});
		rightClick(done.column);
		expect(items()).toEqual(["Archive all done tasks", "Show archived"]);
		fireEvent.click(screen.getByRole("menuitem", { name: "Archive all done tasks" }));
		expect(onArchiveAll).toHaveBeenCalledTimes(1);
	});

	it("hides archiving while the archived cards show", () => {
		const { column } = renderColumn({
			status: "done",
			tasks: [makeTask("d", "done")],
			showArchived: true,
			onArchiveAll: vi.fn(),
			archivedCount: 1,
			onToggleArchived: vi.fn(),
			isLocked: true,
			onToggleLocked: vi.fn(),
		});
		rightClick(column);
		expect(items()).toEqual(["Hide archived", "Unlock column width"]);
	});

	it("selects then deselects every card of the column", async () => {
		const user = userEvent.setup();
		const onSelectAll = vi.fn();
		const onDeselectAll = vi.fn();
		const tasks = [makeTask("h", "human_review")];
		const { column, rerender } = renderColumn({
			status: "human_review",
			tasks,
			selectedTaskIds: new Set(),
			onSelectAll,
			onDeselectAll,
		});
		rightClick(column);
		await user.click(screen.getByRole("menuitem", { name: "Select all" }));
		expect(onSelectAll).toHaveBeenCalledTimes(1);
		rerender(
			<DndContext>
				<TooltipProvider>
					<DroppableColumn
						status="human_review"
						tasks={tasks}
						onTaskClick={vi.fn()}
						onStatusChange={vi.fn()}
						isOver={false}
						selectedTaskIds={new Set(["h"])}
						onSelectAll={onSelectAll}
						onDeselectAll={onDeselectAll}
					/>
				</TooltipProvider>
			</DndContext>,
		);
		rightClick(column);
		await user.click(screen.getByRole("menuitem", { name: "Deselect all" }));
		expect(onDeselectAll).toHaveBeenCalledTimes(1);
	});

	it("has no menu where there is nothing to do", () => {
		const empty = renderColumn({
			status: "done",
			onArchiveAll: vi.fn(),
			onSelectAll: vi.fn(),
			onDeselectAll: vi.fn(),
			onToggleArchived: vi.fn(),
		});
		expect(rightClick(empty.column)).toBe(true);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("button", { name: "Column options" })).toBeNull();
		empty.unmount();

		const noArchive = renderColumn({ status: "done", archivedCount: 0, onToggleArchived: vi.fn() });
		expect(rightClick(noArchive.column)).toBe(true);
		noArchive.unmount();

		const backlog = renderColumn({ onQueueAll: vi.fn(), onSelectAll: vi.fn() });
		expect(rightClick(backlog.column)).toBe(true);
	});

	it("has no menu while collapsed", () => {
		const { container } = renderColumn({
			isCollapsed: true,
			onToggleCollapsed: vi.fn(),
			onToggleLocked: vi.fn(),
		});
		const column = container.querySelector("[data-column-status]");
		if (!column) throw new Error("no column");
		expect(rightClick(column)).toBe(true);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("shows the same list in the header menu, without adding a card", async () => {
		const user = userEvent.setup();
		const onToggleCollapsed = vi.fn();
		renderColumn({
			tasks: [makeTask("a")],
			onAddClick: vi.fn(),
			onToggleCollapsed,
		});
		await user.click(screen.getByRole("button", { name: "Column options" }));
		expect(items()).toEqual(["Collapse column"]);
		await user.click(screen.getByRole("menuitem", { name: "Collapse column" }));
		expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
	});
});
