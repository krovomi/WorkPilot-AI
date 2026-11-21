/**
 * App — the shell around every page: which page the sidebar opens, the
 * prompt that guards a running build, the project tabs, the settings dialog
 * and the events that open it, the theme, the language, the first-run
 * dialogs and the task panel.
 *
 * Every child is a stub (`stub-component.ts`) that keeps the props App gave
 * it; the stores are the real ones, fed through `installRendererApi`.
 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../__tests__/helpers/renderer-api";
import {
	callStub,
	resetStubs,
	stubComponent,
	stubHook,
	stubModule,
	stubProps,
} from "../../__tests__/helpers/stub-component";
import type { Project, Task, TaskStatus } from "../../shared/types";
import i18n from "../../shared/i18n";
import { App } from "../App";
import { useClaudeProfileStore } from "../stores/claude-profile-store";
import { useCommandPaletteStore } from "../stores/command-palette-store";
import { useKanbanSettingsStore } from "../stores/kanban-settings-store";
import { useProjectEnvStore } from "../stores/project-env-store";
import { useProjectStore } from "../stores/project-store";
import { useServerSessionStore } from "../stores/server-session-store";
import { useSettingsStore } from "../stores/settings-store";
import { useSetupHubStore } from "../stores/setup-hub-store";
import { useTaskStore } from "../stores/task-store";

vi.mock("@/components", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...stubModule("Sidebar", "KanbanBoard", "TaskCreationWizard"),
}));
vi.mock("@/components/task-detail", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...stubModule("TaskDetailModal"),
}));
vi.mock("../components/onboarding", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...stubModule("OnboardingWizard"),
}));
vi.mock("@dnd-kit/core", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DndContext: stubComponent("DndContext"),
	DragOverlay: stubComponent("DragOverlay"),
}));
vi.mock("../components/settings/AppSettings", () =>
	stubModule("AppSettingsDialog"),
);
vi.mock("../components/setup-hub/SetupHub", () => stubModule("SetupHub"));
vi.mock("../components/guided-tour/GuidedTourOverlay", () =>
	stubModule("GuidedTourOverlay"),
);
vi.mock("../components/auth/ServerLoginScreen", () =>
	stubModule("ServerLoginScreen"),
);
vi.mock("../components/TerminalGrid", () => stubModule("TerminalGrid"));
vi.mock("../components/ProjectTabBar", () => stubModule("ProjectTabBar"));
vi.mock("../components/sidebar/HubMain", () => stubModule("HubMain"));
vi.mock("../components/AddProjectModal", () => stubModule("AddProjectModal"));
vi.mock("../components/AuthFailureModal", () => stubModule("AuthFailureModal"));
vi.mock("../components/CommandPalette", () => stubModule("CommandPalette"));
vi.mock("../components/GlobalDownloadIndicator", () =>
	stubModule("GlobalDownloadIndicator"),
);
vi.mock("../components/formula-lab/FormulaLab", () => stubModule("FormulaLab"));
vi.mock("../components/KeyboardShortcutsOverlay", () =>
	stubModule("KeyboardShortcutsOverlay"),
);
vi.mock("../components/ActivityCentre", () => stubModule("ActivityCentre"));
vi.mock("../components/NoProjectPage", () => stubModule("NoProjectPage"));
vi.mock("../components/PageLlmSelector", () => stubModule("PageLlmSelector"));
vi.mock("../components/RateLimitModal", () => stubModule("RateLimitModal"));
vi.mock("../components/SDKRateLimitModal", () =>
	stubModule("SDKRateLimitModal"),
);
vi.mock("../components/VersionWarningModal", () =>
	stubModule("VersionWarningModal"),
);
const detector = vi.hoisted(() => ({
	autoDetectAndUpdateProject: vi.fn(async (_project: Project): Promise<void> => undefined),
	restoreTerminalSessions: vi.fn(async () => undefined),
}));
vi.mock("../utils/repositoryDetector", () => ({
	autoDetectAndUpdateProject: detector.autoDetectAndUpdateProject,
}));
vi.mock("../stores/terminal-store", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	restoreTerminalSessions: detector.restoreTerminalSessions,
}));
vi.mock("../hooks/useTaskNotifications", () => ({
	useTaskNotifications: stubHook("useTaskNotifications"),
}));
vi.mock("../hooks/useNeedsYou", () => ({ useNeedsYou: stubHook("useNeedsYou") }));
vi.mock("../hooks/useActivityNotifications", () => ({
	useActivityNotifications: stubHook("useActivityNotifications"),
}));
vi.mock("../hooks/useKeyboardShortcuts", () => ({
	useKeyboardShortcuts: stubHook("useKeyboardShortcuts"),
}));
// The pages, loaded lazily by App.
vi.mock("../components/Roadmap", () => stubModule("Roadmap"));
vi.mock("@/components/context/Context", () => stubModule("Context"));
vi.mock("@/components/ideation/Ideation", () => stubModule("Ideation"));
vi.mock("../components/Insights", () => stubModule("Insights"));
vi.mock("@/components/GitHubIssues", () => stubModule("GitHubIssues"));
vi.mock("../components/GitLabIssues", () => stubModule("GitLabIssues"));
vi.mock("../components/github-prs", () => stubModule("GitHubPRs"));
vi.mock("../components/gitlab-merge-requests", () => stubModule("GitLabMergeRequests"));
vi.mock("../components/bitbucket/BitbucketViews", () => stubModule("BitbucketViews"));
vi.mock("../components/Changelog", () => stubModule("Changelog"));
vi.mock("../components/AgentTools", () => stubModule("AgentTools"));
vi.mock("../components/Worktrees", () => stubModule("Worktrees"));
vi.mock("../components/code-migration/CodeMigrationDashboard", () => stubModule("CodeMigrationDashboard"));
vi.mock("../components/architecture-visualizer/ArchitectureVisualizer", () => stubModule("ArchitectureVisualizer"));
vi.mock("../components/performance-profiler/PerformanceProfilerDashboard", () => stubModule("PerformanceProfilerDashboard"));
vi.mock("../components/visual-to-code/VisualToCodeHub", () => stubModule("VisualToCodeHub"));
vi.mock("../components/cicd-triggers/CICDTriggersDashboard", () => stubModule("CICDTriggersDashboard"));
vi.mock("../components/cross-language-translation/CrossLanguageTranslationDashboard", () => stubModule("CrossLanguageTranslationDashboard"));
vi.mock("../components/spec-approval/SpecApprovalDashboard", () => stubModule("SpecApprovalDashboard"));
vi.mock("../components/live-companion/LiveCompanionDashboard", () => stubModule("LiveCompanionDashboard"));
vi.mock("../components/context-mesh/ContextMeshDashboard", () => stubModule("ContextMeshDashboard"));
vi.mock("../components/DashboardMetrics", () => stubModule("DashboardMetrics"));
vi.mock("../components/AnalyticsDashboard", () => stubModule("AnalyticsDashboard"));
vi.mock("../components/CodeReview", () => stubModule("CodeReview"));
vi.mock("../components/RefactoringView", () => stubModule("RefactoringView"));
vi.mock("../components/DocumentationView", () => stubModule("DocumentationView"));
vi.mock("../components/CostEstimator", () => stubModule("CostEstimator"));
vi.mock("../components/SessionHistory", () => stubModule("SessionHistory"));
vi.mock("../components/mcp-marketplace/McpMarketplace", () => stubModule("McpMarketplace"));
vi.mock("../components/phase35", () => stubModule("Phase35Hub"));
vi.mock("../components/mission-control/MissionControlDashboard", () => stubModule("MissionControlDashboard"));
vi.mock("../components/agent-replay", () => stubModule("AgentReplayDashboard"));
vi.mock("../components/pixel-office", () => stubModule("PixelOffice"));
vi.mock("../components/self-healing", () => stubModule("SelfHealingDashboard"));
vi.mock("../components/browser-agent", () => stubModule("BrowserAgentDashboard"));
vi.mock("../components/PairProgramming", () => stubModule("PairProgramming"));
vi.mock("../components/pipeline-generator/PipelineGenerator", () => stubModule("PipelineGenerator"));
vi.mock("../components/plugin-marketplace/PluginMarketplace", () => stubModule("PluginMarketplace"));
vi.mock("../components/administration/AdministrationView", () => stubModule("AdministrationView"));
vi.mock("../components/api-explorer", () => stubModule("ApiExplorer"));
vi.mock("../components/sandbox/SimulationReport", () => stubModule("SimulationReport"));
vi.mock("../components/regression-guardian/RegressionGuardianDashboard", () => stubModule("RegressionGuardianDashboard"));
vi.mock("../components/injection-guard/InjectionGuardView", () => stubModule("InjectionGuardView"));
vi.mock("../components/api-watcher/ApiWatcherDashboard", () => stubModule("ApiWatcherDashboard"));
vi.mock("../components/accessibility-agent/A11yReportView", () => stubModule("A11yReportView"));
vi.mock("../components/i18n-agent/I18nReportView", () => stubModule("I18nReportView"));
vi.mock("../components/onboarding-agent/OnboardingGuideView", () => stubModule("OnboardingGuideView"));
vi.mock("../components/onboarding-agent/OnboardingPackageView", () => stubModule("OnboardingPackageView"));
vi.mock("../components/flaky-tests/FlakyTestReport", () => stubModule("FlakyTestReport"));
vi.mock("../components/doc-drift/DocDriftReport", () => stubModule("DocDriftReport"));
vi.mock("../components/compliance/ComplianceReportView", () => stubModule("ComplianceReportView"));
vi.mock("../components/git-surgeon/GitSurgeonDashboard", () => stubModule("GitSurgeonDashboard"));
vi.mock("../components/release-coordinator/ReleasePlanView", () => stubModule("ReleasePlanView"));
vi.mock("../components/carbon-profiler/CarbonReportView", () => stubModule("CarbonReportView"));
vi.mock("../components/consensus-arbiter/ConsensusView", () => stubModule("ConsensusView"));
vi.mock("../components/notebook-agent/NotebookView", () => stubModule("NotebookView"));
vi.mock("../components/agent-coach/CoachReportView", () => stubModule("CoachReportView"));
vi.mock("../components/bench/RepoBenchView", () => stubModule("RepoBenchView"));
vi.mock("../components/bounty-board/BountyBoardView", () => stubModule("BountyBoardView"));
vi.mock("../components/tech-debt/TechDebtDashboard", () => stubModule("TechDebtDashboard"));
vi.mock("../components/agent-debugger/AgentDebuggerPanel", () => stubModule("AgentDebuggerPanel"));
vi.mock("../components/blast-radius/BlastRadiusView", () => stubModule("BlastRadiusView"));
vi.mock("../components/settings/TeamBotSettings", () => stubModule("TeamBotSettings"));
vi.mock("../components/settings/GuardrailsSettings", () => stubModule("GuardrailsView"));
vi.mock("../components/env-snapshot/EnvSnapshotView", () => stubModule("EnvSnapshotView"));
vi.mock("../components/offline-mode/OfflineModeSettings", () => stubModule("OfflineModeSettings"));

const PROJECT_ONE: Project = {
	id: "p1",
	name: "One",
	path: "/repo/one",
	autoBuildPath: "/repo/one/.workpilot",
	settings: {} as Project["settings"],
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: new Date("2026-11-01T10:00:00Z"),
};
const PROJECT_TWO: Project = {
	...PROJECT_ONE,
	id: "p2",
	name: "Two",
	path: "/repo/two",
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		specId: `spec-${id}`,
		projectId: "p1",
		title: `Task ${id}`,
		description: "",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

const STORES = [
	useProjectStore,
	useTaskStore,
	useSettingsStore,
	useServerSessionStore,
	useSetupHubStore,
	useCommandPaletteStore,
	useKanbanSettingsStore,
	useClaudeProfileStore,
	useProjectEnvStore,
] as const;
const initialStates = new Map<unknown, unknown>();

let api: RendererApi;
let prefersDark = false;
const mediaListeners = new Set<() => void>();

interface RenderOptions {
	projects?: Project[];
	tasks?: Task[];
	settings?: Record<string, unknown>;
	overrides?: Record<string, unknown>;
}

async function renderApp({
	projects = [PROJECT_ONE],
	tasks = [],
	settings = {},
	overrides = {},
}: RenderOptions = {}) {
	api = installRendererApi({
		getTabState: async () => ({
			success: true,
			data: {
				openProjectIds: projects.map((p) => p.id),
				activeProjectId: projects[0]?.id ?? null,
				tabOrder: projects.map((p) => p.id),
			},
		}),
		getProjects: async () => ({ success: true, data: projects }),
		getTasks: async () => ({ success: true, data: tasks }),
		getSettings: async () => ({
			success: true,
			data: {
				onboardingCompleted: true,
				language: "en",
				theme: "light",
				...settings,
			},
		}),
		getAppVersion: async () => "1.5.0",
		serverAuth: {
			restore: async () => ({
				mode: "local",
				configured: true,
				isAuthenticated: false,
			}),
			onStateChanged: () => () => undefined,
		},
		...overrides,
	});
	const utils = render(<App />);
	await waitFor(() =>
		expect(useSettingsStore.getState().isLoading).toBe(false),
	);
	if (projects.length > 0 && !settings.activeView) {
		await screen.findByTestId("stub-KanbanBoard");
		await waitFor(() =>
			expect(stubProps("KanbanBoard").tasks).toHaveLength(tasks.length),
		);
	}
	return utils;
}

/** What the sidebar does on a click: App decides whether to go. */
async function go(view: string, force?: boolean) {
	await act(async () => {
		callStub("Sidebar", "onViewChange", view, force);
	});
}

