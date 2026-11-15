/**
 * Kanban column preferences: width, collapse, lock and WIP limit per column,
 * the column order, and where they live (localStorage as a cache, the main
 * process as the source of truth, an answer for a project left meanwhile
 * thrown away).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../../shared/constants/task";
import {
	DEFAULT_COLUMN_WIDTH,
	LEGACY_DEFAULT_COLUMN_WIDTH,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	useKanbanSettingsStore,
} from "../kanban-settings-store";

const api = {
	saveKanbanPreferences: vi.fn(),
	saveKanbanBoardState: vi.fn(),
	getKanbanBoardState: vi.fn(),
	getKanbanPreferences: vi.fn(),
};

const store = () => useKanbanSettingsStore.getState();
const INITIAL = useKanbanSettingsStore.getState();
const COLUMNS = [...TASK_STATUS_COLUMNS];
const reversed = [...COLUMNS].reverse();

function prefs(width = DEFAULT_COLUMN_WIDTH, extra: Record<string, unknown> = {}) {
	return Object.fromEntries(
		COLUMNS.map((c) => [c, { width, isCollapsed: false, isLocked: false, ...extra }]),
	);
}

/** Let the two async reads started by loadPreferences settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.saveKanbanBoardState.mockResolvedValue({ success: true });
	api.getKanbanBoardState.mockResolvedValue({ success: false });
	api.getKanbanPreferences.mockResolvedValue({ success: false });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useKanbanSettingsStore.setState(INITIAL, true);
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("column preferences", () => {
	beforeEach(() => store().initializePreferences());

	it("starts every column open, unlocked and at the default width", () => {
		expect(store().getColumnPreferences("done")).toEqual({
			width: DEFAULT_COLUMN_WIDTH,
			isCollapsed: false,
			isLocked: false,
		});
		store().setColumnWidth("done", 400);
		store().initializePreferences();
		expect(store().getColumnPreferences("done").width).toBe(400);
	});

	it("clamps widths and leaves a locked column alone", () => {
		store().setColumnWidth("backlog", 10);
		expect(store().getColumnPreferences("backlog").width).toBe(MIN_COLUMN_WIDTH);
		store().setColumnWidth("backlog", 5000);
		expect(store().getColumnPreferences("backlog").width).toBe(MAX_COLUMN_WIDTH);
		store().toggleColumnLocked("backlog");
		store().setColumnWidth("backlog", 300);
		expect(store().getColumnPreferences("backlog").width).toBe(MAX_COLUMN_WIDTH);
		store().setColumnLocked("backlog", false);
		store().setColumnWidth("backlog", 300);
		expect(store().getColumnPreferences("backlog").width).toBe(300);
	});

	it("collapses and expands a column", () => {
		store().toggleColumnCollapsed("queue");
		expect(store().getColumnPreferences("queue").isCollapsed).toBe(true);
		store().setColumnCollapsed("queue", false);
		expect(store().getColumnPreferences("queue").isCollapsed).toBe(false);
	});

	it("keeps a WIP limit as a whole number, and clears a meaningless one", () => {
		store().setColumnWipLimit("in_progress", 3.7);
		expect(store().getColumnPreferences("in_progress").wipLimit).toBe(3);
		for (const cleared of [0, -2, Number.NaN, undefined]) {
			store().setColumnWipLimit("in_progress", 3);
			store().setColumnWipLimit("in_progress", cleared);
			expect(store().getColumnPreferences("in_progress").wipLimit).toBeUndefined();
		}
	});

	it("ignores every change before the preferences exist", () => {
		useKanbanSettingsStore.setState({ columnPreferences: null });
		store().setColumnWidth("done", 300);
		store().toggleColumnCollapsed("done");
		store().setColumnCollapsed("done", true);
		store().toggleColumnLocked("done");
		store().setColumnLocked("done", true);
		store().setColumnWipLimit("done", 2);
		expect(store().columnPreferences).toBeNull();
		expect(store().getColumnPreferences("done").width).toBe(DEFAULT_COLUMN_WIDTH);
		expect(store().savePreferences("p1")).toBe(false);
	});
});

describe("column order", () => {
	it("saves the order locally and in the main process", () => {
		store().setColumnOrder(reversed, "p1");
		expect(store().columnOrder).toEqual(reversed);
		expect(JSON.parse(localStorage.getItem("kanban-column-order-p1") ?? "null")).toEqual(reversed);
		expect(api.saveKanbanBoardState).toHaveBeenCalledWith("p1", { columnOrder: reversed });
	});

	it("only changes the state without a project", () => {
		store().setColumnOrder(reversed);
		expect(store().columnOrder).toEqual(reversed);
		expect(api.saveKanbanBoardState).not.toHaveBeenCalled();
	});

	it("keeps the order when persisting it fails", async () => {
		api.saveKanbanBoardState.mockRejectedValue(new Error("ipc"));
		store().setColumnOrder(reversed, "p1");
		await settle();
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		const storage = localStorage as unknown as { _setShouldThrow: (v: boolean, e: Error | null) => void };
		storage._setShouldThrow(true, new Error("quota"));
		try {
			store().setColumnOrder(COLUMNS, "p1");
		} finally {
			storage._setShouldThrow(false, null);
		}
		expect(store().columnOrder).toEqual(COLUMNS);
	});
});

describe("loading and saving", () => {
	it("starts from the local cache, moving legacy widths to the new default", () => {
		localStorage.setItem("kanban-column-prefs-p1", JSON.stringify(prefs(LEGACY_DEFAULT_COLUMN_WIDTH)));
		localStorage.setItem("kanban-column-order-p1", JSON.stringify(reversed));
		store().loadPreferences("p1");
		expect(store().getColumnPreferences("done").width).toBe(DEFAULT_COLUMN_WIDTH);
		expect(store().columnOrder).toEqual(reversed);
	});

	it("falls back to defaults for an invalid, unreadable or missing cache", () => {
		const invalid = [
			"[]",
			JSON.stringify({ ...prefs(), done: null }),
			JSON.stringify(prefs(10)),
			JSON.stringify(prefs(DEFAULT_COLUMN_WIDTH, { isLocked: "no" })),
			JSON.stringify(prefs(DEFAULT_COLUMN_WIDTH, { wipLimit: 0 })),
			"{oops",
		];
		for (const cached of invalid) {
			useKanbanSettingsStore.setState({ columnPreferences: null });
			localStorage.setItem("kanban-column-prefs-p1", cached);
			localStorage.setItem("kanban-column-order-p1", cached);
			store().loadPreferences("p1");
			expect(store().getColumnPreferences("backlog").width).toBe(DEFAULT_COLUMN_WIDTH);
			expect(store().columnOrder).toEqual(COLUMNS);
		}
		localStorage.clear();
		store().loadPreferences("p2");
		expect(store().columnOrder).toEqual(COLUMNS);
	});

	it("keeps a valid WIP limit from the cache", () => {
		localStorage.setItem("kanban-column-prefs-p1", JSON.stringify(prefs(300, { wipLimit: 2 })));
		store().loadPreferences("p1");
		expect(store().getColumnPreferences("queue")).toMatchObject({ width: 300, wipLimit: 2 });
	});

	it("then takes the main process's order and preferences and caches them", async () => {
		api.getKanbanBoardState.mockResolvedValue({ success: true, data: { columnOrder: reversed } });
		api.getKanbanPreferences.mockResolvedValue({ success: true, data: prefs(LEGACY_DEFAULT_COLUMN_WIDTH) });
		store().loadPreferences("p1");
		await settle();
		expect(store().columnOrder).toEqual(reversed);
		expect(store().getColumnPreferences("done").width).toBe(DEFAULT_COLUMN_WIDTH);
		expect(JSON.parse(localStorage.getItem("kanban-column-order-p1") ?? "null")).toEqual(reversed);
		expect(JSON.parse(localStorage.getItem("kanban-column-prefs-p1") ?? "{}").done.width).toBe(
			DEFAULT_COLUMN_WIDTH,
		);
	});

	it("keeps the cache when the main process has nothing valid or fails", async () => {
		localStorage.setItem("kanban-column-prefs-p1", JSON.stringify(prefs(350)));
		api.getKanbanBoardState.mockResolvedValue({ success: true, data: { columnOrder: "x" } });
		api.getKanbanPreferences.mockResolvedValue({ success: true, data: prefs(1) });
		store().loadPreferences("p1");
		await settle();
		expect(store().getColumnPreferences("done").width).toBe(350);
		expect(store().columnOrder).toEqual(COLUMNS);

		api.getKanbanBoardState.mockRejectedValue(new Error("x"));
		api.getKanbanPreferences.mockRejectedValue(new Error("x"));
		store().loadPreferences("p1");
		await settle();
		expect(store().getColumnPreferences("done").width).toBe(350);
	});

	it("still shows the board when the cache cannot be written", async () => {
		api.getKanbanBoardState.mockResolvedValue({ success: true, data: { columnOrder: reversed } });
		api.getKanbanPreferences.mockResolvedValue({ success: true, data: prefs(400) });
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		store().loadPreferences("p1");
		await settle();
		vi.restoreAllMocks();
		expect(store().columnOrder).toEqual(reversed);
		expect(store().getColumnPreferences("done").width).toBe(400);
	});

	it("throws away answers for a project the person already left", async () => {
		let answerOrder: (v: unknown) => void = () => undefined;
		let answerPrefs: (v: unknown) => void = () => undefined;
		api.getKanbanBoardState.mockReturnValueOnce(new Promise((r) => (answerOrder = r)));
		api.getKanbanPreferences.mockReturnValueOnce(new Promise((r) => (answerPrefs = r)));
		store().loadPreferences("p1");
		store().loadPreferences("p2");
		answerOrder({ success: true, data: { columnOrder: reversed } });
		answerPrefs({ success: true, data: prefs(500) });
		await settle();
		expect(store().columnOrder).toEqual(COLUMNS);
		expect(store().getColumnPreferences("done").width).toBe(DEFAULT_COLUMN_WIDTH);
	});

	it("saves locally at once and to the main process once the edits stop", async () => {
		vi.useFakeTimers();
		store().initializePreferences();
		store().setColumnWidth("done", 300);
		expect(store().savePreferences("p1")).toBe(true);
		store().setColumnWidth("done", 320);
		store().savePreferences("p1");
		expect(JSON.parse(localStorage.getItem("kanban-column-prefs-p1") ?? "{}").done.width).toBe(320);
		await vi.advanceTimersByTimeAsync(100);
		expect(api.saveKanbanPreferences).toHaveBeenCalledTimes(1);
		expect(api.saveKanbanPreferences.mock.calls[0][1].done.width).toBe(320);

		api.saveKanbanPreferences.mockRejectedValue(new Error("ipc"));
		store().savePreferences("p1");
		await vi.advanceTimersByTimeAsync(100);
		expect(api.saveKanbanPreferences).toHaveBeenCalledTimes(2);
	});

	it("drops a pending save when another project loads", async () => {
		vi.useFakeTimers();
		store().initializePreferences();
		store().savePreferences("p1");
		store().loadPreferences("p2");
		await vi.advanceTimersByTimeAsync(200);
		expect(api.saveKanbanPreferences).not.toHaveBeenCalled();
	});

	it("reports a local save that fails", () => {
		store().initializePreferences();
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		expect(store().savePreferences("p1")).toBe(false);
		vi.restoreAllMocks();
	});

	it("resets to the defaults everywhere", async () => {
		vi.useFakeTimers();
		store().initializePreferences();
		store().setColumnWidth("done", 500);
		store().setColumnOrder(reversed, "p1");
		store().savePreferences("p1");
		store().resetPreferences("p1");
		expect(store().getColumnPreferences("done").width).toBe(DEFAULT_COLUMN_WIDTH);
		expect(store().columnOrder).toEqual(COLUMNS);
		expect(localStorage.getItem("kanban-column-prefs-p1")).toBeNull();
		expect(localStorage.getItem("kanban-column-order-p1")).toBeNull();
		await vi.advanceTimersByTimeAsync(100);
		expect(api.saveKanbanPreferences.mock.calls.at(-1)?.[1].done.width).toBe(DEFAULT_COLUMN_WIDTH);

		vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
			throw new Error("x");
		});
		store().setColumnWidth("done", 500);
		store().resetPreferences("p1");
		expect(store().getColumnPreferences("done").width).toBe(500);
		vi.restoreAllMocks();
	});
});
