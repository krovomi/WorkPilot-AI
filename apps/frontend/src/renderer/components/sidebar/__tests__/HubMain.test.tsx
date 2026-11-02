/**
 * Each hub renders its tabs above the view on screen, as a WAI-ARIA tab list,
 * and a dialog tool's tab offers to open it.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

const openers = vi.hoisted(() => ({
	arena: vi.fn(),
	conflict: vi.fn(),
	snippets: vi.fn(),
	git: vi.fn(),
	estimation: vi.fn(),
}));
vi.mock("@/stores/arena-store", () => ({ openArenaDialog: openers.arena }));
vi.mock("@/stores/conflict-predictor-store", () => ({
	openConflictPredictorDialog: openers.conflict,
}));
vi.mock("@/stores/context-aware-snippets-store", () => ({
	openContextAwareSnippetsDialog: openers.snippets,
}));
vi.mock("@/stores/natural-language-git-store", () => ({
	useNaturalLanguageGitStore: { getState: () => ({ openDialog: openers.git }) },
}));
vi.mock("@/stores/smart-estimation-store", () => ({
	openSmartEstimation: openers.estimation,
}));

import type { Project } from "@shared/types";
import { DEFAULT_SIDEBAR_PREFS } from "@shared/types/settings";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { SidebarView } from "../../Sidebar";
import { HubMain } from "../HubMain";
import { forgetHubTabs, hubEntryTarget, SIDEBAR_HUBS } from "../hubs";

function renderMain(activeView: SidebarView, onSelectView = vi.fn()) {
	const utils = render(
		<HubMain activeView={activeView} onSelectView={onSelectView}>
			<div data-testid="view">{activeView}</div>
		</HubMain>,
	);
	return { ...utils, onSelectView };
}

function selectProject(remote: boolean) {
	const project = { id: "p1", path: "/p1", name: "p1", ...(remote ? { remote: {} } : {}) };
	useProjectStore.setState({
		projects: [project as unknown as Project],
		selectedProjectId: "p1",
	});
}

describe("HubMain", () => {
	beforeEach(() => {
		forgetHubTabs();
		for (const open of Object.values(openers)) open.mockReset();
		useProjectStore.setState({ projects: [], selectedProjectId: null });
		useSettingsStore.setState((state) => ({
			settings: { ...state.settings, sidebarPrefs: undefined },
		}));
	});

	it.each(SIDEBAR_HUBS.map((hub) => [hub.id, hub] as const))(
		"renders the %s hub as tabs over its view",
		(_id, hub) => {
			const first = hub.tabs[0].view;
			const { onSelectView } = renderMain(first);

			const list = screen.getByRole("tablist", { name: hub.labelKey });
			expect(list).toBeTruthy();
			const tabs = screen.getAllByRole("tab");
			expect(tabs.map((tab) => tab.textContent)).toEqual(hub.tabs.map((t) => t.labelKey));

			// One tab is selected and in the tab order; the panel names it.
			expect(tabs[0].getAttribute("aria-selected")).toBe("true");
			expect(tabs[0].tabIndex).toBe(0);
			for (const other of tabs.slice(1)) {
				expect(other.getAttribute("aria-selected")).toBe("false");
				expect(other.tabIndex).toBe(-1);
			}
			const panel = screen.getByRole("tabpanel");
			expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
			expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
			expect(screen.getByTestId("view").textContent).toBe(first);

			// Arrows move the focus without opening; a click opens.
			act(() => tabs[0].focus());
			fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
			expect(document.activeElement).toBe(tabs[1]);
			fireEvent.keyDown(tabs[1], { key: "End" });
			expect(document.activeElement).toBe(tabs.at(-1));
			fireEvent.keyDown(tabs.at(-1) as HTMLElement, { key: "ArrowRight" });
			expect(document.activeElement).toBe(tabs[0]);
			fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
			expect(document.activeElement).toBe(tabs.at(-1));
			expect(onSelectView).not.toHaveBeenCalled();

			fireEvent.click(tabs[1]);
			expect(onSelectView).toHaveBeenCalledWith(hub.tabs[1].view);
		},
	);

	it.each(
		SIDEBAR_HUBS.flatMap((hub) => hub.tabs.filter((tab) => tab.dialog)).map(
			(tab) => [tab.view, tab] as const,
		),
	)("offers to open the %s dialog from its tab", (_view, tab) => {
		renderMain(tab.view);
		expect(screen.getByText(`navigation:hubs.launchers.${tab.view}`)).toBeTruthy();
		const before = Object.values(openers).map((open) => open.mock.calls.length);
		fireEvent.click(screen.getByRole("button", { name: /navigation:hubs\.open/ }));
		const after = Object.values(openers).map((open) => open.mock.calls.length);
		expect(after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0)).toBe(1);
	});

	it("remembers the tab on screen as the hub's last one", () => {
		renderMain("agent-debugger");
		const hub = SIDEBAR_HUBS.find((h) => h.id === "agent-history");
		expect(hub && hubEntryTarget(hub, { serverProject: false })).toBe("agent-debugger");
	});

	it("shows no tabs outside a hub", () => {
		renderMain("kanban");
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(screen.queryByRole("tabpanel")).toBeNull();
		expect(screen.getByTestId("view").textContent).toBe("kanban");
	});

	it("shows a server project only the tabs it offers, and no list for one tab", () => {
		selectProject(true);
		renderMain("session-history");
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(screen.getByTestId("view").textContent).toBe("session-history");
	});

	it("hides experimental tabs when the user hid them, but not the one on screen", () => {
		selectProject(false);
		useSettingsStore.setState((state) => ({
			settings: {
				...state.settings,
				sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, hideExperimental: true },
			},
		}));
		// MCP's two marketplaces are experimental, the overview is not.
		const { unmount } = renderMain("agent-tools");
		expect(screen.queryByRole("tablist")).toBeNull();
		unmount();
		renderMain("mcp-marketplace");
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
			"navigation:items.agentTools",
			"navigation:items.mcpMarketplace",
		]);
	});

	it("keeps the view mounted when it enters or leaves a hub", () => {
		const mounts = vi.fn();
		function Kept() {
			useEffect(() => mounts(), []);
			return null;
		}
		const { rerender } = render(
			<HubMain activeView="kanban" onSelectView={vi.fn()}>
				<Kept />
			</HubMain>,
		);
		rerender(
			<HubMain activeView="agent-replay" onSelectView={vi.fn()}>
				<Kept />
			</HubMain>,
		);
		rerender(
			<HubMain activeView="kanban" onSelectView={vi.fn()}>
				<Kept />
			</HubMain>,
		);
		expect(mounts).toHaveBeenCalledTimes(1);
	});
});
