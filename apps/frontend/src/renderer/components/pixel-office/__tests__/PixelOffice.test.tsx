/**
 * The office view: who is in the room (terminals, tasks, swarm subtasks and the
 * queue), what the toolbar and keyboard do, and where each bubble action lands.
 * The canvas itself has its own test; here it is replaced by a probe that
 * reports the size it was given and lets a test click an agent.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types";
import type { SwarmStatus } from "../../../../shared/types/swarm";
import { usePixelOfficeStore } from "../../../stores/pixel-office-store";
import { useSwarmStore } from "../../../stores/swarm-store";
import { useTaskStore } from "../../../stores/task-store";
import { type Terminal, useTerminalStore } from "../../../stores/terminal-store";
import { TooltipProvider } from "../../ui/tooltip";
import { PixelOffice } from "../PixelOffice";
import { resetTaskLogWatchesForTests } from "../../../lib/task-log-watch";
import { type FakeContext, installFakeCanvas, removeCanvasContext } from "./fake-canvas";

const canvasProbe = vi.hoisted(() => ({
	props: null as null | {
		width: number;
		height: number;
		emptyDeskLabel: string;
		onAgentClick?: (id: string, x: number, y: number) => void;
	},
}));

vi.mock("../PixelOfficeCanvas", () => ({
	PixelOfficeCanvas: (props: NonNullable<typeof canvasProbe.props>) => {
		canvasProbe.props = props;
		return <div data-testid="office-canvas" />;
	},
}));

const sounds = vi.hoisted(() => ({ playChime: vi.fn(), closeChimes: vi.fn() }));
vi.mock("../office-sounds", () => sounds);

const PROJECT = "/work/shop";

const initial = {
	office: usePixelOfficeStore.getState(),
	terminals: useTerminalStore.getState(),
	tasks: useTaskStore.getState(),
	swarm: useSwarmStore.getState(),
};

let resize: ResizeObserverCallback | null;
let contextOf: (canvas: HTMLCanvasElement) => FakeContext;
const disconnect = vi.fn();
const api = {
	createTerminal: vi.fn(async () => ({ success: true })),
	destroyTerminal: vi.fn(async () => ({ success: true })),
	sendTerminalInput: vi.fn(),
	invokeClaudeInTerminal: vi.fn(),
	stopTask: vi.fn(),
	getTaskLogs: vi.fn(),
	watchTaskLogs: vi.fn(),
	unwatchTaskLogs: vi.fn(),
	onTaskLogsChanged: vi.fn(),
};

function terminal(overrides: Partial<Terminal>): Terminal {
	return {
		id: "term-1",
		title: "Shell 1",
		status: "idle",
		cwd: PROJECT,
		projectPath: PROJECT,
		createdAt: new Date(),
		isClaudeMode: false,
		...overrides,
	} as Terminal;
}

function task(overrides: Partial<Task>): Task {
	return {
		id: "t1",
		specId: "001-cart",
		projectId: "p1",
		title: "Cart checkout",
		status: "in_progress",
		subtasks: [],
		logs: [],
		executionProgress: { phase: "coding", phaseProgress: 50, overallProgress: 40 },
		...overrides,
	} as unknown as Task;
}

function room({ terminals = [], tasks = [] }: { terminals?: Terminal[]; tasks?: Task[] }) {
	useTerminalStore.setState({ terminals });
	useTaskStore.setState({ tasks });
}

function mount(nav: { onNavigateToTerminals?: () => void; onNavigateToKanban?: () => void } = {}) {
	return render(
		<TooltipProvider>
			<PixelOffice projectPath={PROJECT} projectId="p1" {...nav} />
		</TooltipProvider>,
	);
}

function clickAgent(id: string, x = 300, y = 120) {
	act(() => canvasProbe.props?.onAgentClick?.(id, x, y));
}

const bubble = () => screen.queryByRole("dialog");
const press = (key: string, init: KeyboardEventInit = {}) =>
	fireEvent.keyDown(globalThis.window, { key, ...init });

beforeEach(async () => {
	vi.resetAllMocks();
	api.createTerminal.mockResolvedValue({ success: true });
	api.destroyTerminal.mockResolvedValue({ success: true });
	api.getTaskLogs.mockResolvedValue({ success: true, data: null });
	api.watchTaskLogs.mockResolvedValue({ success: true });
	api.unwatchTaskLogs.mockResolvedValue({ success: true });
	api.onTaskLogsChanged.mockReturnValue(() => undefined);
	await i18n.changeLanguage("en");
	Object.assign(globalThis.electronAPI, api);
	contextOf = installFakeCanvas();
	resize = null;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(cb: ResizeObserverCallback) {
				resize = cb;
			}
			observe = vi.fn();
			disconnect = disconnect;
		},
	);
	canvasProbe.props = null;
});

afterEach(() => {
	resetTaskLogWatchesForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	usePixelOfficeStore.setState(initial.office, true);
	useTerminalStore.setState(initial.terminals, true);
	useTaskStore.setState(initial.tasks, true);
	useSwarmStore.setState(initial.swarm, true);
});

describe("PixelOffice room", () => {
	it("invites to open a terminal when the office is empty, in the project folder", async () => {
		mount();
		expect(screen.getByText("Your office is empty")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getAllByRole("button", { name: "New terminal" })[1]);
		});
		const created = useTerminalStore.getState().terminals[0];
		expect(created.cwd).toBe(PROJECT);
		expect(api.createTerminal).toHaveBeenCalledWith({
			id: created.id,
			cwd: PROJECT,
			projectPath: PROJECT,
		});
	});

	it("opens a new terminal where its sibling works", async () => {
		room({ terminals: [terminal({ cwd: `${PROJECT}/api` })] });
		mount();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
		});
		expect(api.createTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: `${PROJECT}/api`, projectPath: PROJECT }),
		);
	});

	it("opens one terminal, not two, when a double click reaches the limit", async () => {
		useTerminalStore.setState({ maxTerminals: 2 });
		room({ terminals: [terminal({})] });
		mount();
		const add = screen.getByRole("button", { name: "New terminal" });
		await act(async () => {
			fireEvent.click(add);
			fireEvent.click(add);
		});
		expect(api.createTerminal).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "New terminal" })).toHaveProperty("disabled", true);
	});

	it("seats this project's terminals and active tasks and counts them", () => {
		room({
			terminals: [
				terminal({ id: "a", status: "running" }),
				terminal({ id: "b", projectPath: undefined }),
				terminal({ id: "other", projectPath: "/work/blog" }),
				terminal({ id: "gone", status: "exited" }),
			],
			tasks: [
				task({}),
				task({ id: "t2", status: "done" }),
				task({ id: "t3", projectId: "p2" }),
				task({ id: "t4", status: "backlog", title: "Queued work" }),
			],
		});
		mount();
		for (const badge of ["2 terminals", "1 task", "2 active", "1 queued"]) {
			expect(screen.getByText(badge)).toBeTruthy();
		}
		expect(screen.queryByText(/subtask/)).toBeNull();
		expect(screen.getByTestId("office-canvas")).toBeTruthy();
		expect(canvasProbe.props?.emptyDeskLabel).toBe("empty");
		expect(screen.getByText("Waiting to start")).toBeTruthy();
		expect(screen.getByText("1 task queued")).toBeTruthy();
	});

	it("shows only the queue while every task waits to start", () => {
		room({ tasks: [task({ status: "backlog" }), task({ id: "t2", status: "backlog" })] });
		mount();
		expect(screen.queryByTestId("office-canvas")).toBeNull();
		expect(screen.getByText("Agents will start as soon as the tasks are launched")).toBeTruthy();
		expect(screen.getByText("2 tasks queued")).toBeTruthy();
		const bobs = [...document.querySelectorAll<HTMLElement>("canvas")].map(
			(c) => (c.parentElement as HTMLElement).style.animationDelay,
		);
		expect(bobs).toEqual(["0s", "0.4s"]);
	});

	it("draws a character for each swarm subtask while the run lasts", () => {
		room({ tasks: [task({})] });
		mount();
		const nodes = {
			s1: { id: "s1", description: "Parse cart", state: "running", waveIndex: 0 },
			s2: { id: "s2", description: "Price cart", state: "running", waveIndex: 0 },
		};
		act(() => useSwarmStore.setState({ status: { nodes } as unknown as SwarmStatus }));
		expect(screen.getByText("2 subtasks")).toBeTruthy();
		act(() => useSwarmStore.setState({ status: { nodes: {} } as unknown as SwarmStatus }));
		expect(screen.queryByText(/subtask/)).toBeNull();
	});

	it("sizes the canvas to the room area it is drawn in", () => {
		room({ terminals: [terminal({})] });
		const view = mount();
		expect([canvasProbe.props?.width, canvasProbe.props?.height]).toEqual([800, 500]);
		act(() =>
			resize?.([{ contentRect: { width: 640.7, height: 452.9 } } as ResizeObserverEntry], {} as ResizeObserver),
		);
		expect([canvasProbe.props?.width, canvasProbe.props?.height]).toEqual([640, 452]);
		act(() =>
			resize?.([{ contentRect: { width: -3, height: -30 } } as ResizeObserverEntry], {} as ResizeObserver),
		);
		expect([canvasProbe.props?.width, canvasProbe.props?.height]).toEqual([0, 0]);
		view.unmount();
		expect(disconnect).toHaveBeenCalledOnce();
	});
});

describe("PixelOffice bubble actions", () => {
	it("opens on the clicked agent and closes on the backdrop or a click on the floor", () => {
		room({ terminals: [terminal({})] });
		mount();
		clickAgent("term-1");
		expect(bubble()?.getAttribute("aria-label")).toBe("Shell 1");
		fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
		expect(bubble()).toBeNull();

		clickAgent("term-1");
		clickAgent("");
		expect(bubble()).toBeNull();
		expect(usePixelOfficeStore.getState().selectedAgentId).toBeNull();
	});

	it("takes a terminal to the terminal view", () => {
		const onNavigateToTerminals = vi.fn();
		room({ terminals: [terminal({})] });
		mount({ onNavigateToTerminals });
		clickAgent("term-1");
		fireEvent.click(screen.getByRole("button", { name: "View terminal" }));
		expect(useTerminalStore.getState().jumpToTerminalId).toBe("term-1");
		expect(onNavigateToTerminals).toHaveBeenCalledOnce();
		expect(bubble()).toBeNull();
	});

	it("closes a terminal: the bubble first, then the process, then the character", async () => {
		room({ terminals: [terminal({})] });
		mount();
		clickAgent("term-1");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
		});
		expect(api.destroyTerminal).toHaveBeenCalledWith("term-1");
		expect(useTerminalStore.getState().terminals).toEqual([]);
		expect(screen.getByText("Your office is empty")).toBeTruthy();
	});

	it("types into the terminal: interrupt, commands, and resuming Claude", () => {
		room({
			terminals: [
				terminal({ id: "busy", isClaudeBusy: true }),
				terminal({ id: "claude", isClaudeMode: true, status: "claude-active" }),
			],
		});
		mount();
		clickAgent("busy");
		fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
		expect(api.sendTerminalInput).toHaveBeenLastCalledWith("busy", "\x03");
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "git status" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(api.sendTerminalInput).toHaveBeenLastCalledWith("busy", "git status\n");

		clickAgent("claude");
		fireEvent.click(screen.getByRole("button", { name: "Resume Claude" }));
		expect(api.invokeClaudeInTerminal).toHaveBeenCalledWith("claude");
	});

	it("takes a task to its card, and stops it", () => {
		const onNavigateToKanban = vi.fn();
		room({ tasks: [task({})] });
		mount({ onNavigateToKanban });
		clickAgent("task:t1");
		fireEvent.click(screen.getByRole("button", { name: "View in Kanban" }));
		expect(useTaskStore.getState().selectedTaskId).toBe("t1");
		expect(useTaskStore.getState().jumpToTaskId).toBe("t1");
		expect(onNavigateToKanban).toHaveBeenCalledOnce();
		expect(bubble()).toBeNull();

		clickAgent("task:t1");
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(api.stopTask).toHaveBeenCalledWith("t1");
		expect(bubble()).toBeNull();
	});

	it("works without the navigation callbacks", () => {
		room({ terminals: [terminal({})], tasks: [task({})] });
		mount();
		clickAgent("term-1");
		fireEvent.click(screen.getByRole("button", { name: "View terminal" }));
		clickAgent("task:t1");
		fireEvent.click(screen.getByRole("button", { name: "View in Kanban" }));
		expect(bubble()).toBeNull();
	});

	it("opens a queued task's bubble above the queue, under the clicked character", () => {
		room({ tasks: [task({ status: "backlog", title: "Queued work" })] });
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
			this: HTMLElement,
		) {
			return (this.tagName === "BUTTON"
				? { left: 200, width: 48 }
				: { left: 50, width: 900 }) as DOMRect;
		});
		mount();
		fireEvent.click(screen.getAllByTitle("Queued work")[0]);
		const dialog = bubble() as HTMLElement;
		expect(dialog.getAttribute("aria-label")).toBe("Queued work");
		// Anchored at the character's centre, measured from the strip: 200 - 50 + 24.
		expect((dialog.firstElementChild as HTMLElement).style.paddingLeft).toBe(`${174 - 16}px`);
		expect(screen.getByText("Waiting for an available agent")).toBeTruthy();
	});
});

describe("PixelOffice queue characters", () => {
	it("bob between two frames and stop when the queue empties", () => {
		vi.useFakeTimers();
		room({ tasks: [task({ status: "backlog" })] });
		const view = mount();
		const mini = view.container.querySelector("canvas") as HTMLCanvasElement;
		const frames = () =>
			contextOf(mini).calls.filter((c) => c.name === "drawImage").map((c) => c.args);
		const [first] = frames()[0];
		act(() => vi.advanceTimersByTime(700));
		expect(frames()[1][0]).not.toBe(first);
		act(() => vi.advanceTimersByTime(700));
		expect(frames()[2][0]).toBe(first);
		expect(frames()[0].slice(1)).toEqual([0, 0, 16, 24]);
		view.unmount();
		act(() => vi.advanceTimersByTime(2100));
		expect(frames()).toHaveLength(3);
	});

	it("still names a queued task without a 2D context", () => {
		removeCanvasContext();
		room({ tasks: [task({ status: "backlog", title: "Queued work" })] });
		mount();
		expect(screen.getByText("Queued work")).toBeTruthy();
	});
});

describe("PixelOffice toolbar and keyboard", () => {
	const zoom = () => usePixelOfficeStore.getState().settings.zoom;

	it("zooms between 1x and 6x, from the buttons and the keyboard", () => {
		room({ terminals: [terminal({})] });
		mount();
		expect(screen.getByText("3x")).toBeTruthy();
		press("+");
		press("=");
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		press("+");
		expect(zoom()).toBe(6);
		expect(screen.getByRole("button", { name: "Zoom in" })).toHaveProperty("disabled", true);
		for (let i = 0; i < 6; i++) press("-");
		fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
		expect(zoom()).toBe(1);
		expect(screen.getByRole("button", { name: "Zoom out" })).toHaveProperty("disabled", true);
	});

	it("toggles the grid and the sound, from the buttons and the keyboard", () => {
		room({ terminals: [terminal({})] });
		mount();
		const grid = screen.getByRole("button", { name: "Toggle grid" });
		press("g");
		expect(grid.getAttribute("aria-pressed")).toBe("true");
		press("G");
		fireEvent.click(grid);
		expect(grid.getAttribute("aria-pressed")).toBe("true");

		press("m");
		expect(screen.getByRole("button", { name: "Mute notifications" }).getAttribute("aria-pressed")).toBe("true");
		press("M");
		fireEvent.click(screen.getByRole("button", { name: "Unmute notifications" }));
		expect(usePixelOfficeStore.getState().settings.soundEnabled).toBe(true);
	});

	it("moves the selection with the arrows and opens the bubble under the toolbar", () => {
		room({ terminals: [terminal({ id: "a", title: "First" }), terminal({ id: "b", title: "Second" })] });
		mount();
		expect(press("ArrowRight")).toBe(false);
		expect(bubble()?.getAttribute("aria-label")).toBe("First");
		expect(((bubble() as HTMLElement).firstElementChild as HTMLElement).style.paddingLeft).toBe(`${400 - 16}px`);
		press("ArrowRight");
		expect(bubble()?.getAttribute("aria-label")).toBe("Second");
		press("ArrowLeft");
		expect(bubble()?.getAttribute("aria-label")).toBe("First");
	});

	it("opens nothing with the arrows when nobody is seated", () => {
		room({ tasks: [task({ status: "backlog" })] });
		mount();
		press("ArrowRight");
		expect(bubble()).toBeNull();
	});

	it("leaves keys typed into a field, with a modifier, or unbound alone", () => {
		room({ terminals: [terminal({})] });
		mount();
		clickAgent("term-1");
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "+" });
		const area = document.createElement("textarea");
		const editable = document.createElement("div");
		Object.defineProperty(editable, "isContentEditable", { value: true });
		document.body.append(area, editable);
		fireEvent.keyDown(area, { key: "+" });
		fireEvent.keyDown(editable, { key: "+" });
		press("+", { ctrlKey: true });
		press("-", { metaKey: true });
		press("g", { altKey: true });
		expect(zoom()).toBe(3);
		expect(press("x")).toBe(true);
		area.remove();
		editable.remove();
	});

	it("chimes on the office's signals only while the sound is on", () => {
		room({ terminals: [terminal({ isClaudeMode: true, status: "running" })] });
		mount();
		act(() => useTerminalStore.setState({ terminals: [terminal({ isClaudeMode: true, status: "claude-active" })] }));
		expect(sounds.playChime).not.toHaveBeenCalled();

		act(() => usePixelOfficeStore.getState().updateSettings({ soundEnabled: true }));
		act(() => useTerminalStore.setState({ terminals: [terminal({ status: "running" })] }));
		act(() => useTerminalStore.setState({ terminals: [terminal({ isClaudeMode: true, status: "claude-active" })] }));
		expect(sounds.playChime).toHaveBeenCalledWith("needs-input");

		act(() => usePixelOfficeStore.getState().updateSettings({ soundEnabled: false }));
		expect(sounds.closeChimes).toHaveBeenCalledOnce();
		act(() => useTerminalStore.setState({ terminals: [terminal({ status: "running" })] }));
		act(() => useTerminalStore.setState({ terminals: [terminal({ isClaudeMode: true, status: "claude-active" })] }));
		expect(sounds.playChime).toHaveBeenCalledOnce();
	});
});
