/**
 * SortableTaskCard — the Kanban card as the column places it: draggable, with
 * the "aging" accent of a card idle for too long. The real TaskCard and stores
 * render inside; only the IPC bridge is a stand-in.
 */
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
	afterAll,
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
import i18n from "../../../shared/i18n";
import type { Task, TaskStatus } from "../../../shared/types";
import { useKanbanBlockerStore } from "../../stores/kanban-blocker-store";
import { useKanbanConflictStore } from "../../stores/kanban-conflict-store";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { SortableTaskCard } from "../SortableTaskCard";
import { TooltipProvider } from "../ui/tooltip";

const HOUR = 3_600_000;

function makeTask(overrides: Partial<Task> = {}, idleHours = 0): Task {
	const updatedAt = new Date(Date.now() - idleHours * HOUR);
	return {
		id: "task-1",
		specId: "001-card",
		projectId: "project-1",
		title: "Add login page",
		description: "Build the login form",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: updatedAt,
		updatedAt,
		...overrides,
	} as Task;
}

type CardProps = Parameters<typeof SortableTaskCard>[0];

function board(tasks: Task[], props: Partial<CardProps> = {}, onClick = vi.fn()) {
	return (
		<TooltipProvider>
			<DndContext>
				<SortableContext items={tasks.map((t) => t.id)}>
					{tasks.map((task) => (
						<SortableTaskCard key={task.id} task={task} onClick={onClick} {...props} />
					))}
				</SortableContext>
			</DndContext>
		</TooltipProvider>
	);
}

function handleOf(title: string): HTMLElement {
	return screen
		.getByRole("heading", { name: title })
		.closest('[aria-roledescription="sortable"]') as HTMLElement;
}

// jsdom lays nothing out; stack the cards 100px apart so dnd-kit can tell
// which one the dragged card is over.
const realRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = vi.fn();
			disconnect = vi.fn();
			unobserve = vi.fn();
		},
	);
	Element.prototype.getBoundingClientRect = function (this: Element) {
		const title =
			this.getAttribute?.("aria-roledescription") === "sortable"
				? this.querySelector("h3")?.textContent
				: undefined;
		const index = ["Add login page", "Add logout"].indexOf(title ?? "");
		if (index < 0) return realRect.call(this);
		const top = index * 100;
		return {
			x: 0,
			y: top,
			top,
			left: 0,
			width: 200,
			height: 100,
			right: 200,
			bottom: top + 100,
			toJSON: () => ({}),
		} as DOMRect;
	};
});
afterAll(() => {
	Element.prototype.getBoundingClientRect = realRect;
	vi.unstubAllGlobals();
});

let api: RendererApi;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	api = installRendererApi();
	useTaskStore.setState({ tasks: [], pipelineStatuses: {}, jumpToTaskId: null });
	useProjectStore.setState({
		projects: [
			{
				id: "project-1",
				name: "Demo",
				path: "/work/demo",
				autoBuildPath: "",
				settings: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never,
		],
	});
	useKanbanConflictStore.setState({ conflicts: {} });
	useKanbanBlockerStore.setState({ blockers: {} });
});

afterEach(() => {
	api.restore();
});

describe("SortableTaskCard — aging accent", () => {
	it("shows no accent on a card that moved recently", () => {
		render(board([makeTask({ status: "in_progress" }, 1)]));
		expect(screen.getByRole("heading", { name: "Add login page" })).toBeInTheDocument();
		expect(screen.queryByRole("img", { name: /^Idle for/ })).not.toBeInTheDocument();
	});

	it("marks an aging card in amber, in English units", () => {
		render(board([makeTask({ status: "in_progress" }, 5.5)]));
		const accent = screen.getByRole("img", { name: "Idle for 5h" });
		expect(accent).toHaveAttribute("title", "Idle for 5h");
		expect(accent).toHaveClass("bg-warning/70");
	});

	it("marks a stuck card in red, in days", () => {
		render(board([makeTask({ status: "in_progress" }, 50)]));
		const accent = screen.getByRole("img", { name: "Idle for 2d" });
		expect(accent).toHaveClass("bg-destructive/80");
	});

	it("writes the duration in French in French", async () => {
		await i18n.changeLanguage("fr");
		render(board([makeTask({ status: "in_progress" }, 50)]));
		expect(screen.getByRole("img", { name: "Inactive depuis 2j" })).toBeInTheDocument();
	});
});

describe("SortableTaskCard — card", () => {
	it("opens the task, and shows the task the column gives", () => {
		const onClick = vi.fn();
		const task = makeTask();
		const { rerender } = render(board([task], {}, onClick));
		fireEvent.click(screen.getByRole("heading", { name: "Add login page" }));
		expect(onClick).toHaveBeenCalledTimes(1);

		// The same props again: the card stays as it is.
		rerender(board([task], {}, onClick));
		expect(screen.getByRole("heading", { name: "Add login page" })).toBeInTheDocument();

		rerender(board([{ ...task, title: "Add sign-in page" }], {}, onClick));
		expect(
			screen.getByRole("heading", { name: "Add sign-in page" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("heading", { name: "Add sign-in page" }));
		expect(onClick).toHaveBeenCalledTimes(2);
	});

	it("passes the selection of the Human Review column to the card", () => {
		const onToggleSelect = vi.fn();
		render(
			board([makeTask({ status: "human_review" })], {
				isSelectable: true,
				isSelected: false,
				onToggleSelect,
			}),
		);
		fireEvent.click(screen.getByRole("checkbox"));
		expect(onToggleSelect).toHaveBeenCalledTimes(1);
	});
});

describe("SortableTaskCard — drag", () => {
	it("fades the dragged card, hides its accent, and rings the card it is over", async () => {
		render(
			board([
				makeTask({ status: "in_progress" }, 50),
				makeTask({ id: "task-2", title: "Add logout" }),
			]),
		);
		const dragged = handleOf("Add login page");
		const target = handleOf("Add logout");
		expect(screen.getByRole("img", { name: "Idle for 2d" })).toBeInTheDocument();
		await act(async () => {
			fireEvent.keyDown(dragged, { code: "Space", key: " " });
		});
		expect(dragged).toHaveClass("opacity-40");
		expect(dragged.style.zIndex).toBe("50");
		expect(screen.queryByRole("img", { name: /^Idle for/ })).not.toBeInTheDocument();
		for (let i = 0; i < 4; i++) {
			await act(async () => {
				fireEvent.keyDown(dragged, { code: "ArrowDown", key: "ArrowDown" });
			});
		}
		expect(target).toHaveClass("ring-2");
		expect(dragged).not.toHaveClass("ring-2");
		await act(async () => {
			fireEvent.keyDown(dragged, { code: "Escape", key: "Escape" });
		});
		expect(dragged).not.toHaveClass("opacity-40");
		expect(screen.getByRole("img", { name: "Idle for 2d" })).toBeInTheDocument();
	});
});
