/**
 * The board's abandon dialog: opened by the request store, it asks why
 * (resolution, linked task, note) and abandons every asked task.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { abandonTask, useTaskStore } from "../../stores/task-store";
import { AbandonRequestDialog } from "./AbandonRequestDialog";

vi.mock("../../hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../stores/task-store")>()),
	abandonTask: vi.fn(),
}));

const task = (id: string, title: string, overrides: Partial<Task> = {}) =>
	({ id, title, status: "backlog", ...overrides }) as Task;

beforeEach(() => {
	vi.mocked(toast).mockClear();
	vi.mocked(abandonTask).mockReset().mockResolvedValue({ success: true });
	useAbandonRequestStore.getState().close();
	useTaskStore.setState({
		tasks: [
			task("a", "Login page"),
			task("b", "Signup page"),
			task("c", "Auth rewrite"),
			task("old", "Archived", { metadata: { archivedAt: "2026-11-01" } as Task["metadata"] }),
		],
	});
});

/** Picks in the app's Select (Radix): focus, open with the keyboard, click. */
async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
	screen.getByRole("combobox", { name: field }).focus();
	await user.keyboard("[ArrowDown]");
	await user.click(await screen.findByRole("option", { name: option }));
}

function ask(ids: string[]) {
	act(() => useAbandonRequestStore.getState().request(ids));
}

describe("AbandonRequestDialog", () => {
	it("stays closed until tasks are asked", () => {
		render(<AbandonRequestDialog />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("abandons one task with the chosen resolution and its note", async () => {
		const user = userEvent.setup();
		render(<AbandonRequestDialog />);
		ask(["a"]);
		expect(screen.getByText(/"Login page"/)).toBeInTheDocument();
		await pick(user, "Why", "Obsolete");
		expect(screen.queryByLabelText("Duplicate of")).toBeNull();
		await user.type(screen.getByLabelText("Note"), "design changed");
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(abandonTask).toHaveBeenCalledWith("a", {
			reason: "design changed",
			resolution: "obsolete",
		});
		expect(useAbandonRequestStore.getState().ids).toEqual([]);
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Task abandoned" }));
	});

	it("links a duplicate to a live task that is not being abandoned", async () => {
		const user = userEvent.setup();
		render(<AbandonRequestDialog />);
		ask(["a", "b"]);
		expect(screen.getByRole("heading", { name: "Abandon 2 tasks" })).toBeInTheDocument();
		await pick(user, "Why", "Duplicate");
		screen.getByRole("combobox", { name: "Duplicate of" }).focus();
		await user.keyboard("[ArrowDown]");
		const offered = (await screen.findAllByRole("option")).map((o) => o.textContent);
		expect(offered).toEqual(["Not on the board", "Auth rewrite"]);
		await user.click(screen.getByRole("option", { name: "Auth rewrite" }));
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(abandonTask).toHaveBeenCalledTimes(2);
		expect(abandonTask).toHaveBeenCalledWith("b", {
			reason: "",
			resolution: "duplicate",
			link: "c",
		});
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 tasks abandoned" }));
	});

	it("reports the first refusal", async () => {
		const user = userEvent.setup();
		vi.mocked(abandonTask).mockResolvedValueOnce({ success: false, error: "busy" });
		render(<AbandonRequestDialog />);
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ description: "busy", variant: "destructive" }),
		);
		vi.mocked(abandonTask).mockResolvedValueOnce({ success: false });
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(toast).toHaveBeenLastCalledWith(
			expect.objectContaining({ description: "Could not abandon the task. Please try again." }),
		);
	});

	it("closes on cancel", async () => {
		const user = userEvent.setup();
		render(<AbandonRequestDialog />);
		ask(["a"]);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(useAbandonRequestStore.getState().ids).toEqual([]);
		expect(abandonTask).not.toHaveBeenCalled();
	});
});