async function call(name: string, prop: string, ...args: unknown[]) {
	await act(async () => {
		await callStub(name, prop, ...args);
	});
}

function savedViews(): unknown[] {
	return api
		.fn("saveSettings")
		.mock.calls.map(([updates]) => (updates as { activeView?: unknown }).activeView)
		.filter(Boolean);
}

beforeAll(() => {
	for (const store of STORES) initialStates.set(store, store.getState());
});

beforeEach(() => {
	resetStubs();
	detector.autoDetectAndUpdateProject.mockClear();
	detector.restoreTerminalSessions.mockReset().mockResolvedValue(undefined);
	prefersDark = false;
	mediaListeners.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			get matches() {
				return prefersDark;
			},
			addEventListener: (_: string, listener: () => void) =>
				mediaListeners.add(listener),
			removeEventListener: (_: string, listener: () => void) =>
				mediaListeners.delete(listener),
		})),
	);
});

afterEach(async () => {
	// Unmount before the stores reset, or App re-renders against them.
	cleanup();
	api?.restore();
	vi.unstubAllGlobals();
	for (const store of STORES) {
		(store as { setState: (s: unknown, replace: boolean) => void }).setState(
			initialStates.get(store),
			true,
		);
	}
	localStorage.clear();
	document.documentElement.className = "";
	delete document.documentElement.dataset.theme;
	delete document.documentElement.dataset.uiScale;
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("without a project", () => {
	it("the Kanban offers to add one, and an added project opens in a tab", async () => {
		await renderApp({ projects: [] });
		expect(screen.getByTestId("stub-NoProjectPage")).toBeInTheDocument();
		expect(screen.queryByTestId("stub-TaskCreationWizard")).toBeNull();

		await call("NoProjectPage", "onAddProject");
		expect(stubProps("AddProjectModal").open).toBe(true);

		await call("AddProjectModal", "onProjectAdded", PROJECT_ONE, false);
		expect(useProjectStore.getState().openProjectIds).toContain("p1");
		expect(stubProps("AppSettingsDialog").open).toBe(false);
	});

	it("a project that still needs its setup opens its own settings", async () => {
		await renderApp({ projects: [] });
		await call("AddProjectModal", "onProjectAdded", PROJECT_TWO, true);
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialProjectId: "p2",
			initialProjectSection: "general",
		});

		// Closing the dialog forgets the section and the project it was for.
		await call("AppSettingsDialog", "onOpenChange", false);
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: false,
			initialSection: undefined,
			initialProjectSection: undefined,
		});
	});

	it("a project without its .workpilot folder also opens its settings", async () => {
		await renderApp({ projects: [] });
		await call(
			"AddProjectModal",
			"onProjectAdded",
			{ ...PROJECT_TWO, autoBuildPath: "" },
			false,
		);
		expect(stubProps("AppSettingsDialog").open).toBe(true);
	});

	it("pages that need a project say none is selected", async () => {
		await renderApp({ projects: [] });
		await go("roadmap", true);
		expect(screen.getByText("No project selected")).toBeInTheDocument();
		expect(screen.queryByTestId("stub-Roadmap")).toBeNull();
	});

	it("the onboarding's task step asks for a project first", async () => {
		await renderApp({
			projects: [],
			settings: { onboardingCompleted: false },
		});
		await waitFor(() => expect(stubProps("OnboardingWizard").open).toBe(true));
		await call("OnboardingWizard", "onOpenTaskCreator");
		expect(stubProps("AddProjectModal").open).toBe(true);
	});
});

