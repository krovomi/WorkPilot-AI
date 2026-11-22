/**
 * The Bitbucket views on their real stores, with the main process faked: a
 * project without settings shows the way to them, an issue tracker that is
 * off says so, issues filter, search, open with their comments and import;
 * pull requests filter and open with their files, diff and comments;
 * pipelines open with their steps. Bitbucket text is shown as text.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useBitbucketIssuesStore } from "../../../stores/bitbucket-issues-store";
import { useBitbucketPrStore } from "../../../stores/bitbucket-pr-store";
import { useProjectStore } from "../../../stores/project-store";
import { BitbucketViews } from "../BitbucketViews";
import { byLine } from "../shared";

const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../../../stores/task-store", () => ({ loadTasks }));

const ISSUES = useBitbucketIssuesStore.getState();
const PRS = useBitbucketPrStore.getState();
const ok = <T,>(data: T) => ({ success: true, data });
const issue = (id: number, title: string, extra = {}) => ({
	id,
	title,
	content: "",
	state: "new",
	kind: "bug",
	priority: "major",
	createdOn: "2026-11-01T10:00:00Z",
	updatedOn: "2026-11-01T10:00:00Z",
	webUrl: `https://bitbucket.org/acme/web/issues/${id}`,
	...extra,
});
const pr = (id: number, extra = {}) => ({
	id,
	title: `PR ${id}`,
	description: "",
	state: "OPEN",
	draft: false,
	sourceBranch: "feat",
	destinationBranch: "main",
	commentCount: 0,
	createdOn: "2026-11-01T10:00:00Z",
	updatedOn: "2026-11-01T10:00:00Z",
	webUrl: "",
	...extra,
});

let api: Record<string, ReturnType<typeof vi.fn>>;
let openExternal: ReturnType<typeof vi.fn>;

function show(view: string) {
	const onOpenSettings = vi.fn();
	const result = render(<BitbucketViews view={view} projectId="p1" onOpenSettings={onOpenSettings} />);
	return { onOpenSettings, ...result };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useBitbucketIssuesStore.setState(ISSUES, true);
	useBitbucketPrStore.setState(PRS, true);
	useProjectStore.setState({ activeProjectId: null, selectedProjectId: "p1" });
	loadTasks.mockReset();
	api = {
		checkConnection: vi.fn().mockResolvedValue(ok({ connected: true, fullName: "acme/web" })),
		getIssues: vi.fn().mockResolvedValue(
			ok({
				issuesEnabled: true,
				issues: [
					issue(1, "Crash on save", {
						content: "<img src=x onerror=alert(1)>",
						reporter: { displayName: "Alice" },
					}),
					issue(2, "Slow login", { state: "custom-state", kind: "task" }),
				],
			}),
		),
		getIssueComments: vi.fn().mockResolvedValue(ok([{ id: 9, content: "Same here", createdOn: "2026-11-02T10:00:00Z" }])),
		importIssues: vi.fn().mockResolvedValue(ok({ success: true, imported: 1, failed: 1, errors: ["#2: refused"] })),
		getPullRequests: vi.fn().mockResolvedValue(ok([pr(5, { draft: true, description: "Fixes it" }), pr(6)])),
		getPullRequestDiff: vi.fn().mockResolvedValue(
			ok({
				files: [{ path: "src/a.ts", status: "modified", linesAdded: 3, linesRemoved: 1 }],
				diff: "diff --git a/src/a.ts",
				truncated: true,
			}),
		),
		getPullRequestComments: vi.fn().mockResolvedValue(
			ok([
				{ id: 1, content: "Nit", createdOn: "2026-11-02T10:00:00Z", path: "src/a.ts", line: 4 },
				{ id: 2, content: "On a file", createdOn: "2026-11-02T10:00:00Z", path: "src/b.ts" },
			]),
		),
		getPipelines: vi.fn().mockResolvedValue(
			ok([
				{ uuid: "{a}", buildNumber: 12, state: "FAILED", branch: "main", createdOn: "2026-11-02T10:00:00Z", webUrl: "" },
				{ uuid: "{b}", buildNumber: 11, state: "WEIRD", createdOn: "2026-11-01T10:00:00Z", webUrl: "" },
			]),
		),
		getPipelineSteps: vi.fn().mockResolvedValue(
			ok([
				{ uuid: "{s}", name: "Build", state: "SUCCESSFUL" },
				{ uuid: "{t}", name: "Deploy", state: "QUEUED" },
			]),
		),
	};
	openExternal = vi.fn().mockResolvedValue(undefined);
	(window as unknown as { electronAPI: unknown }).electronAPI = { bitbucket: api, openExternal };
});

describe("BitbucketViews", () => {
	it("shows nothing for another view", () => {
		const { container } = show("kanban");
		expect(container).toBeEmptyDOMElement();
	});

	it("leads to the settings when Bitbucket is not connected", async () => {
		api.checkConnection.mockResolvedValue({ success: false, error: "No Bitbucket settings" });
		const { onOpenSettings, unmount } = show("bitbucket-issues");
		expect(screen.getByText("Checking the Bitbucket connection…")).toBeInTheDocument();
		expect(await screen.findByText("No Bitbucket settings")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Open Bitbucket settings" }));
		expect(onOpenSettings).toHaveBeenCalled();
		expect(api.getIssues).not.toHaveBeenCalled();
		unmount();

		show("bitbucket-pull-requests");
		expect(await screen.findByText("No Bitbucket settings")).toBeInTheDocument();
		expect(api.getPullRequests).not.toHaveBeenCalled();
	});

	it("says why without Bitbucket's reason, and never shows another project's pull requests", async () => {
		api.checkConnection.mockResolvedValueOnce(ok({ connected: false }));
		const first = show("bitbucket-issues");
		expect(await screen.findByText(/Turn Bitbucket on in the project settings/)).toBeInTheDocument();
		first.unmount();

		useBitbucketIssuesStore.setState({ projectId: "p1", syncStatus: { connected: true } });
		useBitbucketPrStore.setState({
			projectId: "p2",
			pullRequests: [pr(77)],
			pipelines: [{ uuid: "{z}", buildNumber: 77, state: "FAILED", createdOn: "", webUrl: "" }],
		});
		api.checkConnection.mockReturnValueOnce(new Promise(() => undefined));
		show("bitbucket-pull-requests");
		expect(screen.queryByText("PR 77")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Pipelines" }));
		expect(screen.queryByText("Build #77")).not.toBeInTheDocument();
	});

	it("says when the repository has no issue tracker", async () => {
		api.getIssues.mockResolvedValue(ok({ issuesEnabled: false, issues: [] }));
		show("bitbucket-issues");
		expect(await screen.findByText("The issue tracker is off")).toBeInTheDocument();
	});
});

describe("the issues view", () => {
	it("lists, searches, opens an issue with its comments, as text", async () => {
		show("bitbucket-issues");
		expect(await screen.findByText("Crash on save")).toBeInTheDocument();
		expect(screen.getByText("Select an issue to see it here.")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Search issues"), { target: { value: "slow" } });
		expect(screen.queryByText("Crash on save")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search issues"), { target: { value: "nothing" } });
		expect(screen.getByText("No issue matches the search.")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search issues"), { target: { value: "" } });

		fireEvent.click(screen.getByText("Crash on save"));
		expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
		expect(document.querySelector("img")).toBeNull();
		expect(await screen.findByText("Same here")).toBeInTheDocument();
		expect(api.getIssueComments).toHaveBeenCalledWith("p1", 1);
		fireEvent.click(screen.getByRole("button", { name: "Open in Bitbucket" }));
		expect(openExternal).toHaveBeenCalledWith("https://bitbucket.org/acme/web/issues/1");

		fireEvent.click(screen.getByText("Slow login"));
		expect(screen.getByText("No description.")).toBeInTheDocument();
		expect(screen.getAllByText("custom-state").length).toBeGreaterThan(0);
	});

	it("shows an empty comment thread and the loading state", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.getIssueComments.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		show("bitbucket-issues");
		fireEvent.click(await screen.findByText("Crash on save"));
		expect(screen.getByText("Loading comments…")).toBeInTheDocument();
		answer(ok([]));
		expect(await screen.findByText("No comments.")).toBeInTheDocument();
	});

	it("filters by state, refreshes and shows why loading failed", async () => {
		show("bitbucket-issues");
		await screen.findByText("Crash on save");
		api.getIssues.mockResolvedValueOnce(ok({ issuesEnabled: true, issues: [] }));
		fireEvent.change(screen.getByLabelText("Issue state"), { target: { value: "closed" } });
		expect(await screen.findByText("No issues in this state.")).toBeInTheDocument();
		expect(api.getIssues).toHaveBeenLastCalledWith("p1", "closed");

		api.getIssues.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
	});

	it("imports the checked issues, or the one on screen", async () => {
		show("bitbucket-issues");
		await screen.findByText("Crash on save");
		const importChecked = screen.getByRole("button", { name: "Import 0 as tasks" });
		expect(importChecked).toBeDisabled();

		fireEvent.click(screen.getByRole("checkbox", { name: "Select issue #1" }));
		fireEvent.click(screen.getByRole("button", { name: "Import 1 as a task" }));
		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent("1 imported, 1 failed.");
		expect(status).toHaveTextContent("#2: refused");
		expect(api.importIssues).toHaveBeenCalledWith("p1", [1]);
		expect(loadTasks).toHaveBeenCalledWith("p1");

		api.importIssues.mockResolvedValueOnce(ok({ success: true, imported: 1, failed: 0 }));
		fireEvent.click(screen.getByText("Slow login"));
		fireEvent.click(screen.getByRole("button", { name: "Import as a task" }));
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 imported, 0 failed."));
		expect(api.importIssues).toHaveBeenLastCalledWith("p1", [2]);
	});
});

describe("the pull requests view", () => {
	it("lists, filters and opens a pull request with its files, diff and comments", async () => {
		show("bitbucket-pull-requests");
		expect(await screen.findByText("PR 5")).toBeInTheDocument();
		expect(screen.getByText(/· draft/)).toBeInTheDocument();
		expect(screen.getByText("Select a pull request to see it here.")).toBeInTheDocument();

		fireEvent.click(screen.getByText("PR 5"));
		expect(screen.getByText("Fixes it")).toBeInTheDocument();
		expect(screen.getByText("feat into main")).toBeInTheDocument();
		expect(await screen.findByText("diff --git a/src/a.ts")).toBeInTheDocument();
		expect(screen.getByText("+3")).toBeInTheDocument();
		expect(screen.getByText("The diff is too long: only its beginning is shown.")).toBeInTheDocument();
		expect(screen.getByText(/src\/a\.ts:4/)).toBeInTheDocument();
		expect(screen.getByText(/· src\/b\.ts$/)).toBeInTheDocument();

		api.getPullRequestDiff.mockResolvedValueOnce({ success: false, error: "diff gone" });
		api.getPullRequestComments.mockResolvedValueOnce(ok([]));
		fireEvent.click(screen.getByText("PR 6"));
		expect(screen.getByText("No description.")).toBeInTheDocument();
		expect(screen.getByText("Loading the changes…")).toBeInTheDocument();
		expect(await screen.findByText("diff gone")).toBeInTheDocument();
		expect(screen.getByText("No comments.")).toBeInTheDocument();

		api.getPullRequests.mockResolvedValueOnce(ok([]));
		fireEvent.change(screen.getByLabelText("Pull request state"), { target: { value: "MERGED" } });
		expect(await screen.findByText("No pull requests in this state.")).toBeInTheDocument();
		expect(api.getPullRequests).toHaveBeenLastCalledWith("p1", "MERGED");

		api.getPullRequests.mockResolvedValueOnce({ success: false, error: "HTTP 403" });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 403");
	});

	it("shows the pipelines and a pipeline's steps", async () => {
		show("bitbucket-pull-requests");
		await screen.findByText("PR 5");
		fireEvent.click(screen.getByRole("tab", { name: "Pipelines" }));
		expect(await screen.findByText("Build #12")).toBeInTheDocument();
		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText("WEIRD")).toBeInTheDocument();

		const row = screen.getByText("Build #12").closest("button") as HTMLElement;
		fireEvent.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(await screen.findByText("Build")).toBeInTheDocument();
		expect(screen.getByText("QUEUED")).toBeInTheDocument();
		expect(api.getPipelineSteps).toHaveBeenCalledWith("p1", "{a}");
		fireEvent.click(row);
		expect(screen.queryByText("Build")).not.toBeInTheDocument();
		fireEvent.click(row);
		expect(within(row.parentElement?.parentElement as HTMLElement).getByText("Build")).toBeInTheDocument();
		expect(api.getPipelineSteps).toHaveBeenCalledTimes(1);

		api.getPipelines.mockResolvedValueOnce({ success: false, error: "Pipelines off" });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Pipelines off");

		api.getPipelines.mockResolvedValueOnce(ok([]));
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("No pipelines yet.")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Pull requests" }));
		expect(await screen.findByText("PR 5")).toBeInTheDocument();
	});
});

describe("byLine", () => {
	it("names the author when there is one", () => {
		expect(byLine({ displayName: "Alice" }, "2026-11-01T10:00:00Z")).toMatch(/^Alice · /);
		expect(byLine(undefined, "2026-11-01T10:00:00Z")).not.toContain("·");
	});
});
