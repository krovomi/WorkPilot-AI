/**
 * A card's labels: the dialog that edits them (opened from the card's menu),
 * and the chips on the card that filter the board by one.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types";
import { toast } from "../../../hooks/use-toast";
import { useKanbanFilterStore } from "../../../stores/kanban-filter-store";
import { useLabelRequestStore } from "../../../stores/label-request-store";
import { useTaskStore } from "../../../stores/task-store";
import { BoardDialogs } from "../BoardDialogs";
import { CardLabels } from "./CardLabels";

vi.mock("../../../hooks/use-toast", () => ({ toast: vi.fn() }));

const updateTask = vi.fn();
const task = (id: string, labels?: string[]) =>
	({ id, title: `Card ${id}`, status: "backlog", metadata: labels ? { labels } : {}, updatedAt: new Date(0) }) as Task;

beforeEach(() => {
	vi.mocked(toast).mockClear();
	updateTask.mockReset().mockResolvedValue({ success: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = { updateTask };
	useLabelRequestStore.getState().close();
	useTaskStore.setState({ tasks: [task("a", ["api"]), task("b", ["Front", "design"])] });
});

function edit(id: string) {
	act(() => useLabelRequestStore.getState().request(id));
	return screen.getByRole("dialog");
}

describe("LabelsDialog", () => {
	it("adds a typed label and one the board uses, removes one, and saves them", async () => {
		const user = userEvent.setup();
		render(<BoardDialogs />);
		expect(screen.queryByRole("dialog")).toBeNull();
		const dialog = edit("a");
		expect(within(dialog).getByText(/Card a/)).toBeInTheDocument();
		const add = within(dialog).getByRole("button", { name: "Add" });
		expect(add).toBeDisabled();
		await user.type(within(dialog).getByLabelText("Label to add"), "  needs   review {Enter}");
		await user.type(within(dialog).getByLabelText("Label to add"), "API{Enter}");
		await user.click(within(dialog).getByRole("button", { name: "+ Front" }));
		await user.click(within(dialog).getByRole("button", { name: "Remove the label api" }));
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(updateTask).toHaveBeenCalledWith("a", { metadata: { labels: ["needs review", "Front"] } });
		expect(useTaskStore.getState().tasks[0].metadata?.labels).toEqual(["needs review", "Front"]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says when a card has no label, and stops at ten", async () => {
		const user = userEvent.setup();
		useTaskStore.setState({ tasks: [task("c"), task("d", ["x"])] });
		render(<BoardDialogs />);
		let dialog = edit("c");
		expect(within(dialog).getByText("No label yet.")).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(useLabelRequestStore.getState().taskId).toBeNull();

		const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
		useTaskStore.setState({ tasks: [task("c", ten), task("d", ["x"])] });
		dialog = edit("c");
		expect(within(dialog).getByText("A task holds 10 labels at most.")).toBeInTheDocument();
		expect(within(dialog).getByLabelText("Label to add")).toBeDisabled();
		expect(within(dialog).queryByText("Already on the board")).toBeNull();
		await user.keyboard("{Escape}");
		expect(useLabelRequestStore.getState().taskId).toBeNull();
	});

	it("adds nothing that is not a label, and stays open while it saves", async () => {
		const user = userEvent.setup();
		let finish: (value: { success: boolean }) => void = () => undefined;
		updateTask.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
		render(<BoardDialogs />);
		const dialog = edit("a");
		await user.type(within(dialog).getByLabelText("Label to add"), "   ");
		fireEvent.submit(within(dialog).getByLabelText("Label to add").closest("form") as HTMLFormElement);
		expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await act(async () => finish({ success: true }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps the dialog open when the save is refused", async () => {
		const user = userEvent.setup();
		updateTask.mockResolvedValueOnce({ success: false, error: "busy" }).mockResolvedValueOnce({ success: false });
		render(<BoardDialogs />);
		const dialog = edit("a");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Labels not saved", description: "busy" }));
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(toast).toHaveBeenLastCalledWith(
			expect.objectContaining({ description: "The task could not be saved. Try again." }),
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("opens on nothing for a card that is gone", () => {
		render(<BoardDialogs />);
		act(() => useLabelRequestStore.getState().request("gone"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("CardLabels", () => {
	it("shows a card's labels, and filters the board by one", () => {
		const { container, rerender } = render(<CardLabels task={task("a", [])} />);
		expect(container).toBeEmptyDOMElement();
		rerender(<CardLabels task={task("b", ["Front", "design"])} />);
		// The click stays the chip's: the card around it does not open.
		expect(fireEvent.click(screen.getByRole("button", { name: "Front" }))).toBe(false);
		expect(useKanbanFilterStore.getState().filters.labels).toEqual(["Front"]);
		expect(screen.getByRole("button", { name: "design" })).toHaveAttribute("title", "Show the tasks labelled design");
	});
});
