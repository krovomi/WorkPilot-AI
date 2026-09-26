/**
 * The task card of the Overview: the description edited where it is read, and
 * acceptance criteria that the description states when the dedicated field is
 * empty.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const persist = vi.fn<(id: string, updates: unknown) => Promise<boolean>>();
vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: (id: string, updates: unknown) => persist(id, updates),
	useTaskStore: { getState: () => ({ updateTask: vi.fn() }) },
}));
vi.mock("./TaskBlockers", () => ({ TaskBlockers: () => null }));

import { TooltipProvider } from "../ui/tooltip";
import { TaskMetadata } from "./TaskMetadata";

const description = [
	"Ajouter un export CSV.",
	"",
	"## Critères d'acceptation",
	"- Le bouton Exporter est visible",
	"- Le fichier contient l'en-tête",
].join("\n");

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		projectId: "p1",
		title: "Export",
		description,
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata: { sourceType: "manual" },
		...overrides,
	} as unknown as Task;
}

function setup(task: Task, editable = true) {
	render(
		<TooltipProvider>
			<TaskMetadata task={task} editable={editable} />
		</TooltipProvider>,
	);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	persist.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

it("shows the criteria the description states when none are stored, and saves them on request", async () => {
	setup(makeTask());
	expect(screen.getByText("read from the description")).toBeInTheDocument();
	const list = screen.getAllByText(/Le bouton Exporter est visible/);
	expect(list.length).toBeGreaterThan(0);
	fireEvent.click(screen.getByRole("button", { name: "Save as criteria" }));
	await waitFor(() =>
		expect(persist).toHaveBeenCalledWith("t1", {
			metadata: {
				acceptanceCriteria: ["Le bouton Exporter est visible", "Le fichier contient l'en-tête"],
			},
		}),
	);
});

it("prefers the stored criteria over the description", () => {
	setup(makeTask({ metadata: { sourceType: "manual", acceptanceCriteria: ["Stocké"] } } as Partial<Task>));
	expect(screen.queryByText("read from the description")).toBeNull();
	expect(screen.getByText("Stocké")).toBeInTheDocument();
});

it("translates the source badge", () => {
	setup(makeTask());
	expect(screen.getByText("Manual")).toBeInTheDocument();
});

it("opens the description editor on click and saves with Ctrl+Enter", async () => {
	setup(makeTask());
	fireEvent.click(screen.getByText("Ajouter un export CSV."));
	const field = screen.getByRole("textbox", { name: "Description" });
	fireEvent.change(field, { target: { value: "Nouvelle description" } });
	fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
	await waitFor(() =>
		expect(persist).toHaveBeenCalledWith("t1", { description: "Nouvelle description" }),
	);
});

it("does not open the editor while an agent is running", () => {
	setup(makeTask(), false);
	fireEvent.click(screen.getByText("Ajouter un export CSV."));
	expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Save as criteria" })).toBeNull();
});

it("does not read the description back once the user emptied the list", () => {
	setup(
		makeTask({
			metadata: { sourceType: "manual", acceptanceCriteria: [], ignoreDescriptionCriteria: true },
		} as Partial<Task>),
	);
	expect(screen.queryByText("read from the description")).toBeNull();
	expect(screen.queryByRole("button", { name: "Save as criteria" })).toBeNull();
});

it("records that decision when the criteria read from the description are all removed", async () => {
	setup(makeTask());
	// The description card has its own "Edit"; the criteria one comes last.
	const edits = screen.getAllByRole("button", { name: "Edit" });
	fireEvent.click(edits[edits.length - 1]);
	fireEvent.click(screen.getByRole("button", { name: "Text" }));
	fireEvent.change(screen.getByPlaceholderText("One criterion per line…"), {
		target: { value: "" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(persist).toHaveBeenCalledWith("t1", {
			metadata: { acceptanceCriteria: [], ignoreDescriptionCriteria: true },
		}),
	);
});
