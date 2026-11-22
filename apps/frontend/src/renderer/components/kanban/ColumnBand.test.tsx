/**
 * The column band pieces on their own: the gauge's two shapes, the count's
 * spoken form, the empty state of every column.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../../shared/types";
import { columnCapacity } from "../../lib/kanban-column-meta";
import {
	ColumnCount,
	ColumnEmptyState,
	ColumnGauge,
	ColumnIcon,
	columnIcon,
	getEmptyStateContent,
} from "./ColumnBand";

function capacityOf(...args: Parameters<typeof columnCapacity>) {
	const capacity = columnCapacity(...args);
	if (!capacity) throw new Error("expected a capacity");
	return capacity;
}

describe("ColumnGauge", () => {
	it("draws one segment per slot and lights those in use", () => {
		const capacity = capacityOf(2, 3, "slots");
		const { container } = render(<ColumnGauge count={2} capacity={capacity} />);
		expect(container.querySelectorAll(".kanban-col-gauge-seg")).toHaveLength(3);
		expect(container.querySelectorAll(".kanban-col-gauge-seg[data-on]")).toHaveLength(2);
		expect(container.querySelector(".kanban-col-gauge")).not.toHaveAttribute("data-warn");
		expect(screen.getByText("slots")).toBeInTheDocument();
	});

	it("turns into a bar past eight slots", () => {
		const capacity = capacityOf(5, 10, "slots");
		const { container } = render(<ColumnGauge count={5} capacity={capacity} />);
		expect(container.querySelector(".kanban-col-gauge-seg")).toBeNull();
		expect(container.querySelector(".kanban-col-gauge-bar > span")).toHaveStyle({ width: "50%" });
	});

	it("shows a WIP limit as a bar with its value", () => {
		const capacity = capacityOf(3, 2, "wip");
		const { container } = render(<ColumnGauge count={3} capacity={capacity} />);
		expect(container.querySelector(".kanban-col-gauge")).toHaveAttribute("data-warn");
		expect(screen.getByText("limit 2")).toBeInTheDocument();
	});
});

describe("ColumnCount", () => {
	it("is a bare number without a limit", () => {
		const { container } = render(<ColumnCount count={4} capacity={null} />);
		expect(container.textContent).toBe("4");
	});

	it("says the limit in words for screen readers", () => {
		render(<ColumnCount count={1} capacity={columnCapacity(1, 3, "slots")} />);
		expect(screen.getByText("1 of 3 parallel slots in use")).toBeInTheDocument();
	});
});

describe("ColumnIcon", () => {
	it("stays still unless agents are working", () => {
		const { container } = render(<ColumnIcon status="in_progress" />);
		expect(container.querySelector(".kanban-col-icon-busy")).toBeNull();
	});

	it("falls back to the inbox for a status without a column", () => {
		expect(columnIcon("error" as TaskStatus)).toBe(columnIcon("backlog"));
	});
});

describe("empty states", () => {
	const statuses: TaskStatus[] = [
		"backlog",
		"queue",
		"in_progress",
		"ai_review",
		"human_review",
		"build_failed",
		"pr_created",
		"done",
	];

	it.each(statuses)("%s has a message and a hint", (status) => {
		const content = getEmptyStateContent(status, (k) => k);
		expect(content.message).toMatch(/^kanban\.empty/);
		expect(content.subtext).toMatch(/Hint$/);
	});

	it("an unknown status has a message and no hint", () => {
		const { container } = render(<ColumnEmptyState status={"error" as TaskStatus} isOver={false} />);
		expect(container.querySelector(".kanban-col-empty-title")).toBeInTheDocument();
		expect(container.querySelector(".kanban-col-empty-hint")).toBeNull();
	});

	it("an empty « Build rouge » shows a check, not its own icon", () => {
		const { container: failed } = render(<ColumnEmptyState status="build_failed" isOver={false} />);
		const { container: done } = render(<ColumnEmptyState status="done" isOver={false} />);
		expect(failed.querySelector("svg")?.innerHTML).toBe(done.querySelector("svg")?.innerHTML);
	});

	it("invites the drop while a card is over it", () => {
		const { container } = render(<ColumnEmptyState status="queue" isOver />);
		expect(screen.getByText("Drop here")).toBeInTheDocument();
		expect(container.querySelector(".kanban-col-empty")).toHaveClass("active");
	});
});
