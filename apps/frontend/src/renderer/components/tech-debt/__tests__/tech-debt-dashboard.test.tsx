/** @vitest-environment jsdom */
/**
 * The tech debt dashboard: the saved items of the selected project on
 * arrival, a scan on the button, filters, the trend and the heatmap, and a
 * debt item turned into a Kanban task of the project it was read for.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DebtItem,
	DebtListResult,
	DebtTrendPoint,
} from "../../../../preload/api/modules/tech-debt-api";
import i18n from "../../../../shared/i18n";
import type { Project } from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { useTechDebtStore } from "../../../stores/tech-debt-store";
import { DebtHeatmap } from "../DebtHeatmap";
import { DebtItemsTable } from "../DebtItemsTable";
import { DebtTrendChart } from "../DebtTrendChart";
import { TechDebtDashboard } from "../TechDebtDashboard";

const item = (id: string, over: Partial<DebtItem> = {}): DebtItem => ({
	id,
	kind: "todo_fixme",
	file_path: `src/${id}.ts`,
	line: 7,
	message: `fix ${id}`,
	cost: 4,
	effort: 2,
	roi: 2,
	tags: [],
	context: "",
	...over,
});

const point = (total: number): DebtTrendPoint => ({
	timestamp: 1,
	total_items: total,
	total_cost: 1,
	avg_roi: 1,
});

const listing = (items: DebtItem[], trend: DebtTrendPoint[] = [point(items.length)]): DebtListResult => ({
	items,
	trend,
	summary: { total: items.length, by_kind: {}, total_cost: 12.5, total_effort: 6, avg_roi: 2.1 },
});

/** A promise the test resolves by hand. */
function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const api = {
	scanTechDebt: vi.fn(),
	listDebtItems: vi.fn(),
	createTask: vi.fn(),
};

const PROJECTS = [
	{ id: "proj-a", path: "/a" },
	{ id: "proj-b", path: "/b" },
] as Project[];

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	api.listDebtItems.mockResolvedValue({ result: listing([]) });
	await i18n.changeLanguage("en");
	useTechDebtStore.getState().clear();
	useProjectStore.setState({ projects: PROJECTS, activeProjectId: null });
});

afterEach(cleanup);

const scanButton = () => screen.getByRole("button", { name: "Scan now" });
const itemsColumn = () => screen.getByRole("heading", { name: /^Top \d+ items$/ }).closest("section") as HTMLElement;