describe("the active project", () => {
	it("loads its tasks, its env config and its terminals", async () => {
		const tasks = [makeTask("a")];
		await renderApp({ tasks });
		expect(api.fn("getTasks")).toHaveBeenCalledWith("p1", undefined);
		expect(stubProps("TerminalGrid").projectPath).toBe("/repo/one");
		expect(stubProps("TaskCreationWizard").projectId).toBe("p1");
	});

	it("the Kanban's refresh reloads from disk and shows a skeleton meanwhile", async () => {
		await renderApp({ tasks: [makeTask("a")] });
		let finish: (value: unknown) => void = () => undefined;
		api.fn("getTasks").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		act(() => {
			void callStub("KanbanBoard", "onRefresh");
		});
		expect(api.fn("getTasks")).toHaveBeenLastCalledWith("p1", {
			forceRefresh: true,
		});
		expect(screen.queryByTestId("stub-KanbanBoard")).toBeNull();
		await act(async () => {
			finish({ success: true, data: [makeTask("a"), makeTask("b")] });
		});
		await waitFor(() => expect(stubProps("KanbanBoard").tasks).toHaveLength(2));
	});

	it("the Kanban's buttons open the wizard and the right settings", async () => {
		await renderApp();
		await call("KanbanBoard", "onNewTaskClick");
		expect(stubProps("TaskCreationWizard").open).toBe(true);

		await call("KanbanBoard", "onOpenJiraSettings");
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialProjectSection: "jira",
			initialProjectId: "p1",
		});
		await call("KanbanBoard", "onOpenAzureDevOpsSettings");
		expect(stubProps("AppSettingsDialog").initialProjectSection).toBe(
			"azure-devops",
		);
	});

	it("the sidebar's buttons open the settings, the wizard and a project's setup", async () => {
		await renderApp();
		await call("Sidebar", "onNewTaskClick");
		expect(stubProps("TaskCreationWizard").open).toBe(true);
		await call("Sidebar", "onSettingsClick");
		expect(stubProps("AppSettingsDialog").open).toBe(true);
		await call("AppSettingsDialog", "onOpenChange", false);
		await call("Sidebar", "onInitializeProject", "p1");
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialProjectSection: "general",
		});
	});

	it("switching project loads the other project's tasks and clears the open task", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO], tasks: [makeTask("a")] });
		await call("KanbanBoard", "onTaskClick", makeTask("a"));
		expect(stubProps("TaskDetailModal").open).toBe(true);

		await call("ProjectTabBar", "onProjectSelect", "p2");
		expect(api.fn("getTasks")).toHaveBeenCalledWith("p2", undefined);
		expect(api.fn("getProjectEnv")).toHaveBeenCalledWith("p2");
		expect(stubProps("TaskDetailModal").open).toBe(false);
		expect(stubProps("TerminalGrid").projectPath).toBe("/repo/two");
	});
});

