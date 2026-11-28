import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../__tests__/helpers/renderer-api";
import type { InterruptedTask } from "../../../shared/types/interrupted-tasks";
import { useInterruptedTasksStore } from "../../stores/interrupted-tasks-store";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import { Toaster } from "../ui/toaster";
import { InterruptedTasksDialog } from "./InterruptedTasksDialog";

const item = (overrides: Partial<InterruptedTask> = {}): InterruptedTask => ({
	taskId: "t1",
	projectId: "p1",
	projectName: "Invoices",
	title: "Export invoices to CSV",
	origin: "app_exit",
	interruptedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
	phase: "coding",
	subtasksDone: 3,
	subtasksTotal: 7,
	nextSubtask: "Add GET /invoices/export",
	provider: "claude",
	model: "sonnet",
	blocker: null,
	selectedByDefault: true,
	...overrides,
});

let api: RendererApi;
const resolveInterruptedTasks = vi.fn(async (ids: string[]) => ({ resumed: ids, waiting: [], failed: [] }));
const saveSettings = vi.fn(async () => ({ success: true }));

function show(tasks: InterruptedTask[]) {
	useInterruptedTasksStore.setState({ offer: tasks, autoResumed: null });
	return render(
		<>
			<InterruptedTasksDialog />
			<Toaster />
		</>,
	);
}

beforeEach(() => {
	resolveInterruptedTasks.mockClear();
	saveSettings.mockClear();
	api = installRendererApi({ resolveInterruptedTasks, saveSettings });
	useProjectStore.setState({ projects: [{ id: "p1", settings: { maxParallelTasks: 1 } } as never] });
	useInterruptedTasksStore.setState({ offer: null, autoResumed: null });
});
afterEach(() => api.restore());

describe("InterruptedTasksDialog", () => {
	it("shows nothing when the launch found nothing interrupted", () => {
		const { container } = render(<InterruptedTasksDialog />);
		expect(container).toBeEmptyDOMElement();
	});

	it("lists each build with where it resumes, the person's own stop unticked", async () => {
		show([
			item(),
			item({ taskId: "t2", title: "Just tell me", origin: "stopped_by_you", phase: "planning", selectedByDefault: false }),
		]);
		expect(screen.getByText("2 tasks were interrupted")).toBeInTheDocument();
		expect(screen.getByText(/Resumes at “Add GET \/invoices\/export”/)).toBeInTheDocument();
		expect(screen.getByText("Code 3/7")).toBeInTheDocument();
		expect(screen.getByText(/Unticked because you stopped it/)).toBeInTheDocument();
		expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

		await userEvent.click(screen.getByTestId("interrupted-resume"));

		await waitFor(() => expect(resolveInterruptedTasks).toHaveBeenCalledWith(["t1"]));
		expect(useInterruptedTasksStore.getState().offer).toBeNull();
		expect(await screen.findByText("1 task resumed")).toBeInTheDocument();
	});

	it("« Later » resumes nothing and puts every build off", async () => {
		show([item()]);
		await userEvent.click(screen.getByRole("button", { name: "Later" }));
		await waitFor(() => expect(resolveInterruptedTasks).toHaveBeenCalledWith([]));
		expect(useInterruptedTasksStore.getState().offer).toBeNull();
	});

	it("says why a build would fail, and which ones will wait for a slot", async () => {
		show([
			item(),
			item({ taskId: "t2", title: "Second" }),
			item({ taskId: "t3", title: "Third", blocker: "claude_auth", selectedByDefault: false }),
		]);
		expect(screen.getByText(/Claude sign-in expired/)).toBeInTheDocument();
		expect(screen.getByText(/takes 1 tasks: 1 will wait for a free slot/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
	});

	it("lists a server card the team server stopped, a teammate's unticked, with no slot line", async () => {
		show([
			item({ taskId: "server:p9:001-a", projectId: "p9", origin: "server_restart", onServer: true }),
			item({
				taskId: "server:p9:002-b",
				projectId: "p9",
				title: "Bob's card",
				origin: "server_restart",
				onServer: true,
				selectedByDefault: false,
				startedByName: "Bob",
			}),
		]);
		expect(screen.getByText(/WorkPilot or the team server stopped/)).toBeInTheDocument();
		expect(screen.getAllByText("Server restarted · 14 min ago")).toHaveLength(2);
		expect(screen.getByText("Started by Bob: unticked, it is their run.")).toBeInTheDocument();
		expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(screen.queryByText(/will wait for a free slot/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByTestId("interrupted-resume"));
		await waitFor(() =>
			expect(resolveInterruptedTasks).toHaveBeenCalledWith(["server:p9:001-a", "server:p9:002-b"]),
		);
	});

	it("saves « Next time » with the answer", async () => {
		useSettingsStore.setState((s) => ({ settings: { ...s.settings, interruptedTasksOnLaunch: undefined } }));
		show([item()]);
		await userEvent.click(screen.getByTestId("interrupted-policy-always"));
		await userEvent.click(screen.getByTestId("interrupted-resume"));
		await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ interruptedTasksOnLaunch: "always" }));
	});

	it("only toasts what « Resume all » restarted on its own", async () => {
		useInterruptedTasksStore.getState().receive({
			mode: "resumed",
			tasks: [item(), item({ taskId: "t2", title: "Second" })],
			resumed: ["t1"],
		});
		// The Toaster listens before the dialog's effect toasts, as in the app.
		render(
			<>
				<Toaster />
				<InterruptedTasksDialog />
			</>,
		);
		expect(await screen.findByText("1 interrupted task resumed")).toBeInTheDocument();
		expect(screen.queryByTestId("interrupted-tasks-dialog")).not.toBeInTheDocument();
	});
});