describe("TechDebtDashboard", () => {
	it("shows the saved items of the selected project on arrival, without scanning", async () => {
		api.listDebtItems.mockResolvedValueOnce({ result: listing([item("one", { roi: 3.5 })]) });
		render(<TechDebtDashboard projectPath="/a" />);

		expect(await screen.findByText("fix one")).toBeInTheDocument();
		expect(api.listDebtItems).toHaveBeenCalledWith({ projectPath: "/a", minScore: 0 });
		expect(api.scanTechDebt).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Project path")).toHaveValue("/a");
		expect(screen.getByRole("heading", { name: "Top 1 items" })).toBeInTheDocument();
		expect(screen.getByText("12.5")).toBeInTheDocument();
		expect(screen.getByText("2.1")).toBeInTheDocument();
		expect(screen.getByText("src/one.ts:7")).toBeInTheDocument();
		expect(screen.getByText(/ROI 3\.50/)).toBeInTheDocument();
		expect(screen.queryByText(/Last scanned/)).not.toBeInTheDocument();
	});

	it("does not read again a project whose items are already shown", async () => {
		const { unmount } = render(<TechDebtDashboard projectPath="/a" />);
		await waitFor(() => expect(api.listDebtItems).toHaveBeenCalledTimes(1));
		unmount();
		render(<TechDebtDashboard projectPath="/a" />);
		expect(screen.getByLabelText("Project path")).toHaveValue("/a");
		expect(api.listDebtItems).toHaveBeenCalledTimes(1);
	});

	it("without a project, explains itself and scans only a typed path", async () => {
		const scan = deferred();
		api.scanTechDebt.mockReturnValueOnce(scan.promise);
		render(<TechDebtDashboard />);

		expect(api.listDebtItems).not.toHaveBeenCalled();
		expect(screen.getByText("ROI-scored view of technical debt across the project.")).toBeInTheDocument();
		expect(scanButton()).toBeDisabled();
		fireEvent.click(scanButton());
		fireEvent.change(screen.getByLabelText("Project path"), { target: { value: "   " } });
		expect(scanButton()).toBeDisabled();

		fireEvent.change(screen.getByLabelText("Project path"), { target: { value: "  /typed  " } });
		fireEvent.click(scanButton());
		expect(api.scanTechDebt).toHaveBeenCalledWith({ projectPath: "/typed" });
		expect(scanButton()).toBeDisabled();
		expect(scanButton()).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("status")).toHaveTextContent("Scan now");
		expect(screen.queryByText("ROI-scored view of technical debt across the project.")).not.toBeInTheDocument();
		// While the scan runs with nothing to show yet, the list says it is empty.
		expect(within(itemsColumn()).getByText("No debt items match the current filters.")).toBeInTheDocument();

		await act(async () => {
			scan.resolve({ result: { ...listing([item("new")]), project_path: "/typed", scanned_at: 1_800_000_000 } });
		});
		expect(screen.getByText("fix new")).toBeInTheDocument();
		expect(screen.getByText(/^Last scanned: /)).toBeInTheDocument();
		expect(scanButton()).toBeEnabled();
	});

	it("shows the scan's failure", async () => {
		api.scanTechDebt.mockRejectedValueOnce(new Error("runner crashed"));
		render(<TechDebtDashboard />);
		fireEvent.change(screen.getByLabelText("Project path"), { target: { value: "/x" } });
		fireEvent.click(scanButton());
		expect(await screen.findByRole("alert")).toHaveTextContent("runner crashed");
	});

	it("follows the selected project: its path, its items, and nothing of the previous one", async () => {
		api.listDebtItems
			.mockResolvedValueOnce({ result: listing([item("from-a")]) })
			.mockResolvedValueOnce({ result: listing([item("from-b")]) });
		api.createTask.mockResolvedValueOnce({ success: true, data: { id: "t1", title: "Tech debt: a" } });
		const { rerender } = render(<TechDebtDashboard projectPath="/a" />);
		fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
		expect(await screen.findByText("Task created: Tech debt: a")).toBeInTheDocument();

		rerender(<TechDebtDashboard projectPath="/b" />);
		expect(screen.getByLabelText("Project path")).toHaveValue("/b");
		expect(screen.queryByText("Task created: Tech debt: a")).not.toBeInTheDocument();
		expect(await screen.findByText("fix from-b")).toBeInTheDocument();
		expect(screen.queryByText("fix from-a")).not.toBeInTheDocument();

		rerender(<TechDebtDashboard />);
		expect(screen.getByLabelText("Project path")).toHaveValue("");
	});

	it("filters by minimum ROI and by file, message or tag, and lists the ten best first", async () => {
		const many = Array.from({ length: 12 }, (_, i) => item(`i${i}`, { roi: i }));
		many.push(item("tagged", { roi: 0.5, tags: ["Security"], message: "plain" }));
		api.listDebtItems.mockResolvedValueOnce({ result: listing(many) });
		render(<TechDebtDashboard projectPath="/a" />);
		await screen.findByText("fix i11");

		const messages = () =>
			within(itemsColumn())
				.queryAllByText(/^(fix i\d+|plain)$/)
				.map((n) => n.textContent);
		expect(messages()).toEqual(["fix i11", "fix i10", "fix i9", "fix i8", "fix i7", "fix i6", "fix i5", "fix i4", "fix i3", "fix i2"]);

		fireEvent.change(screen.getByLabelText("Min ROI"), { target: { value: "10" } });
		expect(messages()).toEqual(["fix i11", "fix i10"]);
		fireEvent.change(screen.getByLabelText("Min ROI"), { target: { value: "" } });
		expect(screen.getByLabelText("Min ROI")).toHaveValue(0);

		fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "  security " } });
		expect(messages()).toEqual(["plain"]);
		fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "SRC/I3.TS" } });
		expect(messages()).toEqual(["fix i3"]);
		fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "fix i1" } });
		expect(messages()).toEqual(["fix i11", "fix i10", "fix i1"]);

		fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "nothing like it" } });
		expect(within(itemsColumn()).getByText("No debt items match the current filters.")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Top 0 items" })).toBeInTheDocument();
	});

	it("creates the task in the project the items were read for, then opens it in the Kanban", async () => {
		api.listDebtItems.mockResolvedValueOnce({ result: listing([item("one"), item("two")]) });
		const created = deferred();
		api.createTask.mockReturnValueOnce(created.promise);
		const navigate = vi.fn();
		globalThis.addEventListener("workpilot:navigate-view", navigate);
		render(<TechDebtDashboard projectPath="/b" />);
		await screen.findByText("fix one");
		// A path typed since does not change where the task goes.
		fireEvent.change(screen.getByLabelText("Project path"), { target: { value: "/a" } });

		fireEvent.click(screen.getAllByRole("button", { name: "Create task" })[0]);
		expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled();
		expect(api.createTask).toHaveBeenCalledWith(
			"proj-b",
			expect.any(String),
			expect.stringContaining("`src/one.ts:7`"),
			expect.objectContaining({ sourceType: "tech-debt" }),
		);

		await act(async () => created.resolve({ success: true, data: { id: "t9", title: "Tech debt: fix one" } }));
		expect(screen.getAllByRole("button", { name: "Create task" })).toHaveLength(2);
		for (const b of screen.getAllByRole("button", { name: "Create task" })) expect(b).toBeEnabled();

		fireEvent.click(screen.getByRole("button", { name: /Task created: Tech debt: fix one/ }));
		expect(navigate).toHaveBeenCalledTimes(1);
		expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: "kanban", taskId: "t9" });
		globalThis.removeEventListener("workpilot:navigate-view", navigate);
	});

	it("writes the task in French when the app is in French", async () => {
		await i18n.changeLanguage("fr");
		api.listDebtItems.mockResolvedValueOnce({ result: listing([item("one", { context: "  // TODO  " })]) });
		api.createTask.mockResolvedValueOnce({ success: true, data: { id: "t", title: "x" } });
		render(<TechDebtDashboard projectPath="/a" />);
		fireEvent.click(await screen.findByRole("button", { name: "Créer une tâche" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		expect(api.createTask.mock.calls[0][2]).toContain("Emplacement");
		expect(api.createTask.mock.calls[0][2]).toContain("### Contexte\n\n```\n// TODO\n```");
	});

	it("falls back to the active project, and says so when there is none", async () => {
		api.listDebtItems.mockResolvedValue({ result: listing([item("one")]) });
		api.createTask.mockResolvedValue({ success: false, error: "disk full" });
		useProjectStore.setState({ activeProjectId: "proj-active" });
		const { unmount } = render(<TechDebtDashboard projectPath="/unregistered" />);
		fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalledWith("proj-active", expect.anything(), expect.anything(), expect.anything()));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not create the task from this debt item");
		expect(screen.queryByText(/Task created/)).not.toBeInTheDocument();
		unmount();

		useTechDebtStore.getState().clear();
		useProjectStore.setState({ activeProjectId: null });
		render(<TechDebtDashboard projectPath="/unregistered" />);
		fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("No project selected");
		expect(api.createTask).toHaveBeenCalledTimes(1);
	});
});

