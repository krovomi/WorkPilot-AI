/**
 * @vitest-environment jsdom
 */
/**
 * The task edit dialog as people use it: open on a task, change it, walk to
 * the engine step and save, or duplicate it; and a server card whose text a
 * teammate changed meanwhile.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { CARD_EDIT_CONFLICT } from "../../../shared/types/team-room";
import { useCollaborationStore } from "../../stores/collaboration-store";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { TaskEditDialog } from "../TaskEditDialog";

// The account pins have their own tests: here a button removes the card's
// OpenAI pin and pins a Claude profile, beside the project's pins it was given.
vi.mock("../ai-account-pins/AiAccountPinsEditor", () => ({
	AiAccountPinsEditor: ({
		value,
		onChange,
		inherited,
	}: {
		value?: Record<string, string>;
		onChange: (pins: Record<string, string>) => void;
		inherited?: Record<string, string>;
	}) => (
		<button type="button" onClick={() => onChange({ claude: "team" })}>
			{`pins ${JSON.stringify(value ?? {})} over ${JSON.stringify(inherited ?? {})}`}
		</button>
	),
}));

const api = {
	updateTask: vi.fn(),
	duplicateTask: vi.fn(),
	hydrateAzureDevOpsTaskDisplay: vi.fn(),
	updateContextPolicy: vi.fn(),
};

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001-login",
		projectId: "p1",
		title: "Fix login",
		description: "The login form drops the password",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

function saved(task: Task) {
	return { success: true, data: task };
}

function renderDialog(
	props: Partial<Parameters<typeof TaskEditDialog>[0]> = {},
) {
	const onOpenChange = vi.fn();
	const onSaved = vi.fn();
	const onCreated = vi.fn();
	const view = render(
		<TaskEditDialog
			task={makeTask()}
			open
			onOpenChange={onOpenChange}
			onSaved={onSaved}
			onCreated={onCreated}
			{...props}
		/>,
	);
	return { ...view, onOpenChange, onSaved, onCreated };
}

function titleInput() {
	return document.getElementById("edit-title") as HTMLInputElement;
}

async function goToEngineAndSave(label = "Save Changes") {
	fireEvent.click(screen.getByRole("button", { name: /Next: engine/ }));
	fireEvent.click(await screen.findByRole("button", { name: label }));
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.updateTask.mockImplementation(async (_id: string, updates: Partial<Task>) =>
		saved(makeTask(updates)),
	);
	api.updateContextPolicy.mockResolvedValue({ success: true });
	useProjectStore.setState({
		projects: [{ id: "p1", name: "Repo", path: "/repo", settings: {} } as never],
	});
	useTaskStore.setState({ tasks: [makeTask()] });
	useCollaborationStore.setState((s) => ({
		settings: { ...s.settings, conflictStrategy: "manual" },
	}));
});

describe("TaskEditDialog edit", () => {
	it("opens on the task and closes without saving when nothing changed", async () => {
		const { onOpenChange, onSaved } = renderDialog();
		expect(screen.getByText("Edit Task")).toBeInTheDocument();
		expect(titleInput().value).toBe("Fix login");
		await goToEngineAndSave();
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(api.updateTask).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
	});

	it("saves a new title and reports it", async () => {
		const { onOpenChange, onSaved } = renderDialog();
		fireEvent.change(titleInput(), { target: { value: "  Fix the login form " } });
		await goToEngineAndSave();
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		const [id, updates] = api.updateTask.mock.calls[0];
		expect(id).toBe("t1");
		expect(updates.title).toBe("Fix the login form");
		expect(updates.description).toBe("The login form drops the password");
		// An edit that did not touch the engine does not rewrite it.
		expect(updates.metadata.provider).toBeUndefined();
		expect(updates.metadata.attachedImages).toEqual([]);
		expect(updates.base).toBeUndefined();
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(useTaskStore.getState().tasks[0].title).toBe("Fix the login form");
	});

	it("saves the accounts the card pins, and only when they changed", async () => {
		useProjectStore.setState({
			projects: [{ id: "p1", name: "Repo", path: "/repo", settings: { aiAccounts: { openai: "client" } } } as never],
		});
		const { onSaved } = renderDialog({
			task: makeTask({ metadata: { provider: "anthropic", aiAccounts: { claude: "work", ollama: "x" } } }),
		});
		fireEvent.click(screen.getByRole("button", { name: /Next: engine/ }));
		fireEvent.click(await screen.findByText('pins {"claude":"work"} over {"openai":"client"}'));
		fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(api.updateTask.mock.calls[0][1].metadata.aiAccounts).toEqual({ claude: "team" });
	});

	it("says the save failed and stays open", async () => {
		api.updateTask.mockResolvedValue({ success: false, error: "disk full" });
		const { onOpenChange } = renderDialog();
		fireEvent.change(titleInput(), { target: { value: "Renamed" } });
		await goToEngineAndSave();
		expect(
			await screen.findByText("Failed to update task. Please try again."),
		).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("goes back to the details step", async () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /Next: engine/ }));
		fireEvent.click(await screen.findByRole("button", { name: /Back/ }));
		expect(await screen.findByRole("button", { name: /Next: engine/ })).toBeInTheDocument();
		expect(titleInput()).toBeInTheDocument();
	});

	it("cannot move on without a description", () => {
		renderDialog({ task: makeTask({ description: "" }) });
		expect(screen.getByRole("button", { name: /Next: engine/ })).toBeDisabled();
	});

	it("cancels from the first step", () => {
		const { onOpenChange } = renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("opens the classification when the task has one and keeps it on save", async () => {
		const task = makeTask({
			metadata: { category: "bug_fix", priority: "high" } as Task["metadata"],
		});
		const { onSaved } = renderDialog({ task });
		expect(screen.getByRole("button", { name: /Classification/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		fireEvent.change(titleInput(), { target: { value: "Fix login now" } });
		await goToEngineAndSave();
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(api.updateTask.mock.calls[0][1].metadata).toMatchObject({
			category: "bug_fix",
			priority: "high",
		});
	});

	it("resets the form when it opens on another task", async () => {
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<TaskEditDialog task={makeTask()} open onOpenChange={onOpenChange} />,
		);
		fireEvent.change(titleInput(), { target: { value: "Draft title" } });
		rerender(
			<TaskEditDialog task={makeTask()} open={false} onOpenChange={onOpenChange} />,
		);
		rerender(
			<TaskEditDialog
				task={makeTask({ id: "t2", title: "Other card" })}
				open
				onOpenChange={onOpenChange}
			/>,
		);
		await waitFor(() => expect(titleInput().value).toBe("Other card"));
	});

	it("inlines Azure DevOps attachment images into the description", async () => {
		api.hydrateAzureDevOpsTaskDisplay.mockResolvedValue({
			success: true,
			data: { html: "<p>Hydrated <img src=\"data:image/png;base64,AA\"></p>" },
		});
		renderDialog({
			task: makeTask({
				description:
					'<p>See <img src="https://dev.azure.com/o/p/_apis/wit/attachments/1"></p>',
			}),
		});
		await waitFor(() =>
			expect(api.hydrateAzureDevOpsTaskDisplay).toHaveBeenCalledWith("p1", "t1"),
		);
		expect(await screen.findByText(/Hydrated/)).toBeInTheDocument();
	});

	it("keeps the original description when hydration fails", async () => {
		api.hydrateAzureDevOpsTaskDisplay.mockRejectedValue(new Error("401"));
		renderDialog({
			task: makeTask({
				description: "<p>Attachment _apis/wit/attachments/9 kept</p>".replace(
					"_apis",
					"/_apis",
				),
			}),
		});
		await waitFor(() => expect(api.hydrateAzureDevOpsTaskDisplay).toHaveBeenCalled());
		expect(screen.getByText(/kept/)).toBeInTheDocument();
	});
});

describe("TaskEditDialog duplicate", () => {
	it("pre-fills a copy title, clones the task and applies the edits to the clone", async () => {
		const clone = makeTask({ id: "t9", specId: "009-login-copy", title: "Fix login (copy)" });
		api.duplicateTask.mockResolvedValue({ success: true, data: clone });
		const { onCreated, onOpenChange } = renderDialog({ mode: "duplicate" });
		expect(screen.getByText("Duplicate Task")).toBeInTheDocument();
		expect(titleInput().value).toBe("Fix login (copy)");
		await goToEngineAndSave("Create copy");
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t9"));
		expect(api.duplicateTask).toHaveBeenCalledWith("t1", "Fix login (copy)");
		const [id, updates] = api.updateTask.mock.calls[0];
		expect(id).toBe("t9");
		// The clone takes the engine shown in the dialog.
		expect(updates.metadata.provider).toBeDefined();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("says the copy failed", async () => {
		api.duplicateTask.mockResolvedValue({ success: false });
		const { onCreated } = renderDialog({ mode: "duplicate" });
		await goToEngineAndSave("Create copy");
		expect(
			await screen.findByText("Failed to duplicate task. Please try again."),
		).toBeInTheDocument();
		expect(onCreated).not.toHaveBeenCalled();
	});
});

describe("TaskEditDialog on a server card", () => {
	const conflict = {
		field: "title" as const,
		mine: "My title",
		theirs: "Their title",
	};

	function serverTask() {
		return makeTask({ id: "server:p1:42" });
	}

	it("sends the opened text as the base and lets the person keep theirs", async () => {
		api.updateTask
			.mockResolvedValueOnce({
				success: false,
				error: CARD_EDIT_CONFLICT,
				conflicts: [conflict],
			})
			.mockImplementation(async (_id: string, updates: Partial<Task>) =>
				saved(makeTask(updates)),
			);
		const { onSaved } = renderDialog({ task: serverTask() });
		fireEvent.change(titleInput(), { target: { value: "My title" } });
		await goToEngineAndSave();
		expect(await screen.findByText("A teammate changed this card")).toBeInTheDocument();
		expect(api.updateTask.mock.calls[0][1].base).toEqual({
			title: "Fix login",
			description: "The login form drops the password",
		});
		fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		const retry = api.updateTask.mock.calls[1][1];
		expect(retry.title).toBe("My title");
		// The teammate's text is now the base the server compares against.
		expect(retry.base.title).toBe("Their title");
	});

	it("keeps the teammate's text when asked", async () => {
		api.updateTask
			.mockResolvedValueOnce({
				success: false,
				error: CARD_EDIT_CONFLICT,
				conflicts: [conflict],
			})
			.mockImplementation(async (_id: string, updates: Partial<Task>) =>
				saved(makeTask(updates)),
			);
		const { onSaved } = renderDialog({ task: serverTask() });
		fireEvent.change(titleInput(), { target: { value: "My title" } });
		await goToEngineAndSave();
		fireEvent.click(await screen.findByRole("button", { name: "Keep theirs" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(api.updateTask.mock.calls[1][1].title).toBe("Their title");
	});

	it("keeps the teammate's text without asking under first write wins", async () => {
		act(() =>
			useCollaborationStore.setState((s) => ({
				settings: { ...s.settings, conflictStrategy: "first_write_wins" },
			})),
		);
		api.updateTask
			.mockResolvedValueOnce({
				success: false,
				error: CARD_EDIT_CONFLICT,
				conflicts: [conflict],
			})
			.mockImplementation(async (_id: string, updates: Partial<Task>) =>
				saved(makeTask(updates)),
			);
		const { onSaved } = renderDialog({ task: serverTask() });
		fireEvent.change(titleInput(), { target: { value: "My title" } });
		await goToEngineAndSave();
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(screen.queryByText("A teammate changed this card")).toBeNull();
		expect(api.updateTask.mock.calls[1][1].title).toBe("Their title");
	});

	it("sends no base under last write wins", async () => {
		act(() =>
			useCollaborationStore.setState((s) => ({
				settings: { ...s.settings, conflictStrategy: "last_write_wins" },
			})),
		);
		const { onSaved } = renderDialog({ task: serverTask() });
		fireEvent.change(titleInput(), { target: { value: "Mine wins" } });
		await goToEngineAndSave();
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(api.updateTask.mock.calls[0][1].base).toBeUndefined();
	});
});