describe("the task panel", () => {
	const later = new Date("2026-11-02T10:00:00Z");
	const tasks = [makeTask("a"), makeTask("b", { createdAt: later, updatedAt: later })];

	it("opens on a card, steps to its neighbours and closes", async () => {
		await renderApp({ tasks });
		await call("KanbanBoard", "onTaskClick", tasks[0]);
		const first = stubProps("TaskDetailModal");
		expect(first.open).toBe(true);
		expect(first.hasPrevious !== first.hasNext).toBe(true);

		const step = first.hasNext ? "onNavigateNext" : "onNavigatePrevious";
		const back = first.hasNext ? "onNavigatePrevious" : "onNavigateNext";
		await call("TaskDetailModal", step);
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("b");
		await call("TaskDetailModal", back);
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("a");

		// Stepping past the ends does nothing.
		await call("TaskDetailModal", back);
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("a");

		await call("TaskDetailModal", "onOpenChange", true);
		expect(stubProps("TaskDetailModal").open).toBe(true);
		await call("TaskDetailModal", "onOpenChange", false);
		expect(stubProps("TaskDetailModal").open).toBe(false);
	});

	it("stepping past the last card does nothing", async () => {
		await renderApp({ tasks });
		await call("KanbanBoard", "onTaskClick", tasks[1]);
		const props = stubProps("TaskDetailModal");
		await call(
			"TaskDetailModal",
			props.hasNext ? "onNavigatePrevious" : "onNavigateNext",
		);
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("b");
	});

	it("follows the open task as the store updates it", async () => {
		await renderApp({ tasks });
		await call("KanbanBoard", "onTaskClick", tasks[0]);
		act(() => {
			useTaskStore.setState({
				tasks: [{ ...tasks[0], status: "in_progress" }, tasks[1]],
			});
		});
		expect((stubProps("TaskDetailModal").task as Task).status).toBe(
			"in_progress",
		);

		// An unrelated change, or the task leaving the board, keeps the panel as is.
		const shown = stubProps("TaskDetailModal").task;
		act(() => {
			useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks] });
		});
		expect(stubProps("TaskDetailModal").task).toBe(shown);
		act(() => {
			useTaskStore.setState({ tasks: [tasks[1]] });
		});
		expect(stubProps("TaskDetailModal").task).toBe(shown);
	});

	it("a page's link to a task goes to the Kanban with that task open", async () => {
		await renderApp({ tasks });
		await go("roadmap", true);
		await screen.findByTestId("stub-Roadmap");
		await call("Roadmap", "onGoToTask", "spec-b");
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("b");

		// A link to a task that is gone only switches page.
		await go("ideation", true);
		await screen.findByTestId("stub-Ideation");
		await call("TaskDetailModal", "onOpenChange", false);
		await call("Ideation", "onGoToTask", "missing");
		expect(stubProps("TaskDetailModal").open).toBe(false);
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();
	});

	it("an activity opens its page, and its task when it is one", async () => {
		await renderApp({ tasks });
		await call("ActivityCentre", "onOpen", { id: "task:a", view: "kanban" });
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("a");

		await call("TaskDetailModal", "onOpenChange", false);
		await call("ActivityCentre", "onOpen", { id: "task:gone", view: "kanban" });
		expect(stubProps("TaskDetailModal").open).toBe(false);

		await call("ActivityCentre", "onOpen", { id: "insights:1", view: "insights" });
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();
		expect(stubProps("ActivityCentre").activeView).toBe("insights");
	});

	it("a navigate-view event switches page and can open a task", async () => {
		await renderApp({ tasks });
		act(() => {
			window.dispatchEvent(
				new CustomEvent("workpilot:navigate-view", {
					detail: { view: "insights" },
				}),
			);
		});
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();

		act(() => {
			window.dispatchEvent(
				new CustomEvent("workpilot:navigate-view", {
					detail: { view: "kanban", taskId: "b" },
				}),
			);
		});
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("b");

		// No view and an unknown task: nothing moves.
		await call("TaskDetailModal", "onOpenChange", false);
		act(() => {
			window.dispatchEvent(
				new CustomEvent("workpilot:navigate-view", {
					detail: { taskId: "missing" },
				}),
			);
		});
		expect(stubProps("TaskDetailModal").open).toBe(false);
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();
	});
});

describe("leaving the Kanban while a build runs", () => {
	const running = makeTask("run", { status: "in_progress", title: "Build login" });

	it("asks first, and staying keeps the Kanban", async () => {
		await renderApp({ tasks: [running] });
		await go("roadmap");
		expect(screen.getByText("Task in progress")).toBeInTheDocument();
		expect(screen.getByText("Running: Build login")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /Continue task/ }));
		expect(screen.queryByText("Task in progress")).toBeNull();
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();
	});

	it("stopping stops the build and goes", async () => {
		await renderApp({ tasks: [running] });
		await go("roadmap");
		await userEvent.click(screen.getByRole("button", { name: /Stop task/ }));
		expect(api.fn("stopTask")).toHaveBeenCalledWith("run");
		expect(await screen.findByTestId("stub-Roadmap")).toBeInTheDocument();
	});

	it("pausing asks the backend to pause and goes", async () => {
		await renderApp({ tasks: [running] });
		await go("roadmap");
		await userEvent.click(screen.getByRole("button", { name: /Pause task/ }));
		expect(api.fn("invoke")).toHaveBeenCalledWith("TASK_PAUSE", "run", undefined);
		expect(await screen.findByTestId("stub-Roadmap")).toBeInTheDocument();
	});

	it("the background choice goes, and asks again unless told not to", async () => {
		await renderApp({ tasks: [running] });
		await go("roadmap");
		await userEvent.click(
			screen.getByRole("button", { name: /Continue in the background/ }),
		);
		expect(await screen.findByTestId("stub-Roadmap")).toBeInTheDocument();

		await go("insights");
		expect(screen.getByText("Task in progress")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("checkbox", { name: /Don't ask again/ }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Continue in the background/ }),
		);
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();

		await go("ideation");
		expect(screen.queryByText("Task in progress")).toBeNull();
		expect(await screen.findByTestId("stub-Ideation")).toBeInTheDocument();
	});

	it("the Kanban itself, a forced move, a paused build or no build never ask", async () => {
		const paused = makeTask("p", {
			status: "in_progress",
			metadata: { paused: { enabled: true } } as Task["metadata"],
		});
		await renderApp({ tasks: [paused] });
		await go("roadmap");
		expect(screen.queryByText("Task in progress")).toBeNull();
		expect(await screen.findByTestId("stub-Roadmap")).toBeInTheDocument();
		await go("kanban");
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();

		act(() => {
			useTaskStore.setState({ tasks: [running] });
		});
		await go("insights", true);
		expect(screen.queryByText("Task in progress")).toBeNull();
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();
	});

	it("keyboard and hub navigation go through the same prompt", async () => {
		await renderApp({ tasks: [running] });
		await call("HubMain", "onSelectView", "roadmap");
		expect(screen.getByText("Task in progress")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Continue task/ }));
		await call("useKeyboardShortcuts", "onNavigate", "insights");
		expect(screen.getByText("Task in progress")).toBeInTheDocument();
	});

	it("a notification, a task alert or an activity toast goes without asking", async () => {
		await renderApp({ tasks: [running] });
		const cases: Array<[string, string, string]> = [
			["useTaskNotifications", "insights", "Insights"],
			["useNeedsYou", "roadmap", "Roadmap"],
			["useActivityNotifications", "ideation", "Ideation"],
		];
		for (const [hook, view, page] of cases) {
			await call(hook, "onNavigate", view);
			expect(await screen.findByTestId(`stub-${page}`)).toBeInTheDocument();
			expect(screen.queryByText("Task in progress")).toBeNull();
		}
	});
});

