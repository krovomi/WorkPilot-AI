/**
 * Quick add from a column: the box opens from "+", the row under the cards,
 * a double-click on the empty space or N, and only in Planification and
 * File d'attente. Enter creates and keeps the box open; a pasted list makes
 * one card per line; File d'attente queues what it creates.
 */

import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Task, TaskStatus } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { loadDraft, useTaskStore } from "../../stores/task-store";
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
		onAddClick: vi.fn(),
		...overrides,
	};
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
let created = 0;
// Text closed without creating is kept per project for the window's life:
// a project of its own per test keeps the tests apart.
let projectId = "p0";
let run = 0;

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
	created = 0;
	run++;
	projectId = `p${run}`;
	localStorage.clear();
	useProjectStore.setState({ selectedProjectId: projectId, activeProjectId: null });
	useTaskStore.setState({ tasks: [] });
	api = installRendererApi({
		createTask: vi.fn(async (_projectId: string, title: string) => {
			created++;
			return { success: true, data: { ...makeTask(`new-${created}`), title } };
		}),
	});
});

afterEach(() => {
	api.restore();
});

const box = () => screen.getByRole("textbox", { name: "Describe the new card" });

describe("quick add in a column", () => {
	it("opens from the header + and creates a card on Enter", async () => {
		renderColumn();
		await userEvent.click(
			screen.getByRole("button", { name: "Add new task to backlog" }),
		);
		await userEvent.type(box(), "Export the board as CSV{Enter}");

		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(1));
		const [calledFor, title, description, metadata] =
			api.fn("createTask").mock.calls[0];
		expect(calledFor).toBe(projectId);
		expect(title).toBe("Export the board as CSV");
		expect(description).toBe("Export the board as CSV");
		expect(metadata).toMatchObject({ sourceType: "manual", engineLocked: true });
		// The box stays open, empty, for the next card.
		await waitFor(() => expect(box()).toHaveValue(""));
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});

	it("opens from the row under the cards and closes on Escape", async () => {
		renderColumn({ tasks: [makeTask("a")] });
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		expect(box()).toHaveFocus();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("textbox", { name: "Describe the new card" })).toBeNull();
	});

	it("gives back the text closed without creating", async () => {
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		await userEvent.type(box(), "Half a thought");
		await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		expect(box()).toHaveValue("Half a thought");
	});

	it("creates one card per pasted line", async () => {
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		box().focus();
		await userEvent.paste("- Export CSV\n- Fix the label filter\n- Document webhooks");
		const toggle = screen.getByRole("button", { name: "One card per line (3)" });
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(screen.getByRole("button", { name: "Create 3 cards" }));

		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(3));
		expect(api.fn("createTask").mock.calls.map((call) => call[1])).toEqual([
			"Export CSV",
			"Fix the label filter",
			"Document webhooks",
		]);
	});

	it("keeps a pasted list as one card when asked", async () => {
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		box().focus();
		await userEvent.paste("Context line\nSecond line");
		await userEvent.click(screen.getByRole("button", { name: "One card per line (2)" }));
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(1));
		expect(api.fn("createTask").mock.calls[0].slice(1, 3)).toEqual([
			"",
			"Context line\nSecond line",
		]);
	});

	it("records the type and priority picked in the box", async () => {
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		await userEvent.click(screen.getByRole("button", { name: "Type" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Bug" }));
		await userEvent.click(screen.getByRole("button", { name: "Priority" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "High" }));
		await userEvent.type(box(), "Filter ignores accents{Enter}");

		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(1));
		expect(api.fn("createTask").mock.calls[0][3]).toMatchObject({
			kind: "bug_fix",
			kindSource: "user",
			priority: "high",
		});
	});

	it("takes back a type and a priority picked by mistake", async () => {
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		await userEvent.click(screen.getByRole("button", { name: "Type" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Bug" }));
		await userEvent.click(screen.getByRole("button", { name: "Type" }));
		await userEvent.click(
			await screen.findByRole("menuitem", { name: "No type (detected automatically)" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Priority" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "High" }));
		await userEvent.click(screen.getByRole("button", { name: "Priority" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "No priority" }));
		await userEvent.type(box(), "Plain card{Enter}");

		await waitFor(() => expect(api.fn("createTask")).toHaveBeenCalledTimes(1));
		const metadata = api.fn("createTask").mock.calls[0][3];
		expect(metadata.kind).toBeUndefined();
		expect(metadata.priority).toBeUndefined();
	});

	it("queues what it creates in File d'attente", async () => {
		renderColumn({ status: "queue" });
		const [headerPlus] = screen.getAllByRole("button", { name: "Add and queue" });
		await userEvent.click(headerPlus);
		await userEvent.type(box(), "Warm the cache{Enter}");
		await waitFor(() =>
			expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith(
				"new-1",
				"queue",
				undefined,
			),
		);
	});

	it("keeps the text and says so when creating fails", async () => {
		api.restore();
		api = installRendererApi({
			createTask: vi.fn(async () => ({ success: false, error: "disk full" })),
		});
		renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		await userEvent.type(box(), "Something{Enter}");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The card could not be created",
		);
		expect(box()).toHaveValue("Something");
	});

	it("hands the text to the full wizard", async () => {
		const { props } = renderColumn();
		await userEvent.click(screen.getByRole("button", { name: "Add a card" }));
		await userEvent.type(box(), "Needs attachments");
		await userEvent.click(screen.getByRole("button", { name: "More options…" }));
		expect(props.onAddClick).toHaveBeenCalledTimes(1);
		expect(loadDraft(projectId)?.description).toBe("Needs attachments");
		expect(screen.queryByRole("textbox", { name: "Describe the new card" })).toBeNull();
	});

	it("opens on a double-click in the empty space, not on a card", async () => {
		const { container } = renderColumn({ tasks: [makeTask("a")] });
		const card = container.querySelector(".kanban-card");
		if (card) fireEvent.doubleClick(card);
		expect(screen.queryByRole("textbox", { name: "Describe the new card" })).toBeNull();
		const area = container.querySelector("[data-column-status] .flex-1.min-h-0");
		expect(area).not.toBeNull();
		if (area) fireEvent.doubleClick(area);
		expect(box()).toBeInTheDocument();
	});

	it("opens Planification's box on N, never while typing", async () => {
		renderColumn();
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		fireEvent.keyDown(input, { key: "n" });
		expect(screen.queryByRole("textbox", { name: "Describe the new card" })).toBeNull();
		input.remove();

		fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
		expect(screen.queryByRole("textbox", { name: "Describe the new card" })).toBeNull();
		fireEvent.keyDown(document.body, { key: "n" });
		expect(box()).toBeInTheDocument();
	});

	it("is not offered in agent columns nor without a way to add", () => {
		for (const status of ["in_progress", "ai_review", "human_review", "done"] as const) {
			const { unmount } = renderColumn({ status });
			expect(screen.queryByRole("button", { name: "Add a card" })).toBeNull();
			unmount();
		}
		renderColumn({ onAddClick: undefined });
		expect(screen.queryByRole("button", { name: "Add a card" })).toBeNull();
	});
});
