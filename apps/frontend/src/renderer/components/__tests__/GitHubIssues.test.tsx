/**
 * The GitHub Issues view: connection, the list (filter, search, pages), the
 * detail of an issue, and the auto-fix of a single issue. The stores are the
 * real ones; the main process is a fake that answers like it.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "../../../shared/types";
import { useInvestigationStore, useIssuesStore, useSyncStatusStore } from "../../stores/github";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { GitHubIssues } from "../GitHubIssues";

const seen = vi.hoisted(() => ({
	investigation: {} as Record<string, unknown>,
	wizard: {} as Record<string, unknown>,
	setup: {} as Record<string, unknown>,
}));

vi.mock("../github-issues/components/InvestigationDialog", () => ({
	InvestigationDialog: (props: Record<string, unknown>) => {
		seen.investigation = props;
		return props.open ? <div data-testid="investigation" /> : null;
	},
}));
vi.mock("../github-issues/components/BatchReviewWizard", () => ({
	BatchReviewWizard: (props: Record<string, unknown>) => {
		seen.wizard = props;
		return props.isOpen ? <div data-testid="wizard" /> : null;
	},
}));
vi.mock("../GitHubSetupModal", () => ({
	GitHubSetupModal: (props: Record<string, unknown>) => {
		seen.setup = props;
		return props.open ? <div data-testid="setup" /> : null;
	},
}));

function issue(number: number, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
	return {
		id: 1000 + number,
		number,
		title: `Issue ${number}`,
		body: `Body of ${number}`,
		state: "open",
		labels: [],
		assignees: [],
		author: { login: "ana" },
		createdAt: "2026-11-01T10:00:00Z",
		updatedAt: "2026-11-01T10:00:00Z",
		commentsCount: 0,
		url: "",
		htmlUrl: `https://github.com/acme/app/issues/${number}`,
		repoFullName: "acme/app",
		...overrides,
	};
}

const ISSUES = [
	issue(1, {
		title: "Crash on save",
		body: "Saving **crashes**",
		commentsCount: 1,
		labels: [{ id: 7, name: "bug", color: "ff0000" }],
		assignees: [{ login: "bo" }],
		milestone: { id: 1, title: "v2", state: "open" },
	}),
	issue(2, { title: "Dark mode", body: undefined, commentsCount: 3 }),
	issue(3, { title: "Old one", state: "closed" }),
];

type Listener = (...args: unknown[]) => void;
let listeners: Record<string, Listener[]>;
const on = (name: string) =>
	vi.fn((cb: Listener) => {
		listeners[name] = [...(listeners[name] ?? []), cb];
		return () => {
			listeners[name] = (listeners[name] ?? []).filter((l) => l !== cb);
		};
	});
const emit = (name: string, ...args: unknown[]) =>
	act(() => {
		for (const cb of listeners[name] ?? []) cb(...args);
	});

function makeApi() {
	return {
		checkGitHubConnection: vi.fn(),
		getGitHubIssues: vi.fn(),
		importGitHubIssues: vi.fn(),
		getTasks: vi.fn(),
		investigateGitHubIssue: vi.fn(),
		onGitHubInvestigationProgress: on("investigationProgress"),
		onGitHubInvestigationComplete: on("investigationComplete"),
		onGitHubInvestigationError: on("investigationError"),
	};
}
function makeGithub() {
	return {
		getAutoFixConfig: vi.fn(),
		getAutoFixQueue: vi.fn(),
		getBatches: vi.fn(),
		saveAutoFixConfig: vi.fn(),
		startAutoFix: vi.fn(),
		checkNewIssues: vi.fn(),
		batchAutoFix: vi.fn(),
		analyzeIssuesPreview: vi.fn(),
		approveBatches: vi.fn(),
		onAutoFixProgress: on("autoFixProgress"),
		onAutoFixComplete: on("autoFixComplete"),
		onAutoFixError: on("autoFixError"),
		onBatchProgress: on("batchProgress"),
		onBatchComplete: on("batchComplete"),
		onBatchError: on("batchError"),
		onAnalyzePreviewProgress: on("previewProgress"),
		onAnalyzePreviewComplete: on("previewComplete"),
		onAnalyzePreviewError: on("previewError"),
	};
}
let api: ReturnType<typeof makeApi>;
let github: ReturnType<typeof makeGithub>;

let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

beforeAll(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(cb: typeof intersect) {
				intersect = cb;
			}
			observe() {
				// jsdom lays nothing out: nothing to watch.
			}
			disconnect() {
				// Nothing was watched.
			}
		},
	);
});

afterAll(() => vi.unstubAllGlobals());

const AUTO_FIX = {
	enabled: true,
	labels: ["autofix"],
	requireHumanApproval: true,
	model: "sonnet",
	thinkingLevel: "low",
};

function renderView(props: Partial<React.ComponentProps<typeof GitHubIssues>> = {}) {
	return render(<GitHubIssues {...props} />);
}

const row = (title: string) => screen.getByText(title).closest("div.group") as HTMLElement;
const detail = (title = "Crash on save") =>
	screen.getByRole("heading", { level: 2, name: title }).closest("div.p-4") as HTMLElement;

describe("GitHubIssues", () => {
	beforeEach(() => {
		listeners = {};
		intersect = null;
		api = makeApi();
		github = makeGithub();
		api.checkGitHubConnection.mockResolvedValue({
			success: true,
			data: { connected: true, repoFullName: "acme/app" },
		});
		api.getGitHubIssues.mockResolvedValue({ success: true, data: { issues: ISSUES, hasMore: false } });
		api.getTasks.mockResolvedValue({ success: true, data: [] });
		github.getAutoFixConfig.mockResolvedValue(null);
		github.getAutoFixQueue.mockResolvedValue([]);
		github.getBatches.mockResolvedValue([]);
		github.checkNewIssues.mockResolvedValue([]);
		github.saveAutoFixConfig.mockResolvedValue(true);
		Object.assign(globalThis.electronAPI, api, { github });
		useProjectStore.setState({
			projects: [{ id: "p1", name: "app", path: "/work/app" }] as never,
			selectedProjectId: "p1",
		});
		useTaskStore.setState({ tasks: [] });
		useSyncStatusStore.setState({ syncStatus: null, connectionError: null });
		useIssuesStore.setState({
			issues: [],
			selectedIssueNumber: null,
			filterState: "open",
			error: null,
			isLoading: false,
			isLoadingMore: false,
			hasMore: true,
			currentPage: 1,
		});
		useInvestigationStore.setState({
			investigationStatus: { phase: "idle", progress: 0, message: "" },
			lastInvestigationResult: null,
		} as never);
	});

	it("asks to connect GitHub until the project is connected", async () => {
		const onOpenSettings = vi.fn();
		api.checkGitHubConnection.mockResolvedValue({ success: false, error: "No token" });
		renderView({ onOpenSettings });

		expect(await screen.findByText("No token")).toBeInTheDocument();
		expect(screen.getByText("GitHub Not Connected")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
		expect(onOpenSettings).toHaveBeenCalled();
		expect(api.getGitHubIssues).not.toHaveBeenCalled();
	});

	it("forgets the last status when the check fails", async () => {
		// The last status read was another project's.
		useSyncStatusStore.setState({ syncStatus: { connected: true, repoFullName: "old/repo" } as never });
		api.checkGitHubConnection.mockRejectedValue(new Error("IPC down"));
		renderView();

		expect(await screen.findByText("IPC down")).toBeInTheDocument();
		expect(screen.queryByText("old/repo")).not.toBeInTheDocument();
	});

	it("lists the open issues of the repository", async () => {
		renderView();

		expect(await screen.findByText("Crash on save")).toBeInTheDocument();
		expect(screen.getByText("acme/app")).toBeInTheDocument();
		expect(screen.getByText("2 open")).toBeInTheDocument();
		expect(api.getGitHubIssues).toHaveBeenCalledTimes(1);
		expect(api.getGitHubIssues).toHaveBeenCalledWith("p1", "open", 1, false);
		// The closed one is not shown under "Open".
		expect(screen.queryByText("Old one")).not.toBeInTheDocument();
		expect(within(row("Crash on save")).getByText("Open")).toBeInTheDocument();
		expect(screen.getByText("Select an issue to view details")).toBeInTheDocument();
	});

	it("shows an issue with what it holds", async () => {
		renderView();
		await userEvent.click(await screen.findByText("Crash on save"));

		expect(within(detail()).getByText("#1")).toBeInTheDocument();
		expect(within(detail()).getByText("1 comment")).toBeInTheDocument();
		expect(within(detail()).getByText("bug")).toBeInTheDocument();
		expect(within(detail()).getByText("crashes").tagName).toBe("STRONG");
		expect(within(detail()).getByText("bo")).toBeInTheDocument();
		expect(within(detail()).getByText("v2")).toBeInTheDocument();
		expect(within(detail()).getByRole("link", { name: /Open on GitHub/ })).toHaveAttribute(
			"href",
			"https://github.com/acme/app/issues/1",
		);

		await userEvent.click(screen.getByText("Dark mode"));
		expect(screen.getByText("3 comments")).toBeInTheDocument();
		expect(screen.getByText("No description provided.")).toBeInTheDocument();
	});

	it("loads every issue once while searching, and pages again once cleared", async () => {
		renderView();
		await screen.findByText("Crash on save");
		api.getGitHubIssues.mockClear();

		await userEvent.type(screen.getByRole("textbox", { name: "Search issues..." }), "dark");

		await waitFor(() => expect(api.getGitHubIssues).toHaveBeenCalledWith("p1", "open", 1, true));
		expect(api.getGitHubIssues).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Dark mode")).toBeInTheDocument();
		expect(screen.queryByText("Crash on save")).not.toBeInTheDocument();

		await userEvent.type(screen.getByRole("textbox", { name: "Search issues..." }), "zzz");
		expect(screen.getByText("No issues found")).toBeInTheDocument();

		await userEvent.clear(screen.getByRole("textbox", { name: "Search issues..." }));
		await waitFor(() => expect(api.getGitHubIssues).toHaveBeenLastCalledWith("p1", "open", 1, false));
		expect(api.getGitHubIssues).toHaveBeenCalledTimes(2);
	});

	it("filters by state", async () => {
		renderView();
		await screen.findByText("Crash on save");
		const filter = screen.getByRole("combobox", { name: "Show issues" });
		act(() => filter.focus());
		await userEvent.keyboard("[ArrowDown]");
		await userEvent.click(await screen.findByRole("option", { name: "Closed" }));

		await waitFor(() => expect(api.getGitHubIssues).toHaveBeenLastCalledWith("p1", "closed", 1, false));
		expect(await screen.findByText("Old one")).toBeInTheDocument();
		expect(within(row("Old one")).getByText("Closed")).toBeInTheDocument();
	});

	it("loads the next page when the end of the list comes into view", async () => {
		api.getGitHubIssues.mockResolvedValueOnce({ success: true, data: { issues: ISSUES, hasMore: true } });
		api.getGitHubIssues.mockResolvedValueOnce({
			success: true,
			data: { issues: [issue(4, { title: "Fourth" })], hasMore: false },
		});
		renderView();
		expect(await screen.findByText("Scroll for more")).toBeInTheDocument();

		await act(async () => intersect?.([{ isIntersecting: true }]));

		expect(await screen.findByText("Fourth")).toBeInTheDocument();
		expect(api.getGitHubIssues).toHaveBeenLastCalledWith("p1", "open", 2, false);
		expect(screen.getByText("All issues loaded")).toBeInTheDocument();
	});

	it("says when there are no issues, and when they cannot be read", async () => {
		api.getGitHubIssues.mockResolvedValueOnce({ success: true, data: { issues: [], hasMore: false } });
		const { unmount } = renderView();
		expect(await screen.findByText("No issues found")).toBeInTheDocument();
		unmount();

		api.getGitHubIssues.mockResolvedValueOnce({ success: false, error: "Rate limited" });
		renderView();
		expect(await screen.findByText("Rate limited")).toBeInTheDocument();
	});

	it("refreshes the connection and the list, and looks for new issues to fix", async () => {
		github.getAutoFixConfig.mockResolvedValue(AUTO_FIX);
		github.checkNewIssues.mockResolvedValue([{ number: 9 }]);
		renderView();
		await screen.findByText("Crash on save");

		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

		await waitFor(() => expect(github.startAutoFix).toHaveBeenCalledWith("p1", 9));
		expect(api.checkGitHubConnection).toHaveBeenCalledTimes(2);
	});

	it("opens the task form for an issue, from its row or its detail", async () => {
		renderView();
		await userEvent.click(await screen.findByText("Crash on save"));
		await userEvent.click(within(row("Dark mode")).getByRole("button", { name: "Create Task" }));

		expect(screen.getByTestId("investigation")).toBeInTheDocument();
		expect((seen.investigation.selectedIssue as GitHubIssue).number).toBe(2);
		act(() => (seen.investigation.onStartInvestigation as (ids: number[]) => void)([11]));
		expect(globalThis.electronAPI).toBeDefined();

		// Closing while it runs keeps its progress; closing after it ended resets it.
		act(() => (seen.investigation.onOpenChange as (open: boolean) => void)(false));
		expect(screen.queryByTestId("investigation")).not.toBeInTheDocument();
		await userEvent.click(within(detail()).getByRole("button", { name: "Create Task" }));
		expect((seen.investigation.selectedIssue as GitHubIssue).number).toBe(1);
		act(() => (seen.investigation.onOpenChange as (open: boolean) => void)(true));
		emit("investigationError", "p1", "model refused");
		act(() => (seen.investigation.onOpenChange as (open: boolean) => void)(false));
		expect(useInvestigationStore.getState().investigationStatus.phase).toBe("idle");
	});

	it("links an issue to the task created from it", async () => {
		const onNavigateToTask = vi.fn();
		renderView({ onNavigateToTask });
		await userEvent.click(await screen.findByText("Crash on save"));

		emit("investigationComplete", "p1", {
			success: true,
			issueNumber: 1,
			taskId: "task-42",
			analysis: { summary: "Null check missing", estimatedComplexity: "simple" },
		});

		expect(await screen.findByText("Task Linked")).toBeInTheDocument();
		expect(screen.getByText("Null check missing")).toBeInTheDocument();
		expect(screen.getByText("Simple")).toBeInTheDocument();
		expect(screen.getByText("Task ID: task-42")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "View Task" }));
		expect(onNavigateToTask).toHaveBeenCalledWith("task-42");
	});

	it("shows the task an issue already has", async () => {
		useTaskStore.setState({ tasks: [{ id: "t1", specId: "007-dark", metadata: { githubIssueNumber: 2 } }] as never });
		renderView();
		await userEvent.click(await screen.findByText("Dark mode"));
		expect(screen.getByText("Task ID: 007-dark")).toBeInTheDocument();
	});

	it("auto-fixes an issue and follows its progress", async () => {
		github.getAutoFixConfig.mockResolvedValue(AUTO_FIX);
		renderView();
		await userEvent.click(await screen.findByText("Crash on save"));

		await userEvent.click(await screen.findByRole("button", { name: "Auto Fix" }));
		expect(github.startAutoFix).toHaveBeenCalledWith("p1", 1);
		expect(screen.getByText("Processing...")).toBeInTheDocument();

		// Events of another issue or project are not this one's.
		emit("autoFixProgress", "p1", { issueNumber: 2, phase: "building", progress: 10, message: "other" });
		emit("autoFixProgress", "p2", { issueNumber: 1, phase: "building", progress: 10, message: "other" });
		expect(screen.queryByText("other")).not.toBeInTheDocument();

		emit("autoFixProgress", "p1", { issueNumber: 1, phase: "building", progress: 40, message: "Building" });
		expect(screen.getByText("Building")).toBeInTheDocument();
		expect(screen.getByRole("progressbar")).toBeInTheDocument();

		emit("autoFixError", "p1", { issueNumber: 1, error: "Spec failed" });
		expect(screen.getByText("Spec failed")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Retry Auto Fix" }));
		expect(github.startAutoFix).toHaveBeenCalledTimes(2);

		emit("autoFixComplete", "p1", { issueNumber: 1, status: "completed" });
		expect(screen.getByText("Spec created from issue")).toBeInTheDocument();
	});

	it("shows the auto-fix state the queue already holds", async () => {
		github.getAutoFixConfig.mockResolvedValue(AUTO_FIX);
		github.getAutoFixQueue.mockResolvedValue([
			{ issueNumber: 1, repo: "acme/app", status: "failed", error: "Queue said no" },
			{ issueNumber: 2, repo: "acme/app", status: "building" },
		]);
		renderView();
		await userEvent.click(await screen.findByText("Crash on save"));
		expect(await screen.findByText("Queue said no")).toBeInTheDocument();

		await userEvent.click(screen.getByText("Dark mode"));
		expect(screen.getByText("Processing...")).toBeInTheDocument();
	});

	it("turns auto-fix of new issues on", async () => {
		github.getAutoFixConfig.mockResolvedValue({ ...AUTO_FIX, enabled: false });
		renderView();
		await screen.findByText("Crash on save");

		await userEvent.click(await screen.findByRole("switch", { name: "Auto-Fix New" }));

		await waitFor(() =>
			expect(github.saveAutoFixConfig).toHaveBeenCalledWith("p1", { ...AUTO_FIX, enabled: true }),
		);
		expect(screen.getByRole("switch", { name: "Auto-Fix New" })).toBeChecked();
	});

	it("groups issues in the wizard and sets up GitHub when the module is missing", async () => {
		renderView();
		await screen.findByText("Crash on save");

		await userEvent.click(screen.getByRole("button", { name: "Analyze & Group Issues" }));
		expect(screen.getByTestId("wizard")).toBeInTheDocument();
		act(() => (seen.wizard.onStartAnalysis as () => void)());
		expect(github.analyzeIssuesPreview).toHaveBeenCalledWith("p1", undefined, 200);

		emit("previewError", "p1", { error: "GitHub automation module not installed" });
		expect(await screen.findByTestId("setup")).toBeInTheDocument();
		act(() => (seen.setup.onComplete as () => void)());
		expect(screen.queryByTestId("setup")).not.toBeInTheDocument();
		expect(github.analyzeIssuesPreview).toHaveBeenCalledTimes(2);

		act(() => (seen.setup.onOpenChange as (open: boolean) => void)(true));
		act(() => (seen.setup.onSkip as () => void)());
		expect(screen.queryByTestId("setup")).not.toBeInTheDocument();
	});

	it("turns an issue of a server project into a card of its board", async () => {
		const onNavigateToTask = vi.fn();
		useProjectStore.setState({
			projects: [{ id: "p1", name: "app", path: "", remote: { serverUrl: "https://s" } }] as never,
		});
		api.importGitHubIssues.mockResolvedValue({
			success: true,
			data: { tasks: [{ id: "card-5", title: "Crash on save" }] },
		});
		renderView({ onNavigateToTask });
		await userEvent.click(await screen.findByText("Crash on save"));

		// No local agents for a server project.
		expect(screen.queryByRole("button", { name: "Analyze & Group Issues" })).not.toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();

		await userEvent.click(within(detail()).getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(onNavigateToTask).toHaveBeenCalledWith("card-5"));
		expect(api.importGitHubIssues).toHaveBeenCalledWith("p1", [1]);
		expect(screen.queryByTestId("investigation")).not.toBeInTheDocument();
		expect(await screen.findByText("Task ID: card-5")).toBeInTheDocument();
	});
});