describe("the page on screen", () => {
	it("is saved when it changes", async () => {
		await renderApp();
		await go("insights", true);
		await waitFor(() => expect(savedViews()).toContain("insights"));
	});

	it("comes back on the next start, without being saved again", async () => {
		await renderApp({ settings: { activeView: "insights" } });
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();
		expect(savedViews()).not.toContain("insights");
	});

	it("tells the page selector and the hub which page it is", async () => {
		await renderApp();
		await go("changelog", true);
		await screen.findByTestId("stub-Changelog");
		expect(stubProps("PageLlmSelector").page).toBe("changelog");
		expect(stubProps("HubMain").activeView).toBe("changelog");
	});

	it("the command palette moves between pages and opens a settings section", async () => {
		await renderApp();
		await call("CommandPalette", "onNavigate", "insights");
		expect(await screen.findByTestId("stub-Insights")).toBeInTheDocument();
		await call("CommandPalette", "onNewTask");
		expect(stubProps("TaskCreationWizard").open).toBe(true);
		await call("CommandPalette", "onOpenSettings");
		expect(stubProps("AppSettingsDialog").open).toBe(true);
		await call("AppSettingsDialog", "onOpenChange", false);
		await call("CommandPalette", "onOpenSettingsSection", "theme");
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialSection: "theme",
		});
		await call("CommandPalette", "onOpenChange", true);
		expect(useCommandPaletteStore.getState().open).toBe(true);
	});

	it("the keyboard shortcuts open the palette, the overlay, the wizard and the settings", async () => {
		await renderApp();
		await call("useKeyboardShortcuts", "onCommandPalette");
		expect(useCommandPaletteStore.getState().open).toBe(true);
		await call("useKeyboardShortcuts", "onKeyboardShortcuts");
		expect(stubProps("KeyboardShortcutsOverlay").open).toBe(true);
		await call("KeyboardShortcutsOverlay", "onOpenChange", false);
		expect(stubProps("KeyboardShortcutsOverlay").open).toBe(false);
		await call("useKeyboardShortcuts", "onNewTask");
		expect(stubProps("TaskCreationWizard").open).toBe(true);
		await call("useKeyboardShortcuts", "onOpenSettings");
		expect(stubProps("AppSettingsDialog").open).toBe(true);
	});

	it("the terminals' new task button opens the wizard", async () => {
		await renderApp();
		await call("TerminalGrid", "onNewTaskClick");
		expect(stubProps("TaskCreationWizard").open).toBe(true);
	});

	it("the pixel office sends to the terminals or back to the Kanban", async () => {
		await renderApp();
		await go("pixel-office", true);
		await screen.findByTestId("stub-PixelOffice");
		expect(stubProps("PixelOffice")).toMatchObject({
			projectPath: "/repo/one",
			projectId: "p1",
		});
		await call("PixelOffice", "onNavigateToTerminals");
		expect(stubProps("TerminalGrid").isActive).toBe(true);
		await go("pixel-office", true);
		await call("PixelOffice", "onNavigateToKanban");
		expect(screen.getByTestId("stub-KanbanBoard")).toBeInTheDocument();
	});

	it("the forge pages open the forge's own settings", async () => {
		await renderApp();
		const cases: Array<[string, string, string]> = [
			["github-issues", "GitHubIssues", "github"],
			["gitlab-issues", "GitLabIssues", "gitlab"],
			["github-prs", "GitHubPRs", "github"],
			["gitlab-merge-requests", "GitLabMergeRequests", "gitlab"],
			["bitbucket-issues", "BitbucketViews", "bitbucket"],
			["bitbucket-pull-requests", "BitbucketViews", "bitbucket"],
		];
		for (const [view, page, section] of cases) {
			await go(view, true);
			await screen.findByTestId(`stub-${page}`);
			await call(page, "onOpenSettings");
			expect(stubProps("AppSettingsDialog")).toMatchObject({
				open: true,
				initialProjectSection: section,
			});
			await call("AppSettingsDialog", "onOpenChange", false);
		}
		expect(stubProps("GitHubPRs").isActive).toBe(false);
	});

	it("the issue pages link to their task on the Kanban", async () => {
		await renderApp({ tasks: [makeTask("a")] });
		await go("github-issues", true);
		await screen.findByTestId("stub-GitHubIssues");
		await call("GitHubIssues", "onNavigateToTask", "a");
		expect((stubProps("TaskDetailModal").task as Task).id).toBe("a");
	});
});

describe("every sidebar page", () => {
	const pages: Array<[string, string]> = [
		["phase35-hub", "Phase35Hub"],
		["mcp-marketplace", "McpMarketplace"],
		["plugin-marketplace", "PluginMarketplace"],
		["api-explorer", "ApiExplorer"],
		["administration", "AdministrationView"],
		["mission-control", "MissionControlDashboard"],
		["agent-replay", "AgentReplayDashboard"],
		["self-healing", "SelfHealingDashboard"],
		["browser-agent", "BrowserAgentDashboard"],
		["roadmap", "Roadmap"],
		["context", "Context"],
		["ideation", "Ideation"],
		["insights", "Insights"],
		["changelog", "Changelog"],
		["agent-tools", "AgentTools"],
		["worktrees", "Worktrees"],
		["migration", "CodeMigrationDashboard"],
		["architecture-visualizer", "ArchitectureVisualizer"],
		["performance-profiler", "PerformanceProfilerDashboard"],
		["visual-to-code", "VisualToCodeHub"],
		["cicd-triggers", "CICDTriggersDashboard"],
		["cross-language-translation", "CrossLanguageTranslationDashboard"],
		["spec-approval", "SpecApprovalDashboard"],
		["live-companion", "LiveCompanionDashboard"],
		["context-mesh", "ContextMeshDashboard"],
		["dashboard", "DashboardMetrics"],
		["analytics", "AnalyticsDashboard"],
		["code-review", "CodeReview"],
		["refactoring", "RefactoringView"],
		["documentation", "DocumentationView"],
		["cost-estimator", "CostEstimator"],
		["session-history", "SessionHistory"],
		["pair-programming", "PairProgramming"],
		["pipeline-generator", "PipelineGenerator"],
		["sandbox", "SimulationReport"],
		["regression-guardian", "RegressionGuardianDashboard"],
		["injection-guard", "InjectionGuardView"],
		["api-watcher", "ApiWatcherDashboard"],
		["accessibility-agent", "A11yReportView"],
		["i18n-agent", "I18nReportView"],
		["onboarding-agent", "OnboardingPackageView"],
		["onboarding-guide", "OnboardingGuideView"],
		["flaky-tests", "FlakyTestReport"],
		["doc-drift", "DocDriftReport"],
		["compliance", "ComplianceReportView"],
		["git-surgeon", "GitSurgeonDashboard"],
		["release-coordinator", "ReleasePlanView"],
		["carbon-profiler", "CarbonReportView"],
		["consensus-arbiter", "ConsensusView"],
		["notebook-agent", "NotebookView"],
		["agent-coach", "CoachReportView"],
		["repo-bench", "RepoBenchView"],
		["bounty-board", "BountyBoardView"],
		["tech-debt", "TechDebtDashboard"],
		["agent-debugger", "AgentDebuggerPanel"],
		["blast-radius", "BlastRadiusView"],
		["team-bot", "TeamBotSettings"],
		["guardrails", "GuardrailsView"],
		["env-snapshot", "EnvSnapshotView"],
		["offline-mode", "OfflineModeSettings"],
	];

	it("shows its own page, for the active project, and only that page", async () => {
		await renderApp();
		for (const [view, page] of pages) {
			await go(view, true);
			expect(await screen.findByTestId(`stub-${page}`), view).toBeInTheDocument();
			expect(screen.queryByTestId("stub-KanbanBoard"), view).toBeNull();
			const props = stubProps(page);
			for (const [prop, value] of [
				["projectId", "p1"],
				["projectPath", "/repo/one"],
				["projectRoot", "/repo/one"],
			]) {
				if (prop in props) expect(props[prop], `${view} ${prop}`).toBe(value);
			}
		}
	});
});

