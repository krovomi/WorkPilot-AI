/**
 * KanbanToolbar — search, the filter and sort panel, saved views, and what the
 * toolbar offers on a local board versus a server board. Rendered with the
 * real filter store, so each test reads the filters the board would apply.
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import i18n from "../../../shared/i18n";
import type { Project } from "../../../shared/types";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { DEFAULT_LANE_PREFERENCES, useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { useMultiRepoStore } from "../../stores/multi-repo-store";
import { useCollaborationStore } from "../../stores/collaboration-store";
import { useProjectStore } from "../../stores/project-store";
import { useShortcutsHelpStore } from "../../stores/shortcuts-help-store";
import { useTaskStore } from "../../stores/task-store";
import { TooltipProvider } from "../ui/tooltip";
import { KanbanToolbar } from "./KanbanToolbar";

vi.mock("../../lib/local-backend", () => ({
	localBackendFetch: vi.fn(async () => ({ ok: false, json: async () => null })),
}));

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "p1",
		name: "Shop",
		path: "/repo",
		autoBuildPath: "",
		settings: {} as Project["settings"],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Project;
}

function renderToolbar() {
	return render(
		<TooltipProvider>
			<KanbanToolbar projectPath="/repo" />
		</TooltipProvider>,
	);
}

const filters = () => useKanbanFilterStore.getState().filters;
const sort = () => useKanbanFilterStore.getState().sort;

async function openFilters() {
	await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
	return screen.getByRole("dialog");
}

let api: RendererApi;

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
	localStorage.clear();
	api = installRendererApi();
	useProjectStore.setState({
		projects: [project()],
		selectedProjectId: "p1",
		activeProjectId: "p1",
	});
	useKanbanLanesStore.setState({ ...DEFAULT_LANE_PREFERENCES, projectId: null });
	useKanbanFilterStore.setState({ projectId: null });
	useKanbanFilterStore.getState().loadForProject("p1");
});

afterEach(() => {
	api.restore();
});

describe("search", () => {
	it("filters as you type and clears in one click", async () => {
		renderToolbar();
		await userEvent.type(screen.getByRole("textbox", { name: "Search tasks…" }), "login");
		expect(filters().search).toBe("login");
		await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(filters().search).toBe("");
		expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
	});
});

describe("split group", () => {
	it("shows the group shown alone and returns to every task on click", async () => {
		useKanbanFilterStore.getState().toggleGroup("auth-split");
		renderToolbar();
		const chip = screen.getByRole("button", { name: /Group auth-split/ });
		expect(chip).toHaveAttribute("title", "Show every task");
		await userEvent.click(chip);
		expect(filters().group).toBeFalsy();
	});
});

describe("filter panel", () => {
	it("toggles priority, category and source chips and counts them", async () => {
		renderToolbar();
		const panel = await openFilters();
		await userEvent.click(within(panel).getByRole("button", { name: "Urgent" }));
		await userEvent.click(within(panel).getByRole("button", { name: "Bug Fix" }));
		await userEvent.click(within(panel).getByRole("button", { name: "Jira" }));

		expect(filters().priorities).toEqual(["urgent"]);
		expect(filters().categories).toEqual(["bug_fix"]);
		expect(filters().sources).toEqual(["jira"]);
		expect(within(panel).getByRole("button", { name: "Urgent" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: /^Filter/ })).toHaveTextContent("3");

		await userEvent.click(within(panel).getByRole("button", { name: "Reset" }));
		expect(filters().priorities).toEqual([]);
		expect(within(panel).queryByRole("button", { name: "Reset" })).toBeNull();
	});

	it("offers the quick filters, and the labels the board uses", async () => {
		renderToolbar();
		let panel = await openFilters();
		expect(within(panel).queryByText("Labels")).toBeNull();
		await userEvent.click(within(panel).getByRole("button", { name: "Blocked" }));
		await userEvent.click(within(panel).getByRole("button", { name: "Changed this week" }));
		expect(filters().quick).toEqual(["flagged", "recent"]);
		await userEvent.keyboard("{Escape}");

		useTaskStore.setState({ tasks: [{ id: "a", metadata: { labels: ["api", "Front"] } }] as never });
		panel = await openFilters();
		await userEvent.click(within(panel).getByRole("button", { name: "Front" }));
		expect(filters().labels).toEqual(["Front"]);
		expect(within(panel).getByRole("button", { name: "Front" })).toHaveAttribute("aria-pressed", "true");
		expect(within(panel).getByRole("button", { name: "api" })).toHaveAttribute("aria-pressed", "false");
		useTaskStore.setState({ tasks: [] });
	});

	it("names priorities and categories in the app language", async () => {
		await i18n.changeLanguage("fr");
		try {
			renderToolbar();
			await userEvent.click(screen.getByRole("button", { name: /^Filtr/ }));
			const panel = screen.getByRole("dialog");
			expect(within(panel).getByRole("button", { name: "Urgente" })).toBeInTheDocument();
			expect(
				within(panel).getByRole("button", { name: "Correction de bug" }),
			).toBeInTheDocument();
			expect(within(panel).getByRole("button", { name: "Tests" })).toBeInTheDocument();
		} finally {
			await i18n.changeLanguage("en");
		}
	});

	it("sorts by a field and flips the direction, none for manual order", async () => {
		renderToolbar();
		const panel = await openFilters();
		expect(within(panel).queryByTitle(/Ascending|Descending/)).toBeNull();

		await userEvent.click(within(panel).getByRole("button", { name: "Title" }));
		expect(sort().field).toBe("title");
		const before = sort().direction;
		const flip = within(panel).getByTitle(before === "asc" ? "Ascending" : "Descending");
		await userEvent.click(flip);
		expect(sort().direction).not.toBe(before);
		expect(
			within(panel).getByTitle(before === "asc" ? "Descending" : "Ascending"),
		).toBeInTheDocument();
	});
});

describe("saved views", () => {
	async function openViews() {
		await userEvent.click(screen.getByRole("button", { name: /^Views/ }));
		return screen.getByRole("dialog");
	}

	it("saves the current filters under a name, applies and deletes them", async () => {
		renderToolbar();
		let panel = await openViews();
		expect(within(panel).getByText(/No saved views yet/)).toBeInTheDocument();
		const save = within(panel).getByRole("button", { name: "Save current view" });
		expect(save).toBeDisabled();

		useKanbanFilterStore.getState().togglePriority("high");
		await userEvent.type(
			within(panel).getByRole("textbox", { name: "Save current view" }),
			"Hot{Enter}",
		);
		expect(useKanbanFilterStore.getState().savedViews).toHaveLength(1);
		expect(screen.getByRole("button", { name: /^Views/ })).toHaveTextContent("1");

		useKanbanFilterStore.getState().clearFilters();
		await userEvent.click(within(panel).getByRole("button", { name: /^Hot/ }));
		expect(filters().priorities).toEqual(["high"]);

		await userEvent.click(within(panel).getByRole("button", { name: "Delete view" }));
		expect(useKanbanFilterStore.getState().savedViews).toHaveLength(0);

		await userEvent.type(
			within(panel).getByRole("textbox", { name: "Save current view" }),
			"Second",
		);
		panel = screen.getByRole("dialog");
		await userEvent.click(within(panel).getByRole("button", { name: "Save current view" }));
		expect(useKanbanFilterStore.getState().savedViews.map((v) => v.name)).toEqual([
			"Second",
		]);
	});

	it("shows how a view lays out the board", async () => {
		useKanbanLanesStore.getState().loadForProject("p1");
		useKanbanLanesStore.getState().setLayout("list");
		useKanbanLanesStore.getState().setGrouping("priority");
		useKanbanFilterStore.getState().saveCurrentView("Plan");
		useKanbanLanesStore.getState().setLayout("board");
		useKanbanLanesStore.getState().setGrouping("none");
		useKanbanFilterStore.getState().saveCurrentView("Plain");
		useKanbanFilterStore.setState({
			savedViews: [...useKanbanFilterStore.getState().savedViews, { ...useKanbanFilterStore.getState().savedViews[1], id: "old", name: "Old", layout: undefined }],
		});
		renderToolbar();
		const panel = await openViews();
		expect(within(panel).getByRole("button", { name: /^Plan/ })).toHaveTextContent("List · lanes by Priority");
		expect(within(panel).getByRole("button", { name: /^Plain/ })).toHaveTextContent(/^PlainBoard$/);
		expect(within(panel).getByRole("button", { name: /^Old/ })).toHaveTextContent(/^Old$/);
		await userEvent.click(within(panel).getByRole("button", { name: /^Plan/ }));
		expect(useKanbanLanesStore.getState()).toMatchObject({ layout: "list", grouping: "priority" });
	});

	it("a blank name saves nothing", async () => {
		renderToolbar();
		const panel = await openViews();
		await userEvent.type(
			within(panel).getByRole("textbox", { name: "Save current view" }),
			"   {Enter}",
		);
		expect(useKanbanFilterStore.getState().savedViews).toHaveLength(0);
	});
});

describe("local and server boards", () => {
	it("a local board offers the quick command bar", () => {
		renderToolbar();
		expect(
			screen.getByRole("textbox", { name: /Quick command/ }),
		).toBeInTheDocument();
	});

	it("a local board can be asked a question about its tickets", () => {
		renderToolbar();
		expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
	});

	it("a server board shows its notice instead of the local tools", () => {
		useProjectStore.setState({
			projects: [project({ remote: { serverUrl: "https://srv", projectId: "r1" } } as never)],
		});
		renderToolbar();
		expect(screen.queryByRole("textbox", { name: /Quick command/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "More board actions" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
	});

	it("a server board offers « My tasks » once its team room says who I am", async () => {
		useProjectStore.setState({
			projects: [project({ remote: { serverUrl: "https://srv", projectId: "r1" } } as never)],
		});
		const { unmount } = renderToolbar();
		let panel = await openFilters();
		expect(within(panel).queryByRole("button", { name: "My tasks" })).toBeNull();
		unmount();
		renderToolbar();
		// The team room answers after the toolbar joined it.
		act(() => useCollaborationStore.setState({ me: { id: "u1", name: "Ana" } as never }));
		panel = await openFilters();
		await userEvent.click(within(panel).getByRole("button", { name: "My tasks" }));
		expect(filters().quick).toEqual(["mine"]);
		useCollaborationStore.setState({ me: null });
	});

	it("a local board keeps its occasional actions in the more menu", async () => {
		renderToolbar();
		expect(screen.queryByRole("button", { name: /Multi-repo/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "More board actions" }));
		const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
		expect(items).toEqual([
			expect.stringContaining("Multi-repo"),
			expect.stringContaining("Purge"),
		]);
	});

	it("the more menu opens the multi-repo dialog for the board's project", async () => {
		useMultiRepoStore.setState({ isDialogOpen: false });
		renderToolbar();
		await userEvent.click(screen.getByRole("button", { name: "More board actions" }));
		await userEvent.click(screen.getByRole("menuitem", { name: /Multi-repo/ }));
		expect(useMultiRepoStore.getState()).toMatchObject({ isDialogOpen: true, projectId: "p1" });
		useMultiRepoStore.setState({ isDialogOpen: false });
	});

	it("the more menu opens the purge, which lists the board's worktrees and closes", async () => {
		renderToolbar();
		await userEvent.click(screen.getByRole("button", { name: "More board actions" }));
		await userEvent.click(screen.getByRole("menuitem", { name: /Purge/ }));
		expect(await screen.findByRole("dialog", { name: "Purge finished worktrees" })).toBeInTheDocument();
		expect(api.fn("listPurgeableWorktrees")).toHaveBeenCalledWith("p1");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Purge finished worktrees" })).toBeNull();
	});
});

describe("layout", () => {
	it("switches between the board's columns and the list", async () => {
		useKanbanLanesStore.getState().loadForProject("p1");
		renderToolbar();
		const board = screen.getByRole("button", { name: "Board" });
		const listButton = screen.getByRole("button", { name: "List" });
		expect(board).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(listButton);
		expect(listButton).toHaveAttribute("aria-pressed", "true");
		expect(useKanbanLanesStore.getState().layout).toBe("list");
		await userEvent.click(board);
		expect(useKanbanLanesStore.getState().layout).toBe("board");
	});
});

describe("keyboard shortcuts", () => {
	it("opens the board's keyboard help", async () => {
		useShortcutsHelpStore.setState({ open: false });
		renderToolbar();
		await userEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
		expect(useShortcutsHelpStore.getState().open).toBe(true);
	});
});
