/**
 * The bubble that opens on an agent: what it says about the agent, and which
 * actions it offers for a terminal, a Kanban task, a swarm subtask and a queued
 * task. The task bubble offers "Stop" only to a task that is executing, and
 * says plainly when a finished task has no log instead of waiting forever.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types";
import { resetTaskLogWatchesForTests } from "../../../lib/task-log-watch";
import type { PixelAgent } from "../../../stores/pixel-office-store";
import { useTaskStore } from "../../../stores/task-store";
import type { Terminal } from "../../../stores/terminal-store";
import { AddAgentButton, AgentBubble } from "../AgentBubble";

const noop = () => undefined;

const handlers = {
	onClose: vi.fn(),
	onGoToTerminal: vi.fn(),
	onGoToTask: vi.fn(),
	onKill: vi.fn(),
	onInterrupt: vi.fn(),
	onResumeClaude: vi.fn(),
	onSendCommand: vi.fn(),
	onStopTask: vi.fn(),
};

const taskAgent: PixelAgent = {
	id: "task:t1",
	type: "task",
	name: "Tests",
	fullName: "Tests générés : order_service.py",
	characterIndex: 0,
	activity: "idle",
	seatIndex: 0,
	isClaudeMode: true,
	taskId: "t1",
};

const terminalAgent: PixelAgent = {
	id: "term-1",
	type: "terminal",
	name: "Shell",
	fullName: "Shell 1",
	characterIndex: 1,
	activity: "idle",
	seatIndex: 1,
	isClaudeMode: false,
};

function bubble(
	agent: Partial<PixelAgent>,
	{ base = taskAgent, terminal, anchorX = 100 }: {
		base?: PixelAgent;
		terminal?: Partial<Terminal>;
		anchorX?: number;
	} = {},
) {
	return render(
		<AgentBubble
			agent={{ ...base, ...agent }}
			terminal={terminal as Terminal | undefined}
			anchorX={anchorX}
			anchorY={100}
			{...handlers}
		/>,
	);
}

const terminalBubble = (agent: Partial<PixelAgent>, terminal?: Partial<Terminal>) =>
	bubble(agent, { base: terminalAgent, terminal });

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getTaskLogs: vi.fn(async () => ({ success: true, data: null })),
		watchTaskLogs: vi.fn(async () => ({ success: true })),
		unwatchTaskLogs: vi.fn(async () => ({ success: true })),
		onTaskLogsChanged: vi.fn(() => noop),
	};
});

afterEach(() => {
	resetTaskLogWatchesForTests();
	useTaskStore.setState({ tasks: [] });
	vi.useRealTimers();
});

function setTask(status: Task["status"]) {
	useTaskStore.setState({
		tasks: [
			{ id: "t1", specId: "001-a", projectId: "p1", status, logs: [], subtasks: [] } as unknown as Task,
		],
	});
}

describe("AgentBubble task panel", () => {
	it("does not offer to stop a task waiting for its human review", async () => {
		setTask("human_review");
		bubble({ activity: "waiting", phase: "complete", progress: 100 });
		expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
		await waitFor(() =>
			expect(screen.getByText("No log was recorded for this task.")).toBeTruthy(),
		);
	});

	it("offers to stop a task that is executing, and waits for its log", async () => {
		setTask("in_progress");
		bubble({ activity: "typing", phase: "coding", progress: 40 });
		expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("shows the whole title on hover", () => {
		setTask("human_review");
		bubble({ activity: "waiting", phase: "complete" });
		expect(screen.getByTitle("Tests générés : order_service.py")).toBeTruthy();
	});

	it("names the phase, explains it and shows the subtask and progress", async () => {
		setTask("in_progress");
		bubble({ activity: "typing", phase: "coding", progress: 41.6, currentSubtask: "Write the parser" });
		expect(screen.getByText("Development")).toBeTruthy();
		expect(screen.getByText("Kanban")).toBeTruthy();
		expect(
			screen.getByText("Code is being written. Subtasks run one after another automatically."),
		).toBeTruthy();
		expect(screen.getByText("Write the parser")).toBeTruthy();
		expect(screen.getByText("42%")).toBeTruthy();
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("says which provider problem paused the task without naming one provider", async () => {
		setTask("in_progress");
		bubble({ activity: "waiting", phase: "rate_limit_paused" });
		expect(
			screen.getByText("The provider hit its usage limit. The task resumes on its own in a moment."),
		).toBeTruthy();
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("reads a phase it does not know, or none, as standing by", async () => {
		setTask("in_progress");
		const view = bubble({ phase: "from_a_newer_backend" as PixelAgent["phase"] });
		expect(screen.getByText("Standing by")).toBeTruthy();
		expect(screen.getByText("Ready to start.")).toBeTruthy();
		view.unmount();

		bubble({ phase: undefined, progress: undefined });
		expect(screen.getByText("Standing by")).toBeTruthy();
		expect(screen.queryByText("Overall progress")).toBeNull();
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("opens the card and stops the task by its id", async () => {
		setTask("in_progress");
		bubble({ activity: "running", phase: "qa_fixing" });
		fireEvent.click(screen.getByRole("button", { name: "View in Kanban" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(handlers.onGoToTask).toHaveBeenCalledWith("t1");
		expect(handlers.onStopTask).toHaveBeenCalledWith("t1");
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("offers a finished task only to be closed", async () => {
		setTask("human_review");
		bubble({ activity: "waiting", phase: "complete" });
		const closes = screen.getAllByRole("button", { name: "Close" });
		fireEvent.click(closes[closes.length - 1]);
		expect(handlers.onClose).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(screen.getByText("No log was recorded for this task.")).toBeTruthy(),
		);
	});
});

describe("AgentBubble swarm subtask", () => {
	it("offers neither the Kanban nor Stop, which would have no card to act on", () => {
		bubble({
			id: "swarm:s1",
			type: "swarm",
			taskId: undefined,
			activity: "typing",
			fullName: "Subtask 2.1",
			progress: 30,
		});
		expect(screen.getByText("Subtask")).toBeTruthy();
		expect(screen.getByText("Coding")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "View in Kanban" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Agent logs/ })).toBeNull();
		expect(screen.getByText("30%")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
	});
});

describe("AgentBubble queued task", () => {
	it("explains the queue and opens the card", () => {
		bubble({ activity: "pending", phase: "planning" });
		expect(screen.getByText("Queued")).toBeTruthy();
		expect(screen.getByText("Waiting for an available agent")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "View in Kanban" }));
		expect(handlers.onGoToTask).toHaveBeenCalledWith("t1");
		const closes = screen.getAllByRole("button", { name: "Close" });
		fireEvent.click(closes[closes.length - 1]);
		expect(handlers.onClose).toHaveBeenCalledOnce();
	});
});

describe("AgentBubble terminal panel", () => {
	it("describes what the agent does on its task", () => {
		const view = terminalBubble({ activity: "typing", taskName: "Login page" });
		expect(
			screen.getByText('Implementing "Login page" — the agent is actively writing code.'),
		).toBeTruthy();
		expect(screen.getByTitle("Task")).toBeTruthy();
		view.unmount();

		terminalBubble({ activity: "reading", taskName: "Login page" });
		expect(screen.getByText('Reading the code to understand "Login page".')).toBeTruthy();
	});

	it("falls back to the plain description when it has no task", () => {
		terminalBubble({ activity: "running" });
		expect(screen.getByText("Running")).toBeTruthy();
		expect(
			screen.getByText(
				"The agent is running a command (tests, build, install…). Wait for it or interrupt it.",
			),
		).toBeTruthy();
		expect(screen.queryByTitle("Task")).toBeNull();
	});

	it("shows the directory, the session and the branch of the terminal", () => {
		terminalBubble(
			{ isClaudeMode: true },
			{
				cwd: "C:\\Users\\dev\\shop\\api",
				claudeSessionId: "0123456789abcdef",
				worktreeConfig: { branchName: "feature/cart" } as Terminal["worktreeConfig"],
			},
		);
		expect(screen.getByText("Claude")).toBeTruthy();
		expect(screen.getByText("shop/api")).toBeTruthy();
		expect(screen.getByText("01234567…")).toBeTruthy();
		expect(screen.getByText("feature/cart")).toBeTruthy();
	});

	it("leaves out what the terminal does not have", () => {
		terminalBubble({}, { cwd: "", claudeSessionId: undefined });
		expect(screen.queryByTitle("Directory")).toBeNull();
		expect(screen.queryByTitle("Session")).toBeNull();
		expect(screen.queryByTitle("Branch")).toBeNull();
	});

	it("sends a trimmed command with Enter or the button, and never an empty one", async () => {
		const user = userEvent.setup();
		terminalBubble({});
		const input = screen.getByPlaceholderText("Give an order to the terminal…");
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toHaveProperty("disabled", true);

		await user.type(input, "   {Enter}");
		expect(handlers.onSendCommand).not.toHaveBeenCalled();

		await user.clear(input);
		await user.type(input, "  npm test  {Enter}");
		expect(handlers.onSendCommand).toHaveBeenLastCalledWith("npm test");
		expect(input).toHaveProperty("value", "");

		await user.type(input, "ls");
		await user.click(send);
		expect(handlers.onSendCommand).toHaveBeenLastCalledWith("ls");
		await user.type(input, "x");
		await user.keyboard("{Shift}");
		expect(handlers.onSendCommand).toHaveBeenCalledTimes(2);
	});

	it("asks for an answer when the agent is waiting, and focuses the input", async () => {
		vi.useFakeTimers();
		terminalBubble({ activity: "waiting", isClaudeMode: true }, { isClaudeMode: true });
		const input = screen.getByPlaceholderText("Reply to the agent…");
		expect(screen.getByText("↵ Enter to send · Typed straight into the terminal")).toBeTruthy();
		act(() => vi.advanceTimersByTime(50));
		expect(document.activeElement).toBe(input);
		fireEvent.click(screen.getByRole("button", { name: "Resume Claude" }));
		expect(handlers.onResumeClaude).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
	});

	it("offers to interrupt a busy agent and to close or open the terminal", () => {
		terminalBubble({ activity: "typing" }, { isClaudeMode: true });
		fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
		fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
		fireEvent.click(screen.getByRole("button", { name: "View terminal" }));
		expect(handlers.onInterrupt).toHaveBeenCalledOnce();
		expect(handlers.onKill).toHaveBeenCalledOnce();
		expect(handlers.onGoToTerminal).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Resume Claude" })).toBeNull();
		// Closing the terminal is never confused with closing the bubble.
		expect(handlers.onClose).not.toHaveBeenCalled();
	});

	it("offers only to open a closed session", () => {
		terminalBubble({ activity: "exited" }, { isClaudeMode: true });
		expect(screen.getByText("Session ended")).toBeTruthy();
		expect(screen.getByText("This terminal has been closed.")).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close terminal" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Resume Claude" })).toBeNull();
		expect(screen.getByRole("button", { name: "View terminal" })).toBeTruthy();
	});
});

describe("AgentBubble frame", () => {
	it("closes once on Escape and with its close button, not on other keys", () => {
		terminalBubble({});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(handlers.onClose).toHaveBeenCalledOnce();
		fireEvent.keyDown(globalThis.window, { key: "a" });
		expect(handlers.onClose).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(handlers.onClose).toHaveBeenCalledTimes(2);
	});

	it("stops listening for Escape once closed", () => {
		const view = terminalBubble({});
		view.unmount();
		fireEvent.keyDown(globalThis.window, { key: "Escape" });
		expect(handlers.onClose).not.toHaveBeenCalled();
	});

	it("points its arrow at the agent, kept inside the bubble", () => {
		const arrowLeft = (anchorX: number) => {
			const view = bubble({ activity: "pending" }, { anchorX });
			const dialog = screen.getByRole("dialog", { name: taskAgent.fullName });
			const pad = (dialog.firstElementChild as HTMLElement).style.paddingLeft;
			view.unmount();
			return pad;
		};
		expect(arrowLeft(0)).toBe("20px");
		expect(arrowLeft(300)).toBe("284px");
		expect(arrowLeft(10_000)).toBe(`${globalThis.innerWidth - 52}px`);
	});
});

describe("AddAgentButton", () => {
	it("opens a terminal unless it is disabled", () => {
		const onClick = vi.fn();
		const view = render(<AddAgentButton onClick={onClick} />);
		fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
		expect(onClick).toHaveBeenCalledOnce();
		view.rerender(<AddAgentButton onClick={onClick} disabled />);
		expect(screen.getByRole("button", { name: "New terminal" })).toHaveProperty("disabled", true);
	});
});