describe("project tabs on start", () => {
	function tabState(data: unknown) {
		return { getTabState: async () => ({ success: true, data }) };
	}

	it("with no saved tabs, opens the active project", async () => {
		await renderApp({
			projects: [PROJECT_ONE, PROJECT_TWO],
			overrides: tabState({ openProjectIds: [], activeProjectId: "p2" }),
		});
		expect(useProjectStore.getState().openProjectIds).toEqual(["p2"]);
		expect(useProjectStore.getState().activeProjectId).toBe("p2");
	});

	it("with no saved tabs and a stale project, opens the first one", async () => {
		await renderApp({
			overrides: tabState({ openProjectIds: [], activeProjectId: "gone" }),
		});
		expect(useProjectStore.getState().openProjectIds).toEqual(["p1"]);
		expect(useProjectStore.getState().activeProjectId).toBe("p1");
	});

	it("with nothing saved at all, opens the first project", async () => {
		await renderApp({ overrides: { getTabState: async () => ({ success: true }) } });
		expect(useProjectStore.getState().openProjectIds).toEqual(["p1"]);
		expect(useProjectStore.getState().activeProjectId).toBe("p1");
	});

	it("an active project without its tab gets one", async () => {
		await renderApp({
			projects: [PROJECT_ONE, PROJECT_TWO],
			overrides: tabState({ openProjectIds: ["p1"], activeProjectId: "p2" }),
		});
		expect(useProjectStore.getState().openProjectIds).toEqual(["p1", "p2"]);
	});

	it("a selected project without an active one becomes active", async () => {
		localStorage.setItem("lastSelectedProjectId", "p2");
		await renderApp({
			projects: [PROJECT_ONE, PROJECT_TWO],
			overrides: tabState({ openProjectIds: ["p1"], activeProjectId: null }),
		});
		await waitFor(() =>
			expect(useProjectStore.getState().activeProjectId).toBe("p2"),
		);
		expect(useProjectStore.getState().openProjectIds).toContain("p2");
	});

	it("coming back to the window rechecks the project folders", async () => {
		await renderApp();
		const refreshMissingPaths = vi.fn(async () => undefined);
		useProjectStore.setState({ refreshMissingPaths });
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(refreshMissingPaths).toHaveBeenCalledOnce();
	});

	it("a terminal restore that fails is only logged", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		detector.restoreTerminalSessions.mockRejectedValue(new Error("pty gone"));
		await renderApp();
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"[App] Failed to restore sessions:",
				expect.any(Error),
			),
		);
		expect(detector.restoreTerminalSessions).toHaveBeenCalledWith("/repo/one");
		error.mockRestore();
	});
});

describe("Git provider detection", () => {
	const three: Project = { ...PROJECT_ONE, id: "p3", name: "Three", path: "/repo/three" };

	it("detects each project without a provider once, not on every render", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		detector.autoDetectAndUpdateProject.mockImplementation(async (project: Project) => {
			if (project.id === "p3") throw new Error("no remote");
		});
		await renderApp({
			projects: [PROJECT_ONE, PROJECT_TWO, three],
			overrides: {
				getProjectEnv: async (id: string) => {
					if (id === "p1") return { success: true, data: { githubEnabled: true } };
					if (id === "p2") throw new Error("unreadable env");
					return { success: true, data: { githubEnabled: false } };
				},
			},
		});
		await waitFor(
			() =>
				expect(error).toHaveBeenCalledWith(
					"[App] Failed to auto-detect provider for project Three:",
					expect.any(Error),
				),
			{ timeout: 3000 },
		);
		const detected = () =>
			detector.autoDetectAndUpdateProject.mock.calls.map(
				([project]) => (project as Project).id,
			);
		expect(detected()).toEqual(["p2", "p3"]);

		// Re-renders (a dialog opening, the page changing) detect nothing more.
		await call("Sidebar", "onSettingsClick");
		await go("insights", true);
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(detected()).toEqual(["p2", "p3"]);
		error.mockRestore();
	});

	it("an Azure DevOps project needs no detection either", async () => {
		await renderApp({
			overrides: {
				getProjectEnv: async () => ({
					success: true,
					data: { azureDevOpsEnabled: true },
				}),
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(detector.autoDetectAndUpdateProject).not.toHaveBeenCalled();
	});
});

describe("the project tabs", () => {
	it("list the open projects and select, rename or configure one", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO] });
		expect(
			(stubProps("ProjectTabBar").projects as Project[]).map((p) => p.id),
		).toEqual(["p1", "p2"]);

		await call("ProjectTabBar", "onProjectRename", "p2", "Renamed");
		expect(api.fn("renameProject")).toHaveBeenCalledWith("p2", "Renamed");

		await call("ProjectTabBar", "onSettingsClick", "p2");
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialProjectId: "p2",
			initialProjectSection: "general",
		});

		await call("ProjectTabBar", "onAddProject");
		expect(stubProps("AddProjectModal").open).toBe(true);
	});

	it("dragging a tab shows it under the pointer and drops it in its new place", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO] });
		await call("DndContext", "onDragStart", { active: { id: "p2" } });
		expect(screen.getByTestId("stub-DragOverlay")).toHaveTextContent("Two");

		await call("DndContext", "onDragEnd", { active: { id: "p2" }, over: { id: "p1" } });
		expect(screen.getByTestId("stub-DragOverlay")).toHaveTextContent("");
		expect(
			(stubProps("ProjectTabBar").projects as Project[]).map((p) => p.id),
		).toEqual(["p2", "p1"]);
	});

	it("a drop outside the tabs, on itself or from elsewhere keeps the order", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO] });
		await call("DndContext", "onDragStart", { active: { id: "unknown" } });
		expect(screen.getByTestId("stub-DragOverlay")).toHaveTextContent("");
		for (const over of [null, { id: "p1" }, { id: "elsewhere" }]) {
			await call("DndContext", "onDragEnd", { active: { id: "p1" }, over });
		}
		expect(
			(stubProps("ProjectTabBar").projects as Project[]).map((p) => p.id),
		).toEqual(["p1", "p2"]);
	});
});

