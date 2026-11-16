/**
 * Sidebar — the rail of spaces, the panel of the space chosen, pins, the
 * two-letter shortcuts, the resize handle and the git check of the project.
 * Rendered with the real stores; only the IPC bridge is a stand-in, so each
 * test reads the settings a click saves and the page it opens.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Project } from "../../../shared/types";
import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from "../../../shared/types/settings";
import { CliStatusProvider } from "../../contexts/CliStatusContext";
import { usePermissionsStore } from "../../stores/permissions-store";
import { useServerSessionStore } from "../../stores/server-session-store";
import { useCommandPaletteStore } from "../../stores/command-palette-store";
import { useProjectEnvStore } from "../../stores/project-env-store";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useSetupHubStore } from "../../stores/setup-hub-store";
import { useTestGenerationStore } from "../../stores/test-generation-store";
import { useViewUsageStore } from "../../stores/view-usage-store";
import { Sidebar } from "../Sidebar";
import { SIDEBAR_HUBS } from "../sidebar/hubs";
import {
	administrationNavGroup,
	githubNavItems,
	gitlabNavItems,
	navGroups,
} from "../sidebar/nav-model";
import { ESSENTIAL_VIEWS } from "../sidebar/spaces";

const voice: { props?: { onNavigate: (view: string) => void; destinations: { id: string }[] } } = {};
const cliChip: { props?: { onNavigateToTerminals: () => void } } = {};

vi.mock("../voice-assistant/VoiceAssistant", () => ({
	VoiceAssistant: (props: typeof voice.props) => {
		voice.props = props;
		return null;
	},
}));

vi.mock("../sidebar/CliToolsChip", () => ({
	CliToolsChip: (props: typeof cliChip.props) => {
		cliChip.props = props;
		return null;
	},
}));

type Collide = (args: unknown) => { id: string }[];
type DragEnd = (event: { active: { id: string }; over: { id: string } | null }) => void;
const dnd: { collide?: Collide; onDragEnd?: DragEnd; onDragStart?: (e: { active: { id: string } }) => void; onDragCancel?: () => void } = {};

vi.mock("@dnd-kit/core", async () => {
	const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
	return {
		...actual,
		// The overlay shows only while dnd-kit tracks a real pointer drag.
		DragOverlay: ({ children }: { children: ReactNode }) => <div data-testid="drag-overlay">{children}</div>,
		DndContext: (props: Parameters<typeof actual.DndContext>[0] & { children: ReactNode }) => {
			dnd.collide = props.collisionDetection as unknown as Collide;
			dnd.onDragEnd = props.onDragEnd as unknown as DragEnd;
			dnd.onDragStart = props.onDragStart as unknown as typeof dnd.onDragStart;
			dnd.onDragCancel = props.onDragCancel as unknown as typeof dnd.onDragCancel;
			return <actual.DndContext {...props} />;
		},
	};
});

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "p1",
		name: "Shop",
		path: "/repo",
		autoBuildPath: "/repo/.workpilot",
		settings: {} as Project["settings"],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Project;
}

function setPrefs(patch: Partial<SidebarPrefs>) {
	const settings = useSettingsStore.getState().settings;
	useSettingsStore.setState({
		settings: { ...settings, sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, ...patch } },
	});
}

const prefs = () => useSettingsStore.getState().settings.sidebarPrefs ?? DEFAULT_SIDEBAR_PREFS;
const settings = () => useSettingsStore.getState().settings;

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
	const handlers = {
		onSettingsClick: vi.fn(),
		onNewTaskClick: vi.fn(),
		onViewChange: vi.fn(),
		onInitializeProject: vi.fn(),
	};
	const utils = render(<Sidebar {...handlers} {...props} />, { wrapper: CliStatusProvider });
	return { ...utils, ...handlers };
}

const panel = () => screen.getByTestId("sidebar-panel");
const railButton = (name: string) =>
	screen.getAllByRole("button", { name }).find((b) => b.dataset.space !== undefined) as HTMLElement;

let api: RendererApi;

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		},
	);
});

beforeEach(() => {
	localStorage.clear();
	api = installRendererApi({
		checkGitStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { isGitRepo: true, hasCommits: true, currentBranch: "main" },
		}),
		getProjectEnv: vi.fn().mockResolvedValue({ success: true, data: {} }),
	});
	useProjectStore.setState({
		projects: [project()],
		selectedProjectId: "p1",
		activeProjectId: "p1",
	});
	useProjectEnvStore.setState({ envConfig: null });
	setPrefs({ menuMode: "full" } as Partial<SidebarPrefs>);
	useSettingsStore.setState({
		settings: { ...settings(), sidebarCollapsed: false, sidebarWidth: 296 },
	});
	useViewUsageStore.setState({ usage: {}, since: Date.now(), current: null });
	useCommandPaletteStore.setState({ open: false });
	useSetupHubStore.setState({ isOpen: false });
	useTestGenerationStore.setState({ isOpen: false });
});

afterEach(() => {
	api.restore();
	vi.useRealTimers();
});

describe("spaces", () => {
	it("shows the space of the page on screen and opens a page on click", async () => {
		const { onViewChange } = renderSidebar({ activeView: "kanban" });
		expect(within(panel()).getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
		const kanban = within(panel()).getByRole("button", { name: /Kanban board/ });
		expect(kanban).toHaveAttribute("aria-current", "page");
		await userEvent.click(within(panel()).getByRole("button", { name: /Dashboard/ }));
		expect(onViewChange).toHaveBeenCalledWith("dashboard");
	});

	it("choosing another space shows it and remembers it", async () => {
		renderSidebar();
		await userEvent.click(railButton("Development"));
		expect(within(panel()).getByRole("heading", { name: "Development" })).toBeInTheDocument();
		await waitFor(() => expect(prefs().activeSpace).toBe("development"));
	});

	it("choosing the space shown folds the panel, and a choice unfolds it", async () => {
		const { rerender, ...handlers } = renderSidebar({ activeView: "kanban" });
		await userEvent.click(railButton("Workspace"));
		await waitFor(() => expect(settings().sidebarCollapsed).toBe(true));
		expect(screen.queryByTestId("sidebar-panel")).toBeNull();
		rerender(<Sidebar {...handlers} />);
		await userEvent.click(railButton("Agents"));
		await waitFor(() => expect(settings().sidebarCollapsed).toBe(false));
	});

	it("a tool that is a dialog opens it instead of a page", async () => {
		const { onViewChange } = renderSidebar();
		await userEvent.click(railButton("Development"));
		await userEvent.click(within(panel()).getByRole("button", { name: /Test generation/ }));
		expect(useTestGenerationStore.getState().isOpen).toBe(true);
		expect(onViewChange).not.toHaveBeenCalled();
	});

	it("follows a page opened elsewhere into its space", () => {
		const { rerender, ...handlers } = renderSidebar({ activeView: "kanban" });
		rerender(<Sidebar {...handlers} activeView="terminals" />);
		expect(within(panel()).getByRole("heading", { name: "Agents" })).toBeInTheDocument();
	});

	it("without a project, pages cannot be opened", () => {
		useProjectStore.setState({ selectedProjectId: null, activeProjectId: null });
		renderSidebar();
		expect(within(panel()).getByRole("button", { name: /Kanban board/ })).toBeDisabled();
		expect(within(panel()).getByRole("button", { name: /New Task/ })).toBeDisabled();
	});
});

describe("my menu", () => {
	it("pins a page with its star and lists it under My menu", async () => {
		renderSidebar();
		const row = within(panel()).getByRole("button", { name: /Kanban board/ }).parentElement as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Pin to favorites" }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual(["kanban"]));
		// No space was chosen yet: My menu, now filled, is the one shown
		expect(within(panel()).getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
		expect(within(panel()).getByRole("button", { name: /Kanban board/ })).toBeInTheDocument();
	});

	it("an empty menu explains how to fill it", async () => {
		setPrefs({ menuMode: "full", activeSpace: "__mine__" } as Partial<SidebarPrefs>);
		renderSidebar();
		expect(within(panel()).getByText(/Pin a page with its star/)).toBeInTheDocument();
	});

	it("lists the pages opened lately", () => {
		useViewUsageStore.setState({
			usage: { terminals: { visits: 2, dwellMs: 1000, lastVisitedAt: Date.now() } },
		});
		setPrefs({ menuMode: "full", activeSpace: "__mine__" } as Partial<SidebarPrefs>);
		renderSidebar();
		expect(within(panel()).getByRole("heading", { name: "Recent" })).toBeInTheDocument();
		expect(within(panel()).getByRole("button", { name: /Agent terminals/ })).toBeInTheDocument();
	});

	it("resets a changed layout", async () => {
		setPrefs({ menuMode: "full", pinnedItems: ["kanban"] } as Partial<SidebarPrefs>);
		renderSidebar();
		await userEvent.click(within(panel()).getByRole("button", { name: "Reset layout" }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual([]));
	});

	it("hides and shows the beta views", async () => {
		renderSidebar();
		await userEvent.click(within(panel()).getByRole("button", { name: "Hide beta views" }));
		await waitFor(() => expect(prefs().hideExperimental).toBe(true));
		expect(within(panel()).getByRole("button", { name: /Show beta views/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});
});

describe("shortcuts", () => {
	it("two letters open their page", () => {
		const { onViewChange } = renderSidebar();
		fireEvent.keyDown(window, { key: "w" });
		fireEvent.keyDown(window, { key: "k" });
		expect(onViewChange).toHaveBeenCalledWith("kanban");
	});

	it("a slash opens the search", () => {
		renderSidebar();
		fireEvent.keyDown(window, { key: "/" });
		expect(useCommandPaletteStore.getState().open).toBe(true);
	});

	it("ignores typing in a field, modified keys and keys without a project", () => {
		const { onViewChange, unmount } = renderSidebar();
		const input = document.createElement("input");
		document.body.appendChild(input);
		fireEvent.keyDown(input, { key: "w" });
		fireEvent.keyDown(input, { key: "k" });
		fireEvent.keyDown(window, { key: "w", ctrlKey: true });
		fireEvent.keyDown(window, { key: "k", ctrlKey: true });
		fireEvent.keyDown(window, { key: "1" });
		input.remove();
		unmount();
		useProjectStore.setState({ selectedProjectId: null });
		renderSidebar({ onViewChange });
		fireEvent.keyDown(window, { key: "w" });
		fireEvent.keyDown(window, { key: "k" });
		expect(onViewChange).not.toHaveBeenCalled();
	});

	it("a second letter after the window starts over", () => {
		vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["Date"] });
		const { onViewChange } = renderSidebar();
		fireEvent.keyDown(window, { key: "w" });
		vi.setSystemTime(Date.now() + 2000);
		fireEvent.keyDown(window, { key: "k" });
		expect(onViewChange).not.toHaveBeenCalled();
		// An unknown pair starts over with its second letter as a prefix
		fireEvent.keyDown(window, { key: "w" });
		fireEvent.keyDown(window, { key: "p" });
		fireEvent.keyDown(window, { key: "o" });
		expect(onViewChange).toHaveBeenCalledWith("pixel-office");
	});
});

describe("rail footer and new task", () => {
	it("opens settings, the setup hub and help, and folds the sidebar", async () => {
		const open = vi.spyOn(globalThis, "open").mockImplementation(() => null);
		const { onSettingsClick } = renderSidebar();
		await userEvent.click(screen.getByRole("button", { name: "Application Settings" }));
		expect(onSettingsClick).toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Help & Feedback" }));
		expect(open).toHaveBeenCalledWith("https://github.com/krovomi/WorkPilot-AI/issues", "_blank");
		await userEvent.click(screen.getByRole("button", { name: "Collapse Sidebar" }));
		await waitFor(() => expect(settings().sidebarCollapsed).toBe(true));
		open.mockRestore();
	});

	it("the setup hub button opens the hub", async () => {
		renderSidebar();
		const compass = screen
			.getAllByRole("button")
			.find((b) => b.getAttribute("aria-label")?.match(/setup|configuration/i));
		await userEvent.click(compass as HTMLElement);
		expect(useSetupHubStore.getState().isOpen).toBe(true);
	});

	it("a folded sidebar keeps a new task button on the rail", async () => {
		useSettingsStore.setState({ settings: { ...settings(), sidebarCollapsed: true } });
		const { onNewTaskClick } = renderSidebar();
		await userEvent.click(screen.getByRole("button", { name: "New Task" }));
		expect(onNewTaskClick).toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Expand Sidebar" }));
		await waitFor(() => expect(settings().sidebarCollapsed).toBe(false));
	});

	it("a project to initialize offers its settings instead of a new task", async () => {
		useProjectStore.setState({ projects: [project({ autoBuildPath: "" })] });
		const { onInitializeProject } = renderSidebar();
		expect(within(panel()).getByRole("button", { name: /New Task/ })).toBeDisabled();
		await userEvent.click(
			within(panel()).getByRole("button", { name: "Initialize WorkPilot AI to create tasks" }),
		);
		expect(onInitializeProject).toHaveBeenCalledWith("p1");
	});
});

describe("resize", () => {
	it("drags the width within its bounds and saves it on release", async () => {
		// The widest menu leaves the main view its room: a wide window here.
		const innerWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
		renderSidebar();
		const handle = screen.getByRole("separator", { name: "Resize the menu" });
		expect(handle).toHaveAttribute("aria-controls", panel().id);
		fireEvent.pointerDown(handle, { button: 0, clientX: 296 });
		fireEvent.pointerMove(window, { clientX: 1000 });
		fireEvent.pointerUp(window);
		await waitFor(() => expect(settings().sidebarWidth).toBe(480));
		fireEvent.pointerDown(handle, { button: 0, clientX: 480 });
		fireEvent.pointerMove(window, { clientX: 400 });
		fireEvent.pointerUp(window);
		await waitFor(() => expect(settings().sidebarWidth).toBe(400));
		Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
	});

	it("folds the menu when its edge is dragged onto the rail", async () => {
		renderSidebar();
		const handle = screen.getByRole("separator", { name: "Resize the menu" });
		fireEvent.pointerDown(handle, { button: 0, clientX: 296 });
		fireEvent.pointerMove(window, { clientX: 40 });
		fireEvent.pointerUp(window);
		await waitFor(() => expect(settings().sidebarCollapsed).toBe(true));
		expect(screen.queryByTestId("sidebar-panel")).toBeNull();
		expect(settings().sidebarWidth).toBe(296);
	});
});

describe("drag and drop", () => {
	it("reorders groups and pages, and pins what is dropped on the star", async () => {
		renderSidebar();
		act(() => dnd.onDragStart?.({ active: { id: "group:agents" } }));
		act(() => dnd.onDragEnd?.({ active: { id: "group:agents" }, over: { id: "group:workspace" } }));
		await waitFor(() => expect(prefs().groupOrder.slice(0, 2)).toEqual(["agents", "workspace"]));

		act(() => dnd.onDragEnd?.({ active: { id: "item:dashboard" }, over: { id: "item:kanban" } }));
		await waitFor(() =>
			expect(prefs().itemOrder.workspace?.slice(0, 2)).toEqual(["dashboard", "kanban"]),
		);

		act(() => dnd.onDragEnd?.({ active: { id: "item:terminals" }, over: { id: "__fav_drop__" } }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual(["terminals"]));
		act(() => dnd.onDragEnd?.({ active: { id: "group:agents" }, over: { id: "__fav_drop__" } }));
		await waitFor(() => expect(prefs().pinnedGroups).toEqual(["agents"]));
	});

	it("ignores drops that mean nothing", async () => {
		renderSidebar();
		const before = JSON.stringify(prefs());
		act(() => {
			dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: null });
			dnd.onDragEnd?.({ active: { id: "nokind" }, over: { id: "item:kanban" } });
			dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "nokind" } });
			dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "item:kanban" } });
			dnd.onDragEnd?.({ active: { id: "group:agents" }, over: { id: "group:agents" } });
			dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "item:terminals" } });
			dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "group:workspace" } });
			dnd.onDragEnd?.({ active: { id: "pin:kanban" }, over: { id: "pin:terminals" } });
			dnd.onDragEnd?.({ active: { id: "pin:kanban" }, over: { id: "__fav_drop__" } });
			dnd.onDragEnd?.({ active: { id: "group:agents" }, over: { id: "item:kanban" } });
			dnd.onDragCancel?.();
		});
		await act(() => Promise.resolve());
		expect(JSON.stringify(prefs())).toBe(before);
	});
});

describe("a menu arranged by each person", () => {
	const shownPages = () =>
		within(panel())
			.getAllByRole("button")
			.map((button) => button.dataset.navItem)
			.filter((id): id is string => id !== undefined);

	it("a page dropped on a space of the rail moves to that space", async () => {
		renderSidebar({ activeView: "dashboard" });
		expect(shownPages()).toContain("kanban");
		act(() => dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "group:agents" } }));
		await waitFor(() => expect(prefs().itemGroups).toEqual({ kanban: "agents" }));
		expect(shownPages()).not.toContain("kanban");
		await userEvent.click(railButton("Agents"));
		expect(shownPages().at(-1)).toBe("kanban");
		// Back home: the move is forgotten, nothing else is kept for it.
		act(() => dnd.onDragEnd?.({ active: { id: "item:kanban" }, over: { id: "group:workspace" } }));
		await waitFor(() => expect(prefs().itemGroups).toEqual({}));
	});

	it("pins keep the order they are dragged to in « Mon menu »", async () => {
		setPrefs({ menuMode: "full", pinnedItems: ["kanban", "terminals", "insights"] } as Partial<SidebarPrefs>);
		// « Mon menu » is the space shown when it has pins.
		renderSidebar();
		act(() => dnd.onDragEnd?.({ active: { id: "pin:insights" }, over: { id: "pin:kanban" } }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual(["insights", "kanban", "terminals"]));
	});

	it("customizing moves pages with buttons, keeps pins, and restores the shipped order", async () => {
		setPrefs({ menuMode: "full", pinnedItems: ["terminals"] } as Partial<SidebarPrefs>);
		renderSidebar({ activeView: "kanban" });
		await userEvent.click(railButton("Workspace"));
		expect(screen.queryByTestId("customize-bar")).toBeNull();
		await userEvent.click(screen.getByTestId("customize-menu"));
		expect(screen.getByTestId("customize-bar")).toBeInTheDocument();
		const [first, second] = shownPages();
		expect(first).toBe("kanban");
		expect(screen.getByRole("button", { name: "Move Kanban board up" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Move Kanban board down" }));
		await waitFor(() => expect(shownPages().slice(0, 2)).toEqual([second, first]));

		await userEvent.click(screen.getByRole("button", { name: "Move Kanban board to another space" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Planning" }));
		await waitFor(() => expect(prefs().itemGroups).toEqual({ kanban: "planning" }));
		expect(shownPages()).not.toContain("kanban");

		await userEvent.click(screen.getByRole("button", { name: "Move the space Workspace down" }));
		await waitFor(() => expect(prefs().groupOrder.slice(0, 2)).toEqual(["agents", "workspace"]));
		await userEvent.click(screen.getByRole("button", { name: "Move the space Workspace up" }));
		await waitFor(() => expect(prefs().groupOrder.slice(0, 2)).toEqual(["workspace", "agents"]));
		await userEvent.click(screen.getByRole("button", { name: "Move the space Workspace down" }));
		await waitFor(() => expect(prefs().groupOrder.slice(0, 2)).toEqual(["agents", "workspace"]));

		await userEvent.click(screen.getByRole("button", { name: "Restore the original order" }));
		await waitFor(() => expect(prefs().itemGroups).toEqual({}));
		expect(prefs().groupOrder).toEqual([]);
		expect(prefs().itemOrder).toEqual({});
		expect(prefs().pinnedItems).toEqual(["terminals"]);
		expect(shownPages()[0]).toBe(first);
		expect(screen.getByRole("button", { name: "Restore the original order" })).toBeDisabled();

		await userEvent.click(within(screen.getByTestId("customize-bar")).getByRole("button", { name: "Done" }));
		expect(screen.queryByTestId("customize-bar")).toBeNull();
	});

	it("customizing « Mon menu » moves the user's own pins, not a pinned group's pages", async () => {
		setPrefs({ menuMode: "full", pinnedItems: ["kanban", "terminals"], pinnedGroups: ["planning"] } as Partial<SidebarPrefs>);
		// « Mon menu » is the space shown when it has pins.
		renderSidebar();
		await userEvent.click(screen.getByTestId("customize-menu"));
		expect(screen.queryByRole("button", { name: "Move Kanban board to another space" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Move Agent terminals up" }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual(["terminals", "kanban"]));
		expect(screen.getByRole("button", { name: "Move Agent terminals up" })).toBeDisabled();
		const rows = within(panel()).getAllByTestId("row-move-controls");
		expect(rows).toHaveLength(2);
	});

	it("tells a screen reader what a drag does, in the app's language", () => {
		renderSidebar();
		expect(document.body.textContent).toContain("To pick up a menu entry, press Space or Enter.");
	});
});

describe("project checks", () => {
	it("offers to set git up for a project without commits, once", async () => {
		api.fn("checkGitStatus").mockResolvedValue({
			success: true,
			data: { isGitRepo: true, hasCommits: false },
		});
		renderSidebar();
		const dialog = await screen.findByRole("dialog");
		expect(api.fn("checkGitStatus")).toHaveBeenCalledWith("/repo");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(dialog).not.toBeInTheDocument();
	});

	it("loads the project's integrations and shows its GitHub pages", async () => {
		api.fn("getProjectEnv").mockResolvedValue({ success: true, data: { githubEnabled: true } });
		renderSidebar();
		await waitFor(() => expect(api.fn("getProjectEnv")).toHaveBeenCalledWith("p1"));
		await userEvent.click(railButton("Git & Integrations"));
		expect(within(panel()).getAllByRole("button", { name: /GitHub/ }).length).toBeGreaterThan(0);
	});
});

describe("more of the menu", () => {
	it("every shortcut has two letters", () => {
		const shortcuts = [
			...navGroups.flatMap((g) => g.items),
			...githubNavItems,
			...gitlabNavItems,
			...administrationNavGroup.items,
			...SIDEBAR_HUBS.flatMap((hub) => hub.tabs),
		]
			.map((item) => item.shortcut)
			.filter((shortcut): shortcut is string => shortcut !== undefined);
		expect(shortcuts.length).toBeGreaterThan(50);
		expect(shortcuts.filter((s) => !/^[A-Z]{2}$/.test(s))).toEqual([]);
	});

	it("a letter that starts no shortcut does nothing", () => {
		const { onViewChange } = renderSidebar();
		fireEvent.keyDown(window, { key: "q" });
		fireEvent.keyDown(window, { key: "z" });
		expect(onViewChange).not.toHaveBeenCalled();
	});

	it("the first choice of menu pins the essential pages", async () => {
		setPrefs({});
		renderSidebar();
		await userEvent.click(within(panel()).getByRole("button", { name: /Essential/ }));
		await waitFor(() => expect(prefs().menuMode).toBe("essential"));
		expect(prefs().pinnedItems).toEqual([...ESSENTIAL_VIEWS]);
	});

	it("offers to hide the pages not opened for a month", async () => {
		useViewUsageStore.setState({ usage: {}, since: Date.now() - 40 * 24 * 60 * 60 * 1000 });
		renderSidebar();
		const offer = within(panel()).getByRole("region", { name: "Pages rarely used" });
		await userEvent.click(within(offer).getByRole("button", { name: "Later" }));
		await waitFor(() =>
			expect(prefs().hideSuggestionsSnoozedUntil ?? 0).toBeGreaterThan(Date.now()),
		);
		expect(within(panel()).queryByRole("region", { name: "Pages rarely used" })).toBeNull();
	});

	it("a hub's entry opens its first tab, and its star removes every tab's pin", async () => {
		setPrefs({ menuMode: "full", activeSpace: "workspace", pinnedItems: ["agent-replay"] } as Partial<SidebarPrefs>);
		const { onViewChange } = renderSidebar();
		const entry = within(panel()).getAllByRole("button", { name: /Agent history/ })[0];
		await userEvent.click(entry);
		expect(onViewChange).toHaveBeenCalledWith("session-history");
		const row = entry.parentElement as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Remove from favorites" }));
		await waitFor(() => expect(prefs().pinnedItems).toEqual([]));
	});

	it("my menu lists a pinned group's pages once, and skips a group gone", () => {
		setPrefs({
			menuMode: "full",
			pinnedGroups: ["gone", "workspace"],
			pinnedItems: ["kanban", "terminals", "gone-view"],
		} as Partial<SidebarPrefs>);
		renderSidebar();
		expect(within(panel()).getAllByRole("button", { name: /Kanban board/ })).toHaveLength(1);
		expect(within(panel()).getByRole("button", { name: /Agent terminals/ })).toBeInTheDocument();
	});

	it("a drop on the star of what is already pinned changes nothing", async () => {
		setPrefs({ menuMode: "full", pinnedItems: ["terminals"], pinnedGroups: ["agents"] } as Partial<SidebarPrefs>);
		renderSidebar();
		act(() => {
			dnd.onDragEnd?.({ active: { id: "item:terminals" }, over: { id: "__fav_drop__" } });
			dnd.onDragEnd?.({ active: { id: "group:agents" }, over: { id: "__fav_drop__" } });
		});
		await act(() => Promise.resolve());
		expect(prefs().pinnedItems).toEqual(["terminals"]);
		expect(prefs().pinnedGroups).toEqual(["agents"]);
	});

	it("names what is being dragged", () => {
		renderSidebar();
		const overlayText = (id: string) => {
			act(() => dnd.onDragStart?.({ active: { id } }));
			const text = screen.getByTestId("drag-overlay").textContent;
			act(() => dnd.onDragCancel?.());
			return text;
		};
		expect(overlayText("group:agents")).toBe("Agents");
		expect(overlayText("item:kanban")).toBe("Kanban board");
		expect(overlayText("group:gone")).toBe("");
		expect(overlayText("item:gone")).toBe("");
		expect(overlayText("nokind")).toBe("");
	});

	it("the pointer wins over the nearest row when it is over a target", () => {
		renderSidebar();
		const rect = { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 };
		const container = (id: string) => ({ id, rect: { current: rect }, data: { current: {} }, disabled: false, key: id, node: { current: null } });
		const args = (pointer: { x: number; y: number } | null) => ({
			active: { id: "item:kanban" },
			collisionRect: rect,
			droppableRects: new Map([["star", rect]]),
			droppableContainers: [container("star")],
			pointerCoordinates: pointer,
		});
		expect(dnd.collide?.(args({ x: 5, y: 5 })).map((c) => c.id)).toEqual(["star"]);
		expect(dnd.collide?.(args(null)).map((c) => c.id)).toEqual(["star"]);
	});

	it("staying in a space that lists the page does not move the panel", () => {
		const { rerender, ...handlers } = renderSidebar({ activeView: "kanban" });
		rerender(<Sidebar {...handlers} activeView="dashboard" />);
		expect(within(panel()).getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
	});

	it("the voice assistant and the CLI chip open pages through the sidebar", () => {
		const { onViewChange } = renderSidebar();
		expect(voice.props?.destinations.some((d) => d.id === "kanban")).toBe(true);
		act(() => voice.props?.onNavigate("kanban"));
		expect(onViewChange).toHaveBeenCalledWith("kanban");
		act(() => cliChip.props?.onNavigateToTerminals());
		expect(onViewChange).toHaveBeenCalledWith("terminals", true);
	});

	it("a folded sidebar previews a space's pages beside its icon", async () => {
		useSettingsStore.setState({ settings: { ...settings(), sidebarCollapsed: true } });
		const { onViewChange } = renderSidebar();
		await userEvent.hover(railButton("Agents"));
		await screen.findByRole("tooltip");
		const terminals = screen
			.getAllByRole("button", { name: /Agent terminals/ })
			.find((b) => b.closest("[data-radix-popper-content-wrapper]"));
		await userEvent.click(terminals as HTMLElement);
		expect(onViewChange).toHaveBeenCalledWith("terminals");
	});

	it("shows GitLab pages and, to an administrator, the console", async () => {
		api.fn("getProjectEnv").mockResolvedValue({ success: true, data: { gitlabEnabled: true } });
		useServerSessionStore.setState({ mode: "server" } as never);
		usePermissionsStore.setState({ unrestricted: true } as never);
		try {
			renderSidebar();
			await waitFor(() => expect(railButton("Administration")).toBeInTheDocument());
			await userEvent.click(railButton("Git & Integrations"));
			await waitFor(() =>
				expect(within(panel()).getByRole("button", { name: /GitLab MRs/ })).toBeInTheDocument(),
			);
		} finally {
			useServerSessionStore.setState({ mode: "local" } as never);
			usePermissionsStore.setState({ unrestricted: false } as never);
		}
	});

	it("rechecks git once the dialog set it up", async () => {
		api.fn("checkGitStatus").mockResolvedValue({ success: true, data: { isGitRepo: false, hasCommits: false } });
		api.fn("initializeGit").mockResolvedValue({ success: true });
		renderSidebar();
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Initialize Git" }));
		await waitFor(() => expect(api.fn("checkGitStatus")).toHaveBeenCalledTimes(2));
	});

	it("a git check that fails is logged, and no project means no check", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.fn("checkGitStatus").mockRejectedValue(new Error("git missing"));
		const { unmount } = renderSidebar();
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("Failed to check git status:", expect.any(Error)),
		);
		unmount();
		api.fn("checkGitStatus").mockClear();
		useProjectStore.setState({ selectedProjectId: null });
		renderSidebar();
		await act(() => Promise.resolve());
		expect(api.fn("checkGitStatus")).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("follows a page opened elsewhere even from a space chosen by hand", async () => {
		const { rerender, ...handlers } = renderSidebar({ activeView: "kanban" });
		await userEvent.click(railButton("Development"));
		rerender(<Sidebar {...handlers} activeView="terminals" />);
		expect(within(panel()).getByRole("heading", { name: "Agents" })).toBeInTheDocument();
	});

	it("the Labo lists the beta pages", async () => {
		renderSidebar();
		await userEvent.click(railButton("Labo"));
		expect(within(panel()).getAllByRole("button").length).toBeGreaterThan(3);
		expect(within(panel()).queryByRole("heading", { name: "Workspace" })).toBeNull();
	});

	it("the rail's new task button waits for an initialized project", async () => {
		useProjectStore.setState({ projects: [project({ autoBuildPath: "" })] });
		useSettingsStore.setState({ settings: { ...settings(), sidebarCollapsed: true } });
		const { onNewTaskClick } = renderSidebar();
		await userEvent.click(screen.getByRole("button", { name: "New Task" }));
		expect(onNewTaskClick).not.toHaveBeenCalled();
	});

	it("a recheck after setting git up that fails is logged", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.fn("checkGitStatus")
			.mockResolvedValueOnce({ success: true, data: { isGitRepo: false, hasCommits: false } })
			.mockRejectedValueOnce(new Error("gone"));
		api.fn("initializeGit").mockResolvedValue({ success: true });
		renderSidebar();
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Initialize Git" }));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("Failed to refresh git status:", expect.any(Error)),
		);
		error.mockRestore();
	});
});