describe("DebtTrendChart", () => {
	it("asks for a scan when there is no trend yet", () => {
		render(<DebtTrendChart trend={[]} />);
		expect(screen.getByText(/No trend data yet/)).toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("draws one scan as a flat line across the chart", () => {
		render(<DebtTrendChart trend={[point(4)]} />);
		const line = screen.getByRole("img", { name: "Total debt items over time" }).querySelector("polyline");
		expect(line?.getAttribute("points")).toBe("0,5 400,5");
		expect(screen.getByText("start: 4")).toBeInTheDocument();
		expect(screen.getByText("now: 4 (+0)")).toBeInTheDocument();
	});

	it("spreads the scans across the width and says how the total moved", () => {
		const { rerender } = render(<DebtTrendChart trend={[point(10), point(5), point(0)]} />);
		const points = () => screen.getByRole("img").querySelector("polyline")?.getAttribute("points");
		expect(points()).toBe("0,5 200,60 400,115");
		expect(screen.getByText("now: 0 (-10)")).toBeInTheDocument();

		rerender(<DebtTrendChart trend={[point(0), point(0)]} />);
		expect(points()).toBe("0,115 400,115");
		expect(screen.getByText("now: 0 (+0)")).toBeInTheDocument();
	});
});

describe("DebtHeatmap", () => {
	it("says so when nothing matches", () => {
		render(<DebtHeatmap items={[]} />);
		expect(screen.getByText("No debt items match the current filters.")).toBeInTheDocument();
	});

	it("sums the ROI per file, worst first, at most twenty files, with a visible bar for the smallest", () => {
		const items = [
			item("a", { file_path: "big.ts", roi: 60 }),
			item("b", { file_path: "big.ts", roi: 40 }),
			item("c", { file_path: "tiny.ts", roi: 1 }),
			...Array.from({ length: 20 }, (_, i) => item(`f${i}`, { file_path: `mid${i}.ts`, roi: 2 + i })),
		];
		const { container } = render(<DebtHeatmap items={items} />);
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(20);
		expect(rows[0]).toHaveTextContent("big.ts100.0");
		expect(screen.queryByText("tiny.ts")).not.toBeInTheDocument();
		const widths = Array.from(container.querySelectorAll(".wp-bar i")).map((i) => (i as HTMLElement).style.width);
		expect(widths[0]).toBe("100%");
		expect(widths.at(-1)).toBe("4%");
	});
});

describe("DebtItemsTable", () => {
	it("lets every item create a task when none is being created", () => {
		const onCreateTask = vi.fn();
		render(<DebtItemsTable items={[item("one", { kind: "low_coverage" })]} onCreateTask={onCreateTask} />);
		expect(screen.getByText("Low coverage")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Create task" }));
		expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));
	});
});