describe("removing a project", () => {
	it("asks first, and cancelling keeps it", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO] });
		await call("ProjectTabBar", "onProjectClose", "p2");
		expect(screen.getByText("Remove Project?")).toBeInTheDocument();
		expect(screen.getByText(/This will remove "Two"/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Remove Project?")).toBeNull();
		expect(api.fn("removeProject")).not.toHaveBeenCalled();
	});

	it("an unknown tab asks nothing", async () => {
		await renderApp();
		await call("ProjectTabBar", "onProjectClose", "nope");
		expect(screen.queryByText("Remove Project?")).toBeNull();
	});

	it("removing another project closes its tab and stays on the page", async () => {
		await renderApp({ projects: [PROJECT_ONE, PROJECT_TWO] });
		await go("insights", true);
		await screen.findByTestId("stub-Insights");
		await call("ProjectTabBar", "onProjectClose", "p2");
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));

		expect(api.fn("removeProject")).toHaveBeenCalledWith("p2");
		await waitFor(() => expect(screen.queryByText("Remove Project?")).toBeNull());
		expect(useProjectStore.getState().openProjectIds).not.toContain("p2");
		expect(screen.getByTestId("stub-Insights")).toBeInTheDocument();
	});

	it("removing the last project goes back to the Kanban", async () => {
		await renderApp();
		await go("insights", true);
		await screen.findByTestId("stub-Insights");
		await call("ProjectTabBar", "onProjectClose", "p1");
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(await screen.findByTestId("stub-NoProjectPage")).toBeInTheDocument();
	});

	it("a refused removal keeps the dialog open with the error", async () => {
		await renderApp({
			overrides: { removeProject: async () => ({ success: false }) },
		});
		await go("insights", true);
		await screen.findByTestId("stub-Insights");
		await call("ProjectTabBar", "onProjectClose", "p1");
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));

		expect(await screen.findByText("Failed to remove project")).toBeInTheDocument();
		expect(screen.getByText("Remove Project?")).toBeInTheDocument();
		expect(useProjectStore.getState().projects).toHaveLength(1);
		expect(screen.getByTestId("stub-Insights")).toBeInTheDocument();

		// Closing the dialog forgets the error.
		await userEvent.keyboard("{Escape}");
		await call("ProjectTabBar", "onProjectClose", "p1");
		expect(screen.queryByText("Failed to remove project")).toBeNull();
	});
});

describe("adding a project with Ctrl+T", () => {
	const added = { ...PROJECT_TWO, autoBuildPath: "" };

	it("picks a folder, opens it in a tab and its settings when it needs setup", async () => {
		await renderApp({
			overrides: {
				selectDirectory: async () => "/repo/two",
				addProject: async () => ({ success: true, data: added }),
			},
		});
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		await waitFor(() =>
			expect(stubProps("AppSettingsDialog")).toMatchObject({
				open: true,
				initialProjectId: "p2",
			}),
		);
		expect(api.fn("addProject")).toHaveBeenCalledWith("/repo/two");
		expect(useProjectStore.getState().openProjectIds).toContain("p2");
	});

	it("a ready project only opens its tab", async () => {
		await renderApp({
			overrides: {
				selectDirectory: async () => "/repo/two",
				addProject: async () => ({ success: true, data: PROJECT_TWO }),
			},
		});
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", metaKey: true });
		});
		await waitFor(() =>
			expect(useProjectStore.getState().openProjectIds).toContain("p2"),
		);
		expect(stubProps("AppSettingsDialog").open).toBe(false);
	});

	it("warns about a folder that is not the git root, in the app's language", async () => {
		await renderApp({
			settings: { language: "fr" },
			overrides: {
				selectDirectory: async () => "/repo/two/sub",
				addProject: async () => ({
					success: true,
					data: PROJECT_TWO,
					warning: "Le dépôt git est dans /repo/two.",
				}),
			},
		});
		await waitFor(() => expect(i18n.language).toBe("fr"));
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		expect(
			await screen.findByText("Configuration peut-être incorrecte"),
		).toBeInTheDocument();
		expect(screen.getByText("Le dépôt git est dans /repo/two.")).toBeInTheDocument();
	});

	it("does nothing in a text field, on the terminals, without a folder or on a failure", async () => {
		const selectDirectory = vi.fn(async () => null);
		await renderApp({ overrides: { selectDirectory } });

		const input = document.createElement("input");
		document.body.append(input);
		await act(async () => {
			fireEvent.keyDown(input, { key: "t", ctrlKey: true });
		});
		input.remove();
		await act(async () => {
			fireEvent.keyDown(window, { key: "t" });
			fireEvent.keyDown(window, { key: "x", ctrlKey: true });
		});
		expect(selectDirectory).not.toHaveBeenCalled();

		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		expect(selectDirectory).toHaveBeenCalledOnce();
		expect(api.fn("addProject")).not.toHaveBeenCalled();

		selectDirectory.mockRejectedValueOnce(new Error("dialog failed"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		expect(error).toHaveBeenCalledWith("Failed to add project:", expect.any(Error));
		error.mockRestore();

		await go("terminals", true);
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		expect(selectDirectory).toHaveBeenCalledTimes(2);
	});

	it("a refused folder opens nothing", async () => {
		await renderApp({
			overrides: {
				selectDirectory: async () => "/repo/x",
				addProject: async () => ({ success: false, error: "nope" }),
			},
		});
		await act(async () => {
			fireEvent.keyDown(window, { key: "t", ctrlKey: true });
		});
		await waitFor(() => expect(api.fn("addProject")).toHaveBeenCalled());
		expect(stubProps("AppSettingsDialog").open).toBe(false);
	});
});

describe("settings", () => {
	it("an open-app-settings event opens the dialog, on a section when it names one", async () => {
		await renderApp();
		act(() => {
			globalThis.dispatchEvent(new CustomEvent("open-app-settings"));
		});
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialSection: undefined,
		});
		act(() => {
			globalThis.dispatchEvent(
				new CustomEvent("open-app-settings", { detail: "accounts" }),
			);
		});
		expect(stubProps("AppSettingsDialog").initialSection).toBe("accounts");
	});

	it("a downloaded update opens the updates section", async () => {
		let onDownloaded: () => void = () => undefined;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await renderApp({
			overrides: {
				onAppUpdateDownloaded: (callback: () => void) => {
					onDownloaded = callback;
					return () => undefined;
				},
			},
		});
		act(() => onDownloaded());
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialSection: "updates",
		});
		warn.mockRestore();
	});

	it("the setup hub opens from settings and sends back to a section", async () => {
		await renderApp();
		const navigated: unknown[] = [];
		const listener = (e: Event) => navigated.push((e as CustomEvent).detail);
		window.addEventListener("app-settings:navigate", listener);

		await call("AppSettingsDialog", "onOpenSetupHub");
		expect(useSetupHubStore.getState().isOpen).toBe(true);
		expect(stubProps("SetupHub").open).toBe(true);

		await call("SetupHub", "onOpenSettingsSection", { kind: "project", section: "github" });
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			open: true,
			initialProjectSection: "github",
			initialSection: undefined,
		});
		await call("AuthFailureModal", "onOpenSettings");
		expect(stubProps("AppSettingsDialog")).toMatchObject({
			initialSection: "accounts",
			initialProjectSection: undefined,
		});
		await waitFor(() =>
			expect(navigated).toEqual([
				{ projectSection: "github" },
				{ section: "accounts" },
			]),
		);
		window.removeEventListener("app-settings:navigate", listener);
		await call("SetupHub", "onOpenChange", false);
		expect(useSetupHubStore.getState().isOpen).toBe(false);
	});

	it("rerunning the wizard reopens the onboarding", async () => {
		await renderApp();
		await call("AppSettingsDialog", "onRerunWizard");
		expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(false);
		expect(stubProps("OnboardingWizard").open).toBe(true);
		expect(stubProps("AppSettingsDialog").open).toBe(false);
	});
});

