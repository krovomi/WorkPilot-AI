/**
 * The bar over a selection: the pipeline's steps for the selection's column,
 * type, priority, delete and clear.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BulkActionBar } from "./BulkActionBar";

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

function renderBar(overrides: Partial<ComponentProps<typeof BulkActionBar>> = {}) {
	const props = {
		count: 2,
		column: "backlog" as const,
		onMove: vi.fn(),
		onMarkDone: vi.fn(),
		onCreatePRs: vi.fn(),
		onSetType: vi.fn(),
		onSetPriority: vi.fn(),
		onDelete: vi.fn(),
		onClear: vi.fn(),
		...overrides,
	};
	render(<BulkActionBar {...props} />);
	return props;
}

const bar = () => screen.getByRole("toolbar", { name: "Selected tasks" });
const buttons = () => within(bar()).getAllByRole("button").map((b) => b.textContent);

describe("BulkActionBar", () => {
	it("moves a planned selection to the queue or to work", async () => {
		const user = userEvent.setup();
		const props = renderBar();
		expect(buttons()).toEqual([
			"Queue",
			"In Progress",
			"Type",
			"Priority",
			"Delete",
			"Clear Selection",
		]);
		await user.click(screen.getByRole("button", { name: "Queue" }));
		await user.click(screen.getByRole("button", { name: "In Progress" }));
		expect(vi.mocked(props.onMove).mock.calls).toEqual([["queue"], ["in_progress"]]);
	});

	it("offers each column's steps", () => {
		const cases = [
			["queue", ["Planning", "In Progress"]],
			["in_progress", ["Queue", "AI Review"]],
			["ai_review", ["In Progress", "Human Review"]],
			["human_review", ["AI Review", "Complete & Create PRs"]],
			["done", ["Create PRs"]],
			["pr_created", []],
		] as const;
		for (const [column, steps] of cases) {
			const { unmount } = render(
				<BulkActionBar
					count={1}
					column={column}
					onMove={vi.fn()}
					onMarkDone={vi.fn()}
					onCreatePRs={vi.fn()}
					onSetType={vi.fn()}
					onSetPriority={vi.fn()}
					onDelete={vi.fn()}
					onClear={vi.fn()}
				/>,
			);
			expect(buttons().slice(0, steps.length)).toEqual([...steps]);
			expect(buttons()).toHaveLength(steps.length + 4);
			unmount();
		}
	});

	it("completes reviewed cards and opens the PR flow of done ones", async () => {
		const user = userEvent.setup();
		const review = renderBar({ column: "human_review" });
		await user.click(screen.getByRole("button", { name: /Complete & Create PRs/ }));
		expect(review.onMarkDone).toHaveBeenCalled();
	});

	it("opens the PR flow for done cards", async () => {
		const user = userEvent.setup();
		const done = renderBar({ column: "done" });
		await user.click(screen.getByRole("button", { name: /Create PRs/ }));
		expect(done.onCreatePRs).toHaveBeenCalled();
	});

	it("warns about a mixed selection and still sets type and priority", async () => {
		const user = userEvent.setup();
		const props = renderBar({ column: null });
		expect(within(bar()).getByText(/Different columns/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Type" }));
		await user.click(await screen.findByRole("menuitem", { name: "Docs" }));
		expect(props.onSetType).toHaveBeenCalledWith("docs");
		await user.click(screen.getByRole("button", { name: "Priority" }));
		await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));
		expect(props.onSetPriority).toHaveBeenCalledWith("urgent");
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Clear Selection" }));
		expect(props.onDelete).toHaveBeenCalled();
		expect(props.onClear).toHaveBeenCalled();
	});
});
