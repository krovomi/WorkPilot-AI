/**
 * The task title, edited where it is shown.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

// Hoisted with the mock factory below, so the factory never reads it before
// it exists, whatever order vitest evaluates the module in.
const { persist } = vi.hoisted(() => ({
	persist: vi.fn<(id: string, updates: unknown) => Promise<boolean>>(),
}));
vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: (id: string, updates: unknown) => persist(id, updates),
}));

import { EditableTaskTitle } from "./EditableTaskTitle";

const task = { id: "t1", title: "Exporter en CSV" } as unknown as Task;
const Title = ({ className, children }: { className?: string; children?: ReactNode }) => (
	<h2 className={className}>{children}</h2>
);

function setup(editable = true) {
	render(<EditableTaskTitle task={task} displayTitle={task.title} editable={editable} as={Title} />);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	persist.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

it("opens a field on click and saves on Enter", async () => {
	setup();
	fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
	const field = screen.getByRole("textbox", { name: "Task title" });
	fireEvent.change(field, { target: { value: "  Exporter   en CSV et JSON " } });
	fireEvent.keyDown(field, { key: "Enter" });
	await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
	expect(persist).toHaveBeenCalledWith("t1", { title: "Exporter en CSV et JSON" });
	// The blur that follows Enter must not save a second time.
	fireEvent.blur(field);
	expect(persist).toHaveBeenCalledTimes(1);
});

it("cancels on Escape without writing", () => {
	setup();
	fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
	const field = screen.getByRole("textbox", { name: "Task title" });
	fireEvent.change(field, { target: { value: "autre chose" } });
	fireEvent.keyDown(field, { key: "Escape" });
	expect(persist).not.toHaveBeenCalled();
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.getByRole("heading")).toHaveTextContent("Exporter en CSV");
});

it("never saves an emptied title — the backend would invent one", () => {
	setup();
	fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
	const field = screen.getByRole("textbox", { name: "Task title" });
	fireEvent.change(field, { target: { value: "   " } });
	fireEvent.blur(field);
	expect(persist).not.toHaveBeenCalled();
});

it("is plain text while an agent is running", () => {
	setup(false);
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.getByRole("heading")).toHaveTextContent("Exporter en CSV");
});

it("closes an open field without saving when the dialog moves to another task", () => {
	const { rerender } = render(
		<EditableTaskTitle task={task} displayTitle={task.title} editable as={Title} />,
	);
	fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
	fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), {
		target: { value: "Titre de A" },
	});
	const other = { id: "t2", title: "Autre tâche" } as unknown as Task;
	rerender(<EditableTaskTitle task={other} displayTitle={other.title} editable as={Title} />);
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(persist).not.toHaveBeenCalled();
});

it("does not reopen or refocus a field when a failed save finishes after a task switch", async () => {
	const pending: { settle?: (ok: boolean) => void } = {};
	persist.mockReturnValueOnce(
		new Promise<boolean>((resolve) => {
			pending.settle = resolve;
		}),
	);
	const { rerender } = render(
		<EditableTaskTitle task={task} displayTitle={task.title} editable as={Title} />,
	);
	fireEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
	const field = screen.getByRole("textbox", { name: "Task title" });
	fireEvent.change(field, { target: { value: "Nouveau" } });
	fireEvent.keyDown(field, { key: "Enter" });
	const other = { id: "t2", title: "Autre tâche" } as unknown as Task;
	rerender(<EditableTaskTitle task={other} displayTitle={other.title} editable as={Title} />);
	pending.settle?.(false);
	await waitFor(() => expect(persist).toHaveBeenCalledWith("t1", { title: "Nouveau" }));
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.getByRole("heading")).toHaveTextContent("Autre tâche");
});