describe("first run", () => {
	it("opens the onboarding when nothing is set up", async () => {
		await renderApp({ settings: { onboardingCompleted: false } });
		await waitFor(() => expect(stubProps("OnboardingWizard").open).toBe(true));

		await call("OnboardingWizard", "onOpenTaskCreator");
		expect(stubProps("TaskCreationWizard").open).toBe(true);
		await call("OnboardingWizard", "onOpenSettings");
		expect(stubProps("OnboardingWizard").open).toBe(false);
		expect(stubProps("AppSettingsDialog").open).toBe(true);
		await call("OnboardingWizard", "onOpenChange", true);
		expect(stubProps("OnboardingWizard").open).toBe(true);
	});

	it("does not open it once onboarding is done", async () => {
		await renderApp();
		expect(stubProps("OnboardingWizard").open).toBe(false);
	});

	it("speaks the desktop's language until one is chosen", async () => {
		vi.stubGlobal("navigator", { languages: ["fr-FR"], language: "fr-FR" });
		await renderApp({ settings: { language: undefined } });
		await waitFor(() =>
			expect(api.fn("saveSettings")).toHaveBeenCalledWith({ language: "fr" }),
		);
		await waitFor(() => expect(i18n.language).toBe("fr"));
	});

	it("tells the spell checker the language, and survives its refusal", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await renderApp({
			overrides: {
				setSpellCheckLanguages: vi
					.fn()
					.mockResolvedValueOnce({ success: false, error: "no dictionary" })
					.mockRejectedValue(new Error("gone")),
			},
		});
		expect(api.fn("setSpellCheckLanguages")).toHaveBeenCalledWith("en");
		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[App] Failed to set spell check language:",
				"no dictionary",
			),
		);
		await act(async () => {
			await i18n.changeLanguage("fr");
		});
		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[App] Error syncing spell check language:",
				expect.any(Error),
			),
		);
		warn.mockRestore();
	});

	it("shows the 2.7.5 sign-in notice once", async () => {
		await renderApp({ overrides: { getAppVersion: async () => "2.7.5" } });
		await waitFor(() =>
			expect(stubProps("VersionWarningModal").isOpen).toBe(true),
		);
		await call("VersionWarningModal", "onClose");
		expect(stubProps("VersionWarningModal").isOpen).toBe(false);
		expect(api.fn("saveSettings")).toHaveBeenCalledWith({
			seenVersionWarnings: ["2.7.5"],
		});
	});

	it("never shows the notice again once seen, or on a failed version read", async () => {
		await renderApp({
			settings: { seenVersionWarnings: ["2.7.5"] },
			overrides: { getAppVersion: async () => "2.7.5" },
		});
		await call("VersionWarningModal", "onClose");
		expect(stubProps("VersionWarningModal").isOpen).toBe(false);
		expect(api.fn("saveSettings")).not.toHaveBeenCalledWith(
			expect.objectContaining({ seenVersionWarnings: expect.anything() }),
		);
	});

	it("a failed version read shows nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await renderApp({
			overrides: {
				getAppVersion: async () => {
					throw new Error("no version");
				},
			},
		});
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"Failed to check version warning:",
				expect.any(Error),
			),
		);
		expect(stubProps("VersionWarningModal").isOpen).toBe(false);
		error.mockRestore();
	});
});

describe("server mode", () => {
	it("a server session that is not signed in shows the login screen", async () => {
		await renderApp({
			overrides: {
				serverAuth: {
					restore: async () => ({
						mode: "server",
						configured: true,
						isAuthenticated: false,
					}),
					onStateChanged: () => () => undefined,
				},
			},
		});
		expect(screen.getByTestId("stub-ServerLoginScreen")).toBeInTheDocument();
	});

	it("an open-server-login event shows it on demand", async () => {
		await renderApp();
		expect(screen.queryByTestId("stub-ServerLoginScreen")).toBeNull();
		act(() => {
			window.dispatchEvent(new Event("workpilot:open-server-login"));
		});
		expect(screen.getByTestId("stub-ServerLoginScreen")).toBeInTheDocument();
	});
});

describe("appearance", () => {
	const root = document.documentElement;

	it("applies the dark, light or system theme", async () => {
		await renderApp({ settings: { theme: "dark" } });
		expect(root).toHaveClass("dark");
		act(() => useSettingsStore.getState().updateSettings({ theme: "light" }));
		expect(root).not.toHaveClass("dark");

		prefersDark = true;
		act(() => useSettingsStore.getState().updateSettings({ theme: "system" }));
		expect(root).toHaveClass("dark");

		// The system switching to light follows it.
		prefersDark = false;
		act(() => {
			for (const listener of mediaListeners) listener();
		});
		expect(root).not.toHaveClass("dark");
	});

	it("a system change is ignored under an explicit theme", async () => {
		await renderApp({ settings: { theme: "dark" } });
		act(() => {
			for (const listener of mediaListeners) listener();
		});
		expect(root).toHaveClass("dark");
	});

	it("applies a known colour theme and falls back from an unknown one", async () => {
		await renderApp({ settings: { colorTheme: "ocean" } });
		expect(root.dataset.theme).toBe("ocean");
		act(() =>
			useSettingsStore.getState().updateSettings({ colorTheme: "nope" as never }),
		);
		expect(root.dataset.theme).toBeUndefined();
	});

	it("clamps the interface scale", async () => {
		await renderApp({ settings: { uiScale: 500 } });
		const max = Number(root.dataset.uiScale);
		act(() => useSettingsStore.getState().updateSettings({ uiScale: 1 }));
		const min = Number(root.dataset.uiScale);
		act(() => useSettingsStore.getState().updateSettings({ uiScale: undefined }));
		const byDefault = Number(root.dataset.uiScale);
		expect(min).toBeLessThan(byDefault);
		expect(byDefault).toBeLessThan(max);
		expect(max).toBeLessThan(500);
	});
});
