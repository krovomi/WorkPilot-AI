/**
 * @vitest-environment jsdom
 */
/** "Stop all agents" (#353): shown while an agent runs, on its shortcut always. */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../../shared/i18n";

const toast = vi.fn();
const loadTasks = vi.fn();
let tasks: unknown[] = [];

vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../../../stores/project-store", () => ({
	useProjectStore: { getState: () => ({ selectedProjectId: "p1" }) },
}));
vi.mock("../../../stores/task-store", () => ({
	loadTasks: (...args: unknown[]) => loadTasks(...args),
	useTaskStore: (select: (s: { tasks: unknown[] }) => unknown) => select({ tasks }),
}));

import type { Task } from "../../../../shared/types";
import { taskMock } from "../../../lib/mocks/task-mock";
import { TooltipProvider } from "../../ui/tooltip";
import { isAgentRunning, isStopAllShortcut, StopAllAgentsButton } from "../StopAllAgentsButton";

function running(status = "in_progress", paused = false): Task {
	return { id: "t1", status, metadata: paused ? { paused: { enabled: true } } : {} } as unknown as Task;
}

function view() {
	return render(
		<TooltipProvider>
			<StopAllAgentsButton />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	tasks = [];
	toast.mockReset();
	loadTasks.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("StopAllAgentsButton", () => {
	it("knows a running task from a paused or finished one", () => {
		expect(isAgentRunning(running())).toBe(true);
		expect(isAgentRunning(running("ai_review"))).toBe(true);
		expect(isAgentRunning(running("in_progress", true))).toBe(false);
		expect(isAgentRunning(running("done"))).toBe(false);
	});

	it("reads only Ctrl or Cmd, Shift and the period key", () => {
		const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
		expect(isStopAllShortcut(press({ ctrlKey: true, shiftKey: true, code: "Period" }))).toBe(true);
		expect(isStopAllShortcut(press({ metaKey: true, shiftKey: true, code: "Period" }))).toBe(true);
		expect(isStopAllShortcut(press({ ctrlKey: true, code: "Period" }))).toBe(false);
		expect(isStopAllShortcut(press({ ctrlKey: true, shiftKey: true, code: "KeyK" }))).toBe(false);
	});

	it("stays out of the way while nothing runs", () => {
		vi.stubGlobal("electronAPI", { stopAllAgents: vi.fn() });
		view();
		expect(screen.queryByTestId("stop-all-agents")).not.toBeInTheDocument();
	});

	it("pauses every task from the button, then reloads the board", async () => {
		tasks = [running()];
		const stopAllAgents = vi.fn().mockResolvedValue({
			success: true,
			data: { pausedTasks: ["t1", "t2"], stoppedProcesses: 1, failedTasks: [] },
		});
		vi.stubGlobal("electronAPI", { stopAllAgents });
		view();
		fireEvent.click(screen.getByRole("button", { name: "Stop all agents" }));
		await waitFor(() => expect(loadTasks).toHaveBeenCalledWith("p1", { forceRefresh: true }));
		expect(stopAllAgents).toHaveBeenCalledWith();
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 tasks paused" }));
	});

	it("answers its shortcut even when no button is shown", async () => {
		const stopAllAgents = vi.fn().mockResolvedValue({
			success: true,
			data: { pausedTasks: [], stoppedProcesses: 0, failedTasks: [] },
		});
		vi.stubGlobal("electronAPI", { stopAllAgents });
		view();
		act(() => {
			globalThis.dispatchEvent(
				new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "Period" }),
			);
		});
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith({ title: "No agent was running" }),
		);
	});

	it("says so when the agents could not be stopped", async () => {
		tasks = [running()];
		vi.stubGlobal("electronAPI", { stopAllAgents: vi.fn().mockResolvedValue({ success: false }) });
		view();
		fireEvent.click(screen.getByTestId("stop-all-agents"));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
		);
	});

	it("sends one request while the first is still on its way", async () => {
		tasks = [running()];
		let answer: (value: unknown) => void = () => undefined;
		const stopAllAgents = vi.fn(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		vi.stubGlobal("electronAPI", { stopAllAgents });
		view();
		const button = screen.getByTestId("stop-all-agents");
		fireEvent.click(button);
		fireEvent.click(button);
		expect(stopAllAgents).toHaveBeenCalledTimes(1);
		await act(async () => {
			answer({ success: true, data: { pausedTasks: ["t1"], stoppedProcesses: 0, failedTasks: [] } });
		});
		await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
	});

	it("ignores every other key", () => {
		const stopAllAgents = vi.fn();
		vi.stubGlobal("electronAPI", { stopAllAgents });
		view();
		act(() => {
			globalThis.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, code: "Period" }));
		});
		expect(stopAllAgents).not.toHaveBeenCalled();
	});

	it("has a browser mock that stops nothing", async () => {
		expect(await taskMock.stopAllAgents()).toEqual({
			success: true,
			data: { pausedTasks: [], stoppedProcesses: 0, failedTasks: [] },
		});
	});
});
