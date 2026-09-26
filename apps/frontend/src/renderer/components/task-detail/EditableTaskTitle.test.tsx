/**
 * The task title, edited where it is shown.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const persist = vi.fn<(id: string, updates: unknown) => Promise<boolean>>();
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
