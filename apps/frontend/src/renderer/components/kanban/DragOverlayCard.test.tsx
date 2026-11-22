import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { DragOverlayCard } from "./DragOverlayCard";

vi.mock("../TaskCard", () => ({
	TaskCard: ({ task, onClick }: { task: Task; onClick: () => void }) => (
		<button type="button" onClick={onClick}>
			{task.title}
		</button>
	),
}));

const task = { id: "a", title: "A" } as Task;

describe("DragOverlayCard", () => {
	it("shows one card, without a count, for a single drag", () => {
		const { container, getByRole } = render(<DragOverlayCard task={task} count={1} />);
		getByRole("button").click();
		expect(container.querySelector("[data-drag-count]")).toBeNull();
		expect(container.querySelectorAll("[data-drag-layer]")).toHaveLength(0);
	});

	it.each([
		[2, 1],
		[5, 2],
	])("stacks a selection of %i behind the dragged card (%i layers) with its count", (count, layers) => {
		const { container, getByText } = render(<DragOverlayCard task={task} count={count} />);
		expect(container.querySelector(`[data-drag-count="${count}"]`)).not.toBeNull();
		expect(container.querySelectorAll("[data-drag-layer]")).toHaveLength(layers);
		expect(getByText(String(count))).toBeInTheDocument();
	});
});
