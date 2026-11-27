/**
 * « Bloquée »: the board's flag dialog (opened by the request store), the
 * card's banner that lifts the flag, and the actions that save both.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { useFlagRequestStore } from "../../stores/flag-request-store";
import { useTaskStore } from "../../stores/task-store";
import { BoardDialogs } from "./BoardDialogs";
import { FlagBanner } from "./FlagBanner";

vi.mock("../../hooks/use-toast", () => ({ toast: vi.fn() }));

const updateTask = vi.fn();
const task = (id: string, title: string, metadata: Task["metadata"] = {}) =>
	({ id, title, status: "in_progress", metadata, updatedAt: new Date(0) }) as Task;

beforeEach(() => {
	vi.mocked(toast).mockClear();
	updateTask.mockReset().mockResolvedValue({ success: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = { updateTask };
	useFlagRequestStore.getState().close();
	useAbandonRequestStore.getState().close();
	useTaskStore.setState({ tasks: [task("a", "Login page"), task("b", "Signup page")] });
});

function ask(ids: string[]) {
	act(() => useFlagRequestStore.getState().request(ids));
}

describe("FlagRequestDialog", () => {
	it("flags the asked tasks with what blocks them", async () => {
		const user = userEvent.setup();
		render(<BoardDialogs />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		ask(["a", "b", "a"]);
		expect(screen.getByRole("heading", { name: "Flag 2 tasks as blocked" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("What blocks it"), "waiting for the API key");
		await user.click(screen.getByRole("button", { name: "Flag as blocked" }));
		expect(updateTask).toHaveBeenCalledTimes(2);
		expect(updateTask).toHaveBeenCalledWith("a", {
			metadata: expect.objectContaining({ flagged: true, flaggedReason: "waiting for the API key" }),
		});
		const saved = useTaskStore.getState().tasks[0];
		expect(saved.metadata?.flagged).toBe(true);
		expect(saved.updatedAt.getTime()).toBeGreaterThan(0);
		expect(useFlagRequestStore.getState().ids).toEqual([]);
	});

	it("says when the flag is refused", async () => {
		const user = userEvent.setup();
		updateTask.mockResolvedValueOnce({ success: false, error: "busy" });
		render(<BoardDialogs />);
		ask(["a"]);
		expect(screen.getByRole("heading", { name: "Flag the task as blocked" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Flag as blocked" }));
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ description: "busy", variant: "destructive" }),
		);
		updateTask.mockRejectedValueOnce(new Error("gone"));
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Flag as blocked" }));
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "gone" }));
		updateTask.mockResolvedValueOnce({ success: false });
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Flag as blocked" }));
		expect(toast).toHaveBeenLastCalledWith(
			expect.objectContaining({ description: "Could not save the flag. Please try again." }),
		);
	});

	it("closes on cancel", async () => {
		const user = userEvent.setup();
		render(<BoardDialogs />);
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(useFlagRequestStore.getState().ids).toEqual([]);
		expect(updateTask).not.toHaveBeenCalled();
	});
});

describe("FlagBanner", () => {
	it("shows what blocks the card and lifts the flag", async () => {
		const user = userEvent.setup();
		const flagged = task("a", "Login page", { flagged: true, flaggedReason: "waiting for QA" });
		useTaskStore.setState({ tasks: [flagged] });
		const { unmount } = render(<FlagBanner task={flagged} />);
		expect(screen.getByText("waiting for QA")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Remove flag" }));
		expect(updateTask).toHaveBeenCalledWith("a", {
			metadata: { flagged: false, flaggedReason: undefined, flaggedAt: undefined },
		});
		unmount();

		updateTask.mockResolvedValueOnce({ success: false });
		render(<FlagBanner task={task("a", "Login page", { flagged: true })} />);
		expect(screen.getByText("Blocked")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Remove flag" }));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
	});
});
