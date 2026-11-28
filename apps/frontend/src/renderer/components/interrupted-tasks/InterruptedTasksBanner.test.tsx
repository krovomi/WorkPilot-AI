import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../__tests__/helpers/renderer-api";
import type { Task } from "../../../shared/types";
import type { InterruptedTask } from "../../../shared/types/interrupted-tasks";
import { useInterruptedTasksStore } from "../../stores/interrupted-tasks-store";
import { Toaster } from "../ui/toaster";
import { InterruptedTasksBanner } from "./InterruptedTasksBanner";

const card = (id: string, reason: string | null, extra: Record<string, unknown> = {}) =>
	({
		id,
		status: "in_progress",
		metadata: reason ? { paused: { enabled: true, reason, ...extra } } : {},
	}) as unknown as Task;

const listed: InterruptedTask = {
	taskId: "t1",
	projectId: "p1",
	projectName: "Invoices",
	title: "Export invoices",
	origin: "app_exit",
	interruptedAt: null,
	phase: "coding",
	subtasksDone: 1,
	subtasksTotal: 3,
	nextSubtask: null,
	provider: null,
	model: null,
	blocker: null,
	selectedByDefault: true,
};

let api: RendererApi;
const listInterruptedTasks = vi.fn(async (_projectId: string) => [listed]);

beforeEach(() => {
	listInterruptedTasks.mockClear();
	api = installRendererApi({ listInterruptedTasks });
	useInterruptedTasksStore.setState({ offer: null, autoResumed: null });
});
afterEach(() => api.restore());

describe("InterruptedTasksBanner", () => {
	it("counts only the builds the app interrupted, closed or crashed", () => {
		render(
			<InterruptedTasksBanner
				projectId="p1"
				tasks={[
					card("t1", "app_shutdown"),
					card("t2", "app_shutdown", { crashed: true }),
					card("t3", "kill_switch"),
					card("t4", null),
					card("t5", "app_shutdown", { deferred_at: "2026-11-28T18:05:00Z" }),
				]}
			/>,
		);
		expect(screen.getByTestId("interrupted-tasks-banner")).toHaveTextContent(
			"3 interrupted tasks · Resume…",
		);
	});

	it("is absent with nothing interrupted, without a project, or while the dialog is open", () => {
		const { container, rerender } = render(
			<InterruptedTasksBanner projectId="p1" tasks={[card("t3", "kill_switch")]} />,
		);
		expect(container).toBeEmptyDOMElement();
		rerender(<InterruptedTasksBanner projectId={undefined} tasks={[card("t1", "app_shutdown")]} />);
		expect(container).toBeEmptyDOMElement();
		useInterruptedTasksStore.setState({ offer: [listed] });
		rerender(<InterruptedTasksBanner projectId="p1" tasks={[card("t1", "app_shutdown")]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("reopens the launch dialog on this project's interrupted builds", async () => {
		const user = userEvent.setup();
		render(<InterruptedTasksBanner projectId="p1" tasks={[card("t1", "app_shutdown")]} />);
		await user.click(screen.getByTestId("interrupted-tasks-banner"));
		expect(listInterruptedTasks).toHaveBeenCalledWith("p1");
		await waitFor(() => expect(useInterruptedTasksStore.getState().offer).toEqual([listed]));
	});

	it("says so when nothing is left to resume", async () => {
		listInterruptedTasks.mockResolvedValueOnce([]);
		const user = userEvent.setup();
		render(
			<>
				<Toaster />
				<InterruptedTasksBanner projectId="p1" tasks={[card("t1", "app_shutdown")]} />
			</>,
		);
		await user.click(screen.getByTestId("interrupted-tasks-banner"));
		expect(await screen.findByText("No interrupted task left to resume")).toBeInTheDocument();
		expect(useInterruptedTasksStore.getState().offer).toBeNull();
	});
});
