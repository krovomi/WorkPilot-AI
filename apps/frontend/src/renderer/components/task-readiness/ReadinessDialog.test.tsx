import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../__tests__/helpers/renderer-api";
import type { Task } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { useTaskReadinessStore } from "../../stores/task-readiness-store";
import { useTaskStore } from "../../stores/task-store";
import { Toaster } from "../ui/toaster";
import { clarificationsSection, ReadinessDialog } from "./ReadinessDialog";

const card = (overrides: Partial<Task> = {}) =>
	({ id: "t1", projectId: "p1", title: "Fix login", description: "Short", status: "backlog", subtasks: [], ...overrides }) as Task;
const questions = [
	{ id: "q1", question: "Which page?", suggestion: "The admin page" },
	{ id: "q2", question: "Which browser?" },
];

let api: RendererApi;
function show(readiness: object, tasks: Task[] = [card()]) {
	useTaskStore.setState({ tasks });
	useTaskReadinessStore.setState({ held: [{ taskId: "t1", readiness: readiness as never }], accepted: new Set() });
	return render(
		<>
			<ReadinessDialog />
			<Toaster />
		</>,
	);
}

beforeEach(() => {
	api = installRendererApi({
		updateTask: vi.fn(async (_id: string, updates: { description?: string }) => ({
			success: true,
			data: { ...card(), ...updates },
		})),
		updateTaskStatus: vi.fn(async () => ({ success: true })),
	});
	useProjectStore.setState({ projects: [{ id: "p1", settings: { maxParallelTasks: 1 } } as never] });
});
afterEach(() => api.restore());

describe("ReadinessDialog", () => {
	it("shows nothing while no card is held", () => {
		useTaskReadinessStore.setState({ held: [], accepted: new Set() });
		const { container } = render(<ReadinessDialog />);
		expect(container).toBeEmptyDOMElement();
	});

	it("says why a start would fail, and closes", async () => {
		show({ ready: false, problem: "no_commit" });
		expect(screen.getByText(/has no commit yet/)).toBeInTheDocument();
		// The footer button (the corner one is the dialog's own).
		await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
		expect(useTaskReadinessStore.getState().held).toEqual([]);
	});

	it("saves the answers after what the card says, then starts the card", async () => {
		show({ ready: false, questions }, [card({ description: "What I wrote on the card" })]);
		// The card's own text is shown: the person sees it is read.
		expect(screen.getByRole("region", { name: "What the agent will read" })).toHaveTextContent("What I wrote on the card");
		// A suggestion is offered, never written in for the person.
		const page = screen.getByRole("textbox", { name: "Which page?" });
		const browser = screen.getByRole("textbox", { name: "Which browser?" });
		expect(page).toHaveValue("");
		expect(screen.getByRole("button", { name: "Add details and start" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Suggestion: The admin page" }));
		expect(page).toHaveValue("The admin page");
		// Taken, the suggestion is no longer offered.
		expect(screen.queryByRole("button", { name: /Suggestion:/ })).not.toBeInTheDocument();
		await userEvent.type(browser, "Firefox");
		await userEvent.click(screen.getByRole("button", { name: "Add details and start" }));
		await waitFor(() => expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("t1", "in_progress", {}));
		expect(api.fn("updateTask").mock.calls[0][1].description).toBe(
			"What I wrote on the card\n\n## Clarifications before the start\n\n**Which page?**\n\nThe admin page\n\n**Which browser?**\n\nFirefox\n",
		);
		expect(useTaskReadinessStore.getState().accepted.has("t1")).toBe(true);
		expect(useTaskReadinessStore.getState().held).toEqual([]);
	});

	it("leaves out a suggestion nobody took, and saves with Ctrl+Enter", async () => {
		show({ ready: false, questions });
		// Nothing answered: the shortcut does nothing.
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		expect(api.fn("updateTask")).not.toHaveBeenCalled();
		await userEvent.type(screen.getByRole("textbox", { name: "Which browser?" }), "Firefox");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		await waitFor(() => expect(api.fn("updateTask")).toHaveBeenCalledTimes(1));
		expect(api.fn("updateTask").mock.calls[0][1].description).toBe(
			"Short\n\n## Clarifications before the start\n\n**Which browser?**\n\nFirefox\n",
		);
	});

	it("says when the card has nothing beyond its title, and how many cards wait", () => {
		useTaskStore.setState({ tasks: [card({ description: "Fix login" }), card({ id: "t2" })] });
		useTaskReadinessStore.setState({
			held: [
				{ taskId: "t1", readiness: { ready: false, questions } as never },
				{ taskId: "t2", readiness: { ready: false, questions } as never },
			],
			accepted: new Set(),
		});
		render(<ReadinessDialog />);
		expect(screen.getByText("Nothing beyond the title.")).toBeInTheDocument();
		expect(screen.getByText("Pre-start check · 2 cards waiting")).toBeInTheDocument();
	});

	it("starts as it is, into the queue when « En cours » is full", async () => {
		show({ ready: false, questions }, [card(), card({ id: "run", status: "in_progress" })]);
		await userEvent.click(screen.getByRole("button", { name: "Start without details" }));
		await waitFor(() => expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("t1", "queue", {}));
		expect(api.fn("updateTask")).not.toHaveBeenCalled();
	});

	it("leaves a queued card where it is when the slots are taken", async () => {
		show({ ready: false, questions }, [card({ status: "queue" }), card({ id: "run", status: "in_progress" })]);
		await userEvent.click(screen.getByRole("button", { name: "Start without details" }));
		await waitFor(() => expect(useTaskReadinessStore.getState().accepted.has("t1")).toBe(true));
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});

	it("keeps the card when the answers cannot be saved", async () => {
		api.fn("updateTask").mockResolvedValue({ success: false, error: "locked" });
		show({ ready: false, questions });
		await userEvent.type(screen.getByRole("textbox", { name: "Which browser?" }), "Firefox");
		await userEvent.click(screen.getByRole("button", { name: "Add details and start" }));
		expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
	});

	it("sets the card aside for later, by its button or the dialog's corner", async () => {
		const first = show({ ready: false, questions });
		await userEvent.click(screen.getByRole("button", { name: "Later" }));
		expect(useTaskReadinessStore.getState().held).toEqual([]);
		first.unmount();
		show({ ready: false, questions });
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(useTaskReadinessStore.getState().held).toEqual([]);
	});

	it("drops a held card that was deleted meanwhile", async () => {
		show({ ready: false, questions }, []);
		await waitFor(() => expect(useTaskReadinessStore.getState().held).toEqual([]));
	});
});

describe("clarificationsSection", () => {
	it("leaves out the questions left blank", () => {
		expect(clarificationsSection("T", questions, { q1: " ", q2: "Yes" })).toBe("\n\n## T\n\n**Which browser?**\n\nYes\n");
	});
});
