/**
 * The GitLab Issues view: not connected, the list and the detail of an issue,
 * the task already linked to an issue, and « Create Task », which opens the
 * investigation of a local project or makes a card of a server project's
 * board. The stores and the components are the real ones; the main process
 * is a fake that answers like it.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLabIssue, Project, Task } from "../../../shared/types";
import i18n from "../../../shared/i18n";
import { useGitLabStore } from "../../stores/gitlab-store";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { GitLabIssues } from "../GitLabIssues";

function issue(iid: number, overrides: Partial<GitLabIssue> = {}): GitLabIssue {
	return {
		id: 500 + iid,
		iid,
		title: `Issue ${iid}`,
		description: `Body of ${iid}`,
		state: "opened",
		labels: [],
		assignees: [],
		author: { username: "ana" },
		createdAt: "2026-11-01T10:00:00Z",
		updatedAt: "2026-11-01T10:00:00Z",
		userNotesCount: 0,
		webUrl: `https://gitlab.example.com/acme/app/-/issues/${iid}`,
		projectPathWithNamespace: "acme/app",
		...overrides,
	};
}

const ISSUES = [
	issue(1, { title: "Crash on save" }),
	issue(2, { title: "Dark mode" }),
	issue(3, { title: "Slow search" }),
];

const PROJECT: Project = {
	id: "p1",
	name: "App",
	path: "/work/app",
	autoBuildPath: "",
	settings: {},
	createdAt: new Date("2026-11-01T10:00:00Z"),
	updatedAt: new Date("2026-11-01T10:00:00Z"),
} as Project;

type Api = Record<string, ReturnType<typeof vi.fn>>;
let api: Api;

function installApi(overrides: Api = {}) {
	api = {
		checkGitLabConnection: vi.fn().mockResolvedValue({
			success: true,
			data: { connected: true, projectPathWithNamespace: "acme/app" },
		}),
		getGitLabIssues: vi.fn().mockResolvedValue({ success: true, data: ISSUES }),
		getGitLabIssueNotes: vi.fn().mockResolvedValue({
			success: true,
			data: [
				{ id: 71, body: "Seen on Linux too", system: false, author: { username: "bo" }, createdAt: "2026-11-02T10:00:00Z" },
			],
		}),
		investigateGitLabIssue: vi.fn(),
		importGitLabIssues: vi.fn(),
		...overrides,
	};
	(globalThis as { electronAPI?: unknown }).electronAPI = new Proxy(api, {
		get: (target, key: string) => target[key] ?? vi.fn(() => () => undefined),
	});
}

function selectProject(project: Project = PROJECT) {
	useProjectStore.setState({ projects: [project], selectedProjectId: project.id });
}

function renderView(props: Parameters<typeof GitLabIssues>[0] = {}) {
	return render(<GitLabIssues {...props} />);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useGitLabStore.setState({
		issues: [],
		syncStatus: null,
		isLoading: false,
		error: null,
		selectedIssueIid: null,
		filterState: "opened",
		investigationStatus: { phase: "idle", progress: 0, message: "" },
		lastInvestigationResult: null,
	});
	useTaskStore.setState({ tasks: [] });
	installApi();
	selectProject();
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("GitLabIssues — not connected", () => {
	it("says why GitLab is not connected and opens the settings", async () => {
		installApi({
			checkGitLabConnection: vi.fn().mockResolvedValue({
				success: true,
				data: { connected: false, error: "The token was refused" },
			}),
		});
		const onOpenSettings = vi.fn();
		renderView({ onOpenSettings });
		expect(await screen.findByText("The token was refused")).toBeInTheDocument();
		expect(screen.getByText("GitLab Not Connected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(api.getGitLabIssues).not.toHaveBeenCalled();
	});

	it("explains what to configure when nothing went wrong", async () => {
		installApi({
			checkGitLabConnection: vi.fn().mockResolvedValue({
				success: true,
				data: { connected: false },
			}),
		});
		renderView();
		expect(
			await screen.findByText(
				"Configure your GitLab token and project in project settings to sync issues.",
			),
		).toBeInTheDocument();
	});
});

describe("GitLabIssues — a local project", () => {
	it("lists the issues, then shows the one picked", async () => {
		renderView();
		expect(await screen.findByText("acme/app")).toBeInTheDocument();
		expect(await screen.findByText("Crash on save")).toBeInTheDocument();
		expect(screen.getByText("Select an issue to view details")).toBeInTheDocument();
		expect(api.getGitLabIssues).toHaveBeenCalledWith("p1", "opened");

		fireEvent.click(screen.getByRole("button", { name: /Dark mode/ }));
		expect(await screen.findByText("Body of 2")).toBeInTheDocument();
		expect(screen.queryByText("Select an issue to view details")).not.toBeInTheDocument();
	});

	it("names no project path when GitLab gave none", async () => {
		installApi({
			checkGitLabConnection: vi.fn().mockResolvedValue({
				success: true,
				data: { connected: true },
			}),
		});
		renderView();
		expect(await screen.findByText("Crash on save")).toBeInTheDocument();
		expect(screen.queryByText("acme/app")).not.toBeInTheDocument();
	});

	it("opens the task already made from an issue, by its spec when it has one", async () => {
		useTaskStore.setState({
			tasks: [
				{ id: "t1", specId: "001-crash", metadata: { gitlabIssueIid: 1 } },
				{ id: "t2", specId: "", metadata: { gitlabIssueIid: 2 } },
				{ id: "t3", specId: "003-other" },
			] as unknown as Task[],
		});
		const onNavigateToTask = vi.fn();
		renderView({ onNavigateToTask });

		fireEvent.click(await screen.findByRole("button", { name: /Crash on save/ }));
		fireEvent.click(await screen.findByRole("button", { name: "View Task" }));
		expect(onNavigateToTask).toHaveBeenLastCalledWith("001-crash");

		fireEvent.click(screen.getByRole("button", { name: /Dark mode/ }));
		fireEvent.click(await screen.findByRole("button", { name: "View Task" }));
		expect(onNavigateToTask).toHaveBeenLastCalledWith("t2");

		fireEvent.click(screen.getByRole("button", { name: /Slow search/ }));
		expect(await screen.findByRole("button", { name: "Create Task" })).toBeInTheDocument();
	});

	it("shows the investigation of the issue picked, not of another one", async () => {
		const result = {
			success: true,
			issueIid: 1,
			taskId: "t-new",
			analysis: {
				summary: "Save fails on a full disk",
				proposedSolution: "",
				affectedFiles: [],
				estimatedComplexity: "simple" as const,
				acceptanceCriteria: [],
			},
		};
		useGitLabStore.setState({ lastInvestigationResult: result });
		renderView();

		fireEvent.click(await screen.findByRole("button", { name: /Crash on save/ }));
		expect(await screen.findByText("Save fails on a full disk")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Dark mode/ }));
		await screen.findByText("Body of 2");
		expect(screen.queryByText("Save fails on a full disk")).not.toBeInTheDocument();
	});

	it("creates a task from an issue with the notes it keeps", async () => {
		renderView();
		await screen.findByText("Crash on save");
		const row = screen.getByRole("button", { name: /Crash on save/ });
		fireEvent.click(within(row).getByRole("button", { name: "Investigate issue" }));

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Create Task from Issue")).toBeInTheDocument();
		expect(await within(dialog).findByText("Seen on Linux too")).toBeInTheDocument();
		expect(api.getGitLabIssueNotes).toHaveBeenCalledWith("p1", 1);

		fireEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));
		expect(api.investigateGitLabIssue).toHaveBeenCalledWith("p1", 1, [71]);
		expect(useGitLabStore.getState().investigationStatus.phase).toBe("fetching");
	});

	it("opens the investigation from the detail too, and closes it clean", async () => {
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: /Dark mode/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Create Task" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/Dark mode/)).toBeInTheDocument();

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("puts the investigation back to idle when its dialog is closed", async () => {
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: /Dark mode/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Create Task" }));
		const dialog = await screen.findByRole("dialog");
		useGitLabStore.setState({
			investigationStatus: { phase: "error", progress: 0, message: "", error: "agent crashed" },
		});
		expect(await within(dialog).findByText("agent crashed")).toBeInTheDocument();
		// The footer's « Close », not the dialog's corner cross
		const close = within(dialog)
			.getAllByRole("button", { name: "Close" })
			.find((button) => !button.querySelector(".sr-only"));
		fireEvent.click(close as HTMLElement);
		expect(useGitLabStore.getState().investigationStatus.phase).toBe("idle");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});
});

describe("GitLabIssues — a server project", () => {
	it("makes the issue a card of the shared board instead of investigating here", async () => {
		selectProject({
			...PROJECT,
			remote: { repoUrl: "https://gitlab.example.com/acme/app", defaultBranch: "main" },
		} as Project);
		api.importGitLabIssues.mockResolvedValue({
			success: true,
			data: { success: true, imported: 1, failed: 0, tasks: [{ id: "card-9", specId: "" }] },
		});
		const onNavigateToTask = vi.fn();
		renderView({ onNavigateToTask });

		fireEvent.click(await screen.findByRole("button", { name: /Slow search/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(api.importGitLabIssues).toHaveBeenCalledWith("p1", [3]));
		expect(onNavigateToTask).toHaveBeenCalledWith("card-9");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		// The card is linked to its issue from now on
		fireEvent.click(await screen.findByRole("button", { name: "View Task" }));
		expect(onNavigateToTask).toHaveBeenLastCalledWith("card-9");
	});
});
