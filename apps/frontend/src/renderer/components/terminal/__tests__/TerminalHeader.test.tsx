/**
 * The header of a terminal: its status, title, task and worktree, and the
 * buttons that act on it. The task selector names the phase in the app's
 * language, and survives a phase it does not know.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TerminalWorktreeConfig } from "../../../../shared/types";
import { useTerminalStore } from "../../../stores/terminal-store";
import { TaskSelector } from "../TaskSelector";
import { TerminalHeader } from "../TerminalHeader";
import { TerminalTitle } from "../TerminalTitle";
import { getTitleMaxWidthClass } from "../types";

const initialTerminals = useTerminalStore.getState();

function task(overrides: Partial<Task>): Task {
	return {
		id: "t1",
		title: "Cart checkout",
		description: "Let a customer pay for the cart",
		status: "backlog",
		...overrides,
	} as Task;
}

const handlers = {
	onClose: vi.fn(),
	onInvokeClaude: vi.fn(),
	onTitleChange: vi.fn(),
	onTaskSelect: vi.fn(),
	onClearTask: vi.fn(),
};

function header(props: Partial<Parameters<typeof TerminalHeader>[0]> = {}) {
	return render(
		<TerminalHeader
			terminalId="term-1"
			title="Shell 1"
			status="idle"
			isClaudeMode={false}
			tasks={[]}
			{...handlers}
			{...props}
		/>,
	);
}

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
});

afterEach(() => {
	useTerminalStore.setState(initialTerminals, true);
	vi.useRealTimers();
});

describe("getTitleMaxWidthClass", () => {
	it("narrows the title as terminals are added", () => {
		expect([1, 3, 5, 8, 12].map(getTitleMaxWidthClass)).toEqual([
			"max-w-72",
			"max-w-56",
			"max-w-48",
			"max-w-40",
			"max-w-36",
		]);
	});
});

describe("TaskSelector", () => {
	const open = async (name: RegExp | string) => {
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name }));
		return user;
	};

	it("offers the backlog and a way to add a task", async () => {
		const onNewTaskClick = vi.fn();
		const tasks = Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
		render(
			<TaskSelector
				backlogTasks={tasks}
				onTaskSelect={handlers.onTaskSelect}
				onClearTask={handlers.onClearTask}
				onNewTaskClick={onNewTaskClick}
			/>,
		);
		const user = await open("Select task...");
		expect(screen.getByText("Available tasks")).toBeTruthy();
		expect(screen.getAllByRole("menuitem")).toHaveLength(9);
		await user.click(screen.getByRole("menuitem", { name: "Task 2" }));
		expect(handlers.onTaskSelect).toHaveBeenCalledWith("t2");

		await open("Select task...");
		await user.click(screen.getByRole("menuitem", { name: "Add new task" }));
		expect(onNewTaskClick).toHaveBeenCalledOnce();
	});

	it("explains where tasks come from when there are none", async () => {
		const view = render(
			<TaskSelector backlogTasks={[]} onTaskSelect={vi.fn()} onClearTask={vi.fn()} />,
		);
		await open("Select task...");
		expect(screen.getByText("No tasks available")).toBeTruthy();
		expect(screen.getByText("Create tasks in the Kanban board")).toBeTruthy();
		view.unmount();

		const onNewTaskClick = vi.fn();
		render(
			<TaskSelector
				backlogTasks={[]}
				onTaskSelect={vi.fn()}
				onClearTask={vi.fn()}
				onNewTaskClick={onNewTaskClick}
			/>,
		);
		const user = await open("Select task...");
		await user.click(screen.getByRole("menuitem", { name: "Add new task" }));
		expect(onNewTaskClick).toHaveBeenCalledOnce();
	});

	it("names the running phase in the app's language and lets the task be switched or cleared", async () => {
		const current = task({
			id: "cur",
			title: "Current work",
			status: "in_progress",
			executionProgress: { phase: "coding", message: "Writing the parser" } as Task["executionProgress"],
		});
		render(
			<TaskSelector
				backlogTasks={[current, task({ id: "other", title: "Next work" })]}
				associatedTask={current}
				onTaskSelect={handlers.onTaskSelect}
				onClearTask={handlers.onClearTask}
			/>,
		);
		const user = await open(/Coding/);
		expect(screen.getByText("Writing the parser")).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: "Current work" })).toBeNull();
		await user.click(screen.getByRole("menuitem", { name: "Next work" }));
		expect(handlers.onTaskSelect).toHaveBeenCalledWith("other");

		await open(/Coding/);
		await user.click(screen.getByRole("menuitem", { name: "Clear task" }));
		expect(handlers.onClearTask).toHaveBeenCalledOnce();
	});

	it("speaks French, and reads an unknown phase as ready", async () => {
		await i18n.changeLanguage("fr");
		const current = task({
			status: "in_progress",
			executionProgress: { phase: "from_a_newer_backend" } as unknown as Task["executionProgress"],
		});
		const view = render(
			<TaskSelector backlogTasks={[]} associatedTask={current} onTaskSelect={vi.fn()} onClearTask={vi.fn()} />,
		);
		expect(screen.getByRole("button", { name: /Prête/ })).toBeTruthy();
		view.unmount();

		render(
			<TaskSelector
				backlogTasks={[]}
				associatedTask={task({ status: "human_review", executionProgress: { phase: "complete" } as Task["executionProgress"] })}
				onTaskSelect={vi.fn()}
				onClearTask={vi.fn()}
			/>,
		);
		const user = await open(/Terminée/);
		expect(screen.queryByText("Passer à...")).toBeNull();
		await user.keyboard("{Escape}");
	});

	it("shows a task without progress as ready", () => {
		render(
			<TaskSelector backlogTasks={[]} associatedTask={task({})} onTaskSelect={vi.fn()} onClearTask={vi.fn()} />,
		);
		expect(screen.getByRole("button", { name: /Ready/ })).toBeTruthy();
	});
});

describe("TerminalTitle", () => {
	it("renames on double-click, saving a trimmed new name with Enter", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		render(<TerminalTitle title="Shell 1" onTitleChange={handlers.onTitleChange} />);
		fireEvent.doubleClick(screen.getByText("Shell 1"));
		const input = screen.getByRole("textbox") as HTMLInputElement;
		vi.advanceTimersByTime(0);
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "  api server  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(handlers.onTitleChange).toHaveBeenCalledWith("api server");
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("keeps the name when it is unchanged, blank or cancelled", () => {
		render(<TerminalTitle title="Shell 1" onTitleChange={handlers.onTitleChange} />);
		fireEvent.doubleClick(screen.getByText("Shell 1"));
		fireEvent.blur(screen.getByRole("textbox"));
		fireEvent.doubleClick(screen.getByText("Shell 1"));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		fireEvent.doubleClick(screen.getByText("Shell 1"));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "other" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "a" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(handlers.onTitleChange).not.toHaveBeenCalled();
		expect(screen.getByText("Shell 1")).toBeTruthy();
	});

	it("keeps a click in the name field from reaching the terminal behind it", () => {
		const onParentClick = vi.fn();
		render(<TerminalTitle title="Shell 1" onTitleChange={handlers.onTitleChange} />);
		fireEvent.doubleClick(screen.getByText("Shell 1"));
		document.body.addEventListener("click", onParentClick);
		fireEvent.click(screen.getByRole("textbox"));
		document.body.removeEventListener("click", onParentClick);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	it("explains the task it belongs to on hover", async () => {
		const user = userEvent.setup();
		render(
			<TerminalTitle
				title="Cart"
				associatedTask={task({})}
				onTitleChange={handlers.onTitleChange}
				terminalCount={7}
			/>,
		);
		const title = screen.getByText("Cart");
		expect(title.className).toContain("max-w-40");
		await user.hover(title);
		expect((await screen.findAllByText("Let a customer pay for the cart")).length).toBeGreaterThan(0);
		fireEvent.doubleClick(title);
		expect(screen.getByRole("textbox")).toHaveProperty("value", "Cart");
	});
});

describe("TerminalHeader", () => {
	it("offers Claude to a plain shell and closes the terminal", () => {
		header();
		fireEvent.click(screen.getByTitle("Claude"));
		expect(handlers.onInvokeClaude).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByTitle("Close (Ctrl+W)"));
		expect(handlers.onClose).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: /Select task/ })).toBeNull();
	});

	it("shows Claude mode with its task selector, from the backlog only", () => {
		header({
			isClaudeMode: true,
			tasks: [task({ title: "Waiting" }), task({ id: "t2", title: "Running", status: "in_progress" })],
		});
		expect(screen.getByText("Claude")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Select task/ })).toBeTruthy();
		expect(screen.queryByTitle("Claude")?.tagName).not.toBe("BUTTON");
	});

	it("drops the labels when many terminals share the row", () => {
		header({ isClaudeMode: true, terminalCount: 6, pendingClaudeResume: true });
		expect(screen.queryByText("Claude")).toBeNull();
		expect(screen.getByTitle("Click to resume previous Claude session")).toBeTruthy();
		expect(screen.queryByText("Resume Available")).toBeNull();
	});

	it("says a session can be resumed, and resumes them all when several can", () => {
		const resumeAllPendingClaude = vi.fn();
		useTerminalStore.setState({
			terminals: [
				{ id: "a", pendingClaudeResume: true },
				{ id: "b", pendingClaudeResume: true },
			] as never,
			resumeAllPendingClaude,
		});
		header({ pendingClaudeResume: true });
		expect(screen.getByText("Resume Available")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Resume All/ }));
		expect(resumeAllPendingClaude).toHaveBeenCalledOnce();
	});

	it("shrinks Resume All to its icon when four terminals share the row", () => {
		useTerminalStore.setState({
			terminals: [
				{ id: "a", pendingClaudeResume: true },
				{ id: "b", pendingClaudeResume: true },
			] as never,
		});
		header({ pendingClaudeResume: true, terminalCount: 4 });
		const resumeAll = screen.getAllByRole("button").find((b) => b.className.includes("animate-pulse"));
		expect(resumeAll?.className).toContain("w-6");
		expect(resumeAll?.textContent).toBe("");
	});

	it("shows the worktree it works in and opens it in the IDE", () => {
		const onOpenInIDE = vi.fn();
		const worktreeConfig = { name: "cart-fix", worktreePath: "/w/cart-fix" } as TerminalWorktreeConfig;
		const view = header({ worktreeConfig, onOpenInIDE });
		expect(screen.getByTitle("cart-fix")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
		expect(onOpenInIDE).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: /Worktree/ })).toBeNull();
		view.unmount();

		const five = header({ worktreeConfig, onOpenInIDE, terminalCount: 5 });
		expect(screen.getByTitle("cart-fix").className).toContain("max-w-28");
		expect(screen.getByTitle("Open in IDE").textContent).toBe("");
		five.unmount();

		header({ worktreeConfig, onOpenInIDE, terminalCount: 6 });
		expect(screen.getByTitle("cart-fix").className).toContain("max-w-20");
	});

	it("offers to pick a worktree only when it can create and attach one", () => {
		const view = header({ projectPath: "/p" });
		expect(screen.queryByRole("button", { name: /Worktree/ })).toBeNull();
		view.unmount();
		header({ projectPath: "/p", onCreateWorktree: vi.fn(), onSelectWorktree: vi.fn(), terminalCount: 7 });
		expect(screen.getByRole("button", { name: /Worktree/ })).toBeTruthy();
	});

	it("expands and collapses, with the shortcut of the platform", () => {
		const onToggleExpand = vi.fn();
		const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		const view = header({ onToggleExpand, isExpanded: false, dragHandleListeners: {} });
		fireEvent.click(screen.getByTitle("Expand terminal (⌘+Shift+E)"));
		expect(onToggleExpand).toHaveBeenCalledOnce();
		expect(screen.getByTitle("Close (⌘+W)")).toBeTruthy();
		view.unmount();
		platform.mockRestore();

		header({ onToggleExpand, isExpanded: true, status: "exited", terminalCount: 4 });
		expect(screen.getByTitle("Collapse terminal (Ctrl+Shift+E)")).toBeTruthy();
		expect(screen.queryByTitle("Claude")).toBeNull();
	});
});
