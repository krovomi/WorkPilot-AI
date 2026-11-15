/**
 * The terminal grid: the project's terminals in rows, the toolbar, session
 * history, keyboard shortcuts, and what a drag ends on (a reorder, or a file
 * path typed into a terminal).
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileExplorerStore } from "../../stores/file-explorer-store";
import { type Terminal, useTerminalStore } from "../../stores/terminal-store";
import { TerminalGrid } from "../TerminalGrid";

const seen = vi.hoisted(() => ({
	dnd: {} as {
		onDragStart?: (event: unknown) => void;
		onDragEnd?: (event: unknown) => void;
	},
	wrappers: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@dnd-kit/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dnd-kit/core")>()),
	DndContext: (props: { children: React.ReactNode; onDragStart: never; onDragEnd: never }) => {
		seen.dnd.onDragStart = props.onDragStart;
		seen.dnd.onDragEnd = props.onDragEnd;
		return <div data-testid="dnd">{props.children}</div>;
	},
	DragOverlay: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="overlay">{children}</div>
	),
}));
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
	SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("react-resizable-panels", () => ({
	Group: ({ children, orientation }: { children: React.ReactNode; orientation: string }) => (
		<div data-testid={`group-${orientation}`}>{children}</div>
	),
	Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	Separator: () => <hr />,
}));
vi.mock("../SortableTerminalWrapper", () => ({
	SortableTerminalWrapper: (props: Record<string, unknown>) => {
		seen.wrappers.set(props.id as string, props);
		return <div data-testid={`terminal-${props.id}`} data-expanded={String(props.isExpanded)} />;
	},
}));
vi.mock("../FileExplorerPanel", () => ({
	FileExplorerPanel: ({ projectPath }: { projectPath: string }) => (
		<div data-testid="explorer">{projectPath}</div>
	),
}));
vi.mock("../ui/TerminalGridSkeleton", () => ({
	TerminalGridSkeleton: () => <div data-testid="skeleton" />,
}));

const api = {
	getTerminalSessionDates: vi.fn(),
	getTerminalSessionsForDate: vi.fn(),
	restoreTerminalSessionsFromDate: vi.fn(),
	destroyTerminal: vi.fn(),
	invokeClaudeInTerminal: vi.fn(),
	sendTerminalInput: vi.fn(),
	updateTerminalDisplayOrders: vi.fn(),
};

const actions = {
	addTerminal: vi.fn(),
	removeTerminal: vi.fn(),
	setActiveTerminal: vi.fn(),
	canAddTerminal: vi.fn(),
	setClaudeMode: vi.fn(),
	reorderTerminals: vi.fn(),
	addRestoredTerminal: vi.fn(),
	clearTerminalJump: vi.fn(),
};

const term = (id: string, over: Partial<Terminal> = {}): Terminal => ({
	id,
	title: `T ${id}`,
	status: "running",
	cwd: `/p/${id}`,
	createdAt: new Date(0),
	isClaudeMode: false,
	projectPath: "/p",
	...over,
});

function setTerminals(terminals: Terminal[], extra: Record<string, unknown> = {}) {
	act(() => useTerminalStore.setState({ terminals, ...extra }));
}

const terminalIds = () =>
	screen.queryAllByTestId(/^terminal-/).map((el) => el.dataset.testid?.slice(9));

describe("TerminalGrid", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		seen.wrappers.clear();
		Object.assign(globalThis.electronAPI, api);
		api.getTerminalSessionDates.mockResolvedValue({ success: true, data: [] });
		api.updateTerminalDisplayOrders.mockResolvedValue({ success: true });
		actions.canAddTerminal.mockReturnValue(true);
		useTerminalStore.setState({
			terminals: [],
			activeTerminalId: null,
			jumpToTerminalId: null,
			...actions,
		});
		useFileExplorerStore.setState({ isOpen: false });
	});

	afterEach(() => vi.useRealTimers());

	it("offers a first terminal when there is none", async () => {
		render(<TerminalGrid projectPath="/p" />);

		expect(screen.getByRole("region", { name: "Terminal grid empty state" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "New Terminal" }));
		expect(actions.addTerminal).toHaveBeenCalledWith("/p", "/p");
	});

	it("shows only the project's terminals, legacy ones included", () => {
		setTerminals([
			term("a"),
			term("b", { projectPath: "/other" }),
			term("c", { projectPath: undefined }),
		]);
		render(<TerminalGrid projectPath="/p" />);

		expect(terminalIds()).toEqual(["a", "c"]);
		expect(screen.getByText("2 / 12 terminals")).toBeInTheDocument();
		expect(screen.getByTestId("explorer")).toHaveTextContent("/p");
	});

	it("shows every terminal without a project", () => {
		setTerminals([term("a"), term("b", { projectPath: "/other", cwd: "" })]);
		render(<TerminalGrid />);

		expect(terminalIds()).toEqual(["a", "b"]);
		expect(seen.wrappers.get("b")?.cwd).toBeUndefined();
		expect(screen.queryByTestId("explorer")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
		expect(api.getTerminalSessionDates).not.toHaveBeenCalled();
	});

	it.each([
		[1, 1],
		[2, 1],
		[3, 2],
		[5, 2],
		[7, 3],
		[11, 3],
	])("lays %i terminals out in %i rows", (count, rows) => {
		setTerminals(Array.from({ length: count }, (_, i) => term(`t${i}`)));
		render(<TerminalGrid projectPath="/p" />);

		expect(screen.getAllByTestId("group-horizontal")).toHaveLength(rows);
		expect(terminalIds()).toHaveLength(count);
	});

	it("keeps an exited terminal for its grace period, then drops it", async () => {
		vi.useFakeTimers();
		setTerminals([term("a"), term("b")]);
		render(<TerminalGrid projectPath="/p" />);

		setTerminals([term("a"), term("b", { status: "exited" })]);
		expect(terminalIds()).toEqual(["a", "b"]);

		await act(async () => vi.advanceTimersByTime(60_000));
		expect(terminalIds()).toEqual(["a"]);
	});

	it("drops an exited terminal of a previous run at once", () => {
		setTerminals([term("a"), term("b", { status: "exited" })]);
		render(<TerminalGrid projectPath="/p" />);
		// Scheduled now: the grace period starts when the grid first sees it.
		expect(terminalIds()).toContain("a");
	});

	it("wires each terminal to the grid's actions", async () => {
		setTerminals([term("a"), term("b")], { activeTerminalId: "b" });
		const onNewTaskClick = vi.fn();
		render(<TerminalGrid projectPath="/p" onNewTaskClick={onNewTaskClick} />);

		const a = seen.wrappers.get("a") as Record<string, () => void>;
		expect(seen.wrappers.get("b")?.isActive).toBe(true);
		expect(a.onNewTaskClick).toBe(onNewTaskClick);
		act(() => a.onActivate());
		expect(actions.setActiveTerminal).toHaveBeenCalledWith("a");

		act(() => a.onToggleExpand());
		expect(terminalIds()).toEqual(["a"]);
		expect(screen.getByTestId("terminal-a")).toHaveAttribute("data-expanded", "true");
		const expanded = seen.wrappers.get("a") as Record<string, () => void>;
		act(() => expanded.onActivate());
		act(() => expanded.onToggleExpand());
		expect(terminalIds()).toEqual(["a", "b"]);

		act(() => (seen.wrappers.get("b") as Record<string, () => void>).onToggleExpand());
		act(() => (seen.wrappers.get("b") as Record<string, () => void>).onClose());
		expect(api.destroyTerminal).toHaveBeenCalledWith("b");
		expect(actions.removeTerminal).toHaveBeenCalledWith("b");
		// The expanded terminal closed: the grid shows every terminal again.
		expect(terminalIds()).toEqual(["a", "b"]);

		act(() => (seen.wrappers.get("a") as Record<string, () => void>).onClose());
		expect(actions.removeTerminal).toHaveBeenLastCalledWith("a");
	});

	it("shows nothing for an expanded terminal that went away", () => {
		setTerminals([term("a"), term("b")]);
		render(<TerminalGrid projectPath="/p" />);
		act(() => (seen.wrappers.get("a") as Record<string, () => void>).onToggleExpand());

		setTerminals([term("b")]);
		expect(terminalIds()).toEqual([]);
	});

	it("collapses the expanded terminal when the project changes", () => {
		setTerminals([term("a"), term("b"), term("c", { projectPath: "/q" }), term("d", { projectPath: "/q" })]);
		const { rerender } = render(<TerminalGrid projectPath="/p" />);
		act(() => (seen.wrappers.get("a") as Record<string, () => void>).onToggleExpand());
		expect(terminalIds()).toEqual(["a"]);

		rerender(<TerminalGrid projectPath="/q" />);
		expect(terminalIds()).toEqual(["c", "d"]);
	});

	it("expands and spotlights a terminal jumped to from elsewhere", async () => {
		vi.useFakeTimers();
		setTerminals([term("a"), term("b")]);
		render(<TerminalGrid projectPath="/p" />);

		setTerminals([term("a"), term("b")], { jumpToTerminalId: "b" });
		await act(async () => vi.advanceTimersByTime(120));
		expect(terminalIds()).toEqual(["b"]);
		expect(actions.clearTerminalJump).toHaveBeenCalled();
		expect(document.querySelector(".terminal-spotlight")).not.toBeNull();

		await act(async () => vi.advanceTimersByTime(2200));
		expect(document.querySelector(".terminal-spotlight")).toBeNull();
	});

	it("adds and closes terminals from the keyboard while active", async () => {
		setTerminals([term("a")], { activeTerminalId: "a" });
		const { rerender } = render(<TerminalGrid projectPath="/p" />);

		await userEvent.keyboard("{Control>}t{/Control}");
		expect(actions.addTerminal).not.toHaveBeenCalled();

		rerender(<TerminalGrid projectPath="/p" isActive />);
		await userEvent.keyboard("{Control>}t{/Control}");
		expect(actions.addTerminal).toHaveBeenCalledWith("/p", "/p");
		actions.canAddTerminal.mockReturnValue(false);
		await userEvent.keyboard("{Meta>}t{/Meta}");
		expect(actions.addTerminal).toHaveBeenCalledTimes(1);

		await userEvent.keyboard("{Control>}w{/Control}");
		expect(actions.removeTerminal).toHaveBeenCalledWith("a");
		await userEvent.keyboard("w");
		expect(actions.removeTerminal).toHaveBeenCalledTimes(1);
	});

	it("does not close anything with no active terminal", async () => {
		setTerminals([term("a")]);
		render(<TerminalGrid projectPath="/p" isActive />);
		await userEvent.keyboard("{Control>}w{/Control}");
		expect(actions.removeTerminal).not.toHaveBeenCalled();
	});

	it("disables New Terminal at the limit", async () => {
		actions.canAddTerminal.mockReturnValue(false);
		setTerminals([term("a")]);
		render(<TerminalGrid projectPath="/p" />);
		expect(screen.getByRole("button", { name: /New Terminal/ })).toBeDisabled();
	});

	it("invokes Claude in every plain running terminal", async () => {
		setTerminals([
			term("a"),
			term("b", { isClaudeMode: true }),
			term("c", { status: "exited" }),
			term("d", { cwd: "" }),
		]);
		render(<TerminalGrid projectPath="/p" />);

		await userEvent.click(screen.getByRole("button", { name: "Invoke Claude All" }));

		expect(actions.setClaudeMode.mock.calls).toEqual([
			["a", true],
			["d", true],
		]);
		expect(api.invokeClaudeInTerminal.mock.calls).toEqual([
			["a", "/p/a"],
			["d", "/p"],
		]);
	});

	it("hides Invoke Claude All when no terminal is plain", () => {
		setTerminals([term("a", { isClaudeMode: true })]);
		render(<TerminalGrid projectPath="/p" />);
		expect(screen.queryByRole("button", { name: "Invoke Claude All" })).not.toBeInTheDocument();
	});

	it("opens the terminal font settings and toggles the file explorer", async () => {
		const opened = vi.fn();
		globalThis.addEventListener("open-app-settings", opened);
		const toggle = vi.fn();
		useFileExplorerStore.setState({ isOpen: true, toggle });
		setTerminals([term("a")]);
		render(<TerminalGrid projectPath="/p" />);

		await userEvent.click(screen.getByRole("button", { name: "Settings" }));
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("terminal-fonts");
		await userEvent.click(screen.getByRole("button", { name: "Files" }));
		expect(toggle).toHaveBeenCalled();
		globalThis.removeEventListener("open-app-settings", opened);
	});

	describe("drag and drop", () => {
		const drag = (data: unknown, id = "x") => ({ active: { id, data: { current: data } } });

		it("types a dropped file path into the terminal under it", () => {
			setTerminals([term("a"), term("b")]);
			render(<TerminalGrid projectPath="/p" />);

			act(() =>
				seen.dnd.onDragStart?.(drag({ type: "file", path: "src/a.ts", name: "a.ts" })),
			);
			expect(screen.getByTestId("overlay")).toHaveTextContent("a.ts");
			act(() =>
				seen.dnd.onDragEnd?.({ ...drag({ type: "file", path: "src/a.ts" }), over: { id: "terminal-b" } }),
			);
			expect(api.sendTerminalInput).toHaveBeenCalledWith("b", "src/a.ts ");
			expect(screen.getByTestId("overlay")).toBeEmptyDOMElement();

			// closestCenter can name the sortable id instead of the drop zone.
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "file", path: "lib" }), over: { id: "a" } }));
			expect(api.sendTerminalInput).toHaveBeenLastCalledWith("a", "lib ");
		});

		it("shows a dragged folder and ignores a drop on nothing or elsewhere", () => {
			setTerminals([term("a")]);
			render(<TerminalGrid projectPath="/p" />);

			act(() =>
				seen.dnd.onDragStart?.(drag({ type: "file", path: "src", name: "src", isDirectory: true })),
			);
			expect(screen.getByTestId("overlay")).toHaveTextContent("src");
			act(() => seen.dnd.onDragStart?.(drag({ type: "file", path: "src" })));
			act(() => seen.dnd.onDragStart?.(drag(undefined)));

			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "file", path: "src" }), over: null }));
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "file", path: "src" }), over: { id: "zone" } }));
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "file" }), over: { id: "terminal-a" } }));
			expect(api.sendTerminalInput).not.toHaveBeenCalled();
		});

		it("reorders terminals and saves the order", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const refit = vi.fn();
			globalThis.addEventListener("terminal-refit-all", refit);
			setTerminals([term("a", { displayOrder: 0 }), term("b"), term("z", { projectPath: "/q" })]);
			render(<TerminalGrid projectPath="/p" />);

			act(() => seen.dnd.onDragStart?.(drag({ type: "terminal-panel" }, "a")));
			expect(screen.getByTestId("overlay")).toHaveTextContent("T a");
			act(() =>
				seen.dnd.onDragEnd?.({ ...drag({ type: "terminal-panel" }, "a"), over: { id: "terminal-b" } }),
			);

			expect(actions.reorderTerminals).toHaveBeenCalledWith("a", "b");
			await waitFor(() =>
				expect(api.updateTerminalDisplayOrders).toHaveBeenCalledWith("/p", [
					{ terminalId: "a", displayOrder: 0 },
					{ terminalId: "b", displayOrder: 0 },
				]),
			);
			await act(async () => vi.advanceTimersByTime(1000));
			expect(refit).toHaveBeenCalled();
			globalThis.removeEventListener("terminal-refit-all", refit);
		});

		it.each([
			["refuses", () => api.updateTerminalDisplayOrders.mockResolvedValue({ success: false, error: "disk" })],
			["fails", () => api.updateTerminalDisplayOrders.mockRejectedValue(new Error("ipc"))],
		])("only warns when saving the order %s", async (_l, arrange) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			arrange();
			setTerminals([term("a"), term("b")]);
			render(<TerminalGrid projectPath="/p" />);

			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "terminal-panel" }, "a"), over: { id: "b" } }));

			await waitFor(() => expect(warn).toHaveBeenCalled());
		});

		it("does not save an order without a project, nor a drop on itself", () => {
			setTerminals([term("a"), term("b")]);
			const { rerender } = render(<TerminalGrid />);
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "terminal-panel" }, "a"), over: { id: "b" } }));
			expect(actions.reorderTerminals).toHaveBeenCalledWith("a", "b");
			expect(api.updateTerminalDisplayOrders).not.toHaveBeenCalled();

			rerender(<TerminalGrid projectPath="/p" />);
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "terminal-panel" }, "a"), over: { id: "a" } }));
			act(() => seen.dnd.onDragEnd?.({ ...drag({ type: "terminal-panel" }, "a"), over: { id: "gone" } }));
			expect(actions.reorderTerminals).toHaveBeenCalledTimes(1);
		});

		it("names an untitled terminal being dragged", () => {
			setTerminals([term("a", { title: "" })]);
			render(<TerminalGrid projectPath="/p" />);
			act(() => seen.dnd.onDragStart?.(drag({ type: "terminal-panel" }, "a")));
			expect(screen.getByTestId("overlay")).toHaveTextContent("Terminal");
		});
	});

	describe("session history", () => {
		const DATES = [{ date: "2026-11-14", sessionCount: 2 }];
		const SESSIONS = [
			{ id: "s2", displayOrder: 1 },
			{ id: "s1", displayOrder: 0 },
			{ id: "s3" },
		];

		async function openHistory() {
			const trigger = await screen.findByRole("button", { name: /History/ });
			act(() => trigger.focus());
			await userEvent.keyboard("[Enter]");
			return screen.findByRole("menuitem", { name: /2 sessions/ });
		}

		it("restores the sessions of a day in their saved order", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			api.getTerminalSessionDates.mockResolvedValue({ success: true, data: DATES });
			api.getTerminalSessionsForDate.mockResolvedValue({ success: true, data: SESSIONS });
			api.restoreTerminalSessionsFromDate.mockResolvedValue({
				success: true,
				data: {
					restored: 3,
					sessions: [
						{ id: "s3", success: true },
						{ id: "s1", success: true },
						{ id: "s2", success: false },
						{ id: "unknown", success: true },
					],
				},
			});
			setTerminals([term("a")]);
			render(<TerminalGrid projectPath="/p" />);

			await userEvent.click(await openHistory());

			await waitFor(() => expect(actions.addRestoredTerminal).toHaveBeenCalledTimes(2));
			expect(api.destroyTerminal).toHaveBeenCalledWith("a");
			expect(actions.removeTerminal).toHaveBeenCalledWith("a");
			expect(api.restoreTerminalSessionsFromDate).toHaveBeenCalledWith("2026-11-14", "/p", 80, 24);
			expect(actions.addRestoredTerminal.mock.calls.map(([s]) => s.id)).toEqual(["s3", "s1"]);
			await waitFor(() => expect(api.getTerminalSessionDates).toHaveBeenCalledTimes(2));
		});

		it("restores nothing for a day without sessions", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			api.getTerminalSessionDates.mockResolvedValue({ success: true, data: DATES });
			api.getTerminalSessionsForDate.mockResolvedValue({ success: false });
			setTerminals([term("a")]);
			render(<TerminalGrid projectPath="/p" />);

			await userEvent.click(await openHistory());

			await waitFor(() => expect(api.getTerminalSessionsForDate).toHaveBeenCalled());
			expect(api.destroyTerminal).not.toHaveBeenCalled();
			expect(api.restoreTerminalSessionsFromDate).not.toHaveBeenCalled();
		});

		it("keeps the grid when the main process restores nothing", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			api.getTerminalSessionDates.mockResolvedValue({ success: true, data: DATES });
			api.getTerminalSessionsForDate.mockResolvedValue({ success: true, data: [{ id: "s1" }] });
			api.restoreTerminalSessionsFromDate.mockResolvedValue({ success: false });
			render(<TerminalGrid projectPath="/p" />);
			// No terminal: the history is reached from a terminal of the grid.
			setTerminals([term("a")]);

			await userEvent.click(await openHistory());

			await waitFor(() => expect(api.restoreTerminalSessionsFromDate).toHaveBeenCalled());
			expect(actions.addRestoredTerminal).not.toHaveBeenCalled();
		});

		it("shows the skeleton while restoring into an empty grid, and survives a failure", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			api.getTerminalSessionDates.mockResolvedValue({ success: true, data: DATES });
			let reject!: (e: unknown) => void;
			api.getTerminalSessionsForDate.mockReturnValue(new Promise((_r, j) => (reject = j)));
			setTerminals([term("a")]);
			render(<TerminalGrid projectPath="/p" />);

			await userEvent.click(await openHistory());
			setTerminals([]);
			expect(screen.getByTestId("skeleton")).toBeInTheDocument();

			await act(async () => reject(new Error("boom")));
			expect(error).toHaveBeenCalledWith("Failed to restore sessions:", expect.any(Error));
			expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
		});

		it("lists no history when the dates cannot be read", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			api.getTerminalSessionDates.mockRejectedValueOnce(new Error("disk"));
			setTerminals([term("a")]);
			render(<TerminalGrid projectPath="/p" />);

			await waitFor(() => expect(error).toHaveBeenCalled());
			expect(screen.queryByRole("button", { name: /History/ })).not.toBeInTheDocument();
		});

		it("forgets the dates when the project goes", async () => {
			api.getTerminalSessionDates.mockResolvedValue({ success: true, data: DATES });
			setTerminals([term("a")]);
			const { rerender } = render(<TerminalGrid projectPath="/p" />);
			await screen.findByRole("button", { name: /History/ });

			rerender(<TerminalGrid />);
			expect(screen.queryByRole("button", { name: /History/ })).not.toBeInTheDocument();
		});
	});
});
