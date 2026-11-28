/**
 * The Bitbucket stores: the connection, the issues of a filter, an issue's
 * comments, the import (which reloads the board), the pull requests of a
 * state, a pull request's diff and comments, the pipelines and their steps.
 * An answer that arrives after the person left its project is dropped, and
 * loading another project starts from an empty view.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import {
	checkBitbucketConnection,
	importBitbucketIssues,
	isShownProject,
	loadBitbucketIssueComments,
	loadBitbucketIssues,
	useBitbucketIssuesStore,
} from "../bitbucket-issues-store";
import {
	loadBitbucketPipelineSteps,
	loadBitbucketPipelines,
	loadBitbucketPullRequestDetail,
	loadBitbucketPullRequests,
	useBitbucketPrStore,
} from "../bitbucket-pr-store";
import { useProjectStore } from "../project-store";

const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../task-store", () => ({ loadTasks }));

const ISSUES = useBitbucketIssuesStore.getState();
const PRS = useBitbucketPrStore.getState();
const issues = () => useBitbucketIssuesStore.getState();
const prs = () => useBitbucketPrStore.getState();
let api: Record<string, ReturnType<typeof vi.fn>>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((ok) => {
		resolve = ok;
	});
	return { promise, resolve };
}

const ok = <T>(data: T) => ({ success: true, data });

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useBitbucketIssuesStore.setState(ISSUES, true);
	useBitbucketPrStore.setState(PRS, true);
	useProjectStore.setState({ activeProjectId: null, selectedProjectId: "p1" });
	loadTasks.mockReset();
	api = {
		checkConnection: vi.fn().mockResolvedValue(ok({ connected: true, fullName: "acme/web" })),
		getIssues: vi.fn().mockResolvedValue(ok({ issuesEnabled: true, issues: [{ id: 1 }] })),
		getIssueComments: vi.fn().mockResolvedValue(ok([{ id: 9 }])),
		importIssues: vi.fn().mockResolvedValue(ok({ success: true, imported: 1, failed: 0 })),
		getPullRequests: vi.fn().mockResolvedValue(ok([{ id: 5 }])),
		getPullRequestDiff: vi.fn().mockResolvedValue(ok({ files: [], diff: "d", truncated: false })),
		getPullRequestComments: vi.fn().mockResolvedValue(ok([{ id: 7 }])),
		getPipelines: vi.fn().mockResolvedValue(ok([{ uuid: "{u}" }])),
		getPipelineSteps: vi.fn().mockResolvedValue(ok([{ uuid: "{s}" }])),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = { bitbucket: api };
});

describe("the project on screen", () => {
	it("is the active project, else the selected one", () => {
		expect(isShownProject("p1")).toBe(true);
		useProjectStore.setState({ activeProjectId: "p2" });
		expect(isShownProject("p1")).toBe(false);
		expect(isShownProject("p2")).toBe(true);
	});
});

describe("checkBitbucketConnection", () => {
	it("says whether the repository answers, with Bitbucket's reason or the view's own", async () => {
		await expect(checkBitbucketConnection("p1")).resolves.toBe(true);
		expect(issues()).toMatchObject({ projectId: "p1", syncStatus: { connected: true } });

		api.checkConnection.mockResolvedValueOnce({ success: false, error: "401" });
		await expect(checkBitbucketConnection("p1")).resolves.toBe(false);
		expect(issues().syncStatus).toEqual({ connected: false, error: "401" });

		api.checkConnection.mockRejectedValueOnce(new Error("gone"));
		await expect(checkBitbucketConnection("p1")).resolves.toBe(false);
		expect(issues().syncStatus?.error).toBe("Could not check the Bitbucket connection.");
	});

	it("drops an answer for a project no longer on screen", async () => {
		const answer = deferred<unknown>();
		api.checkConnection.mockReturnValueOnce(answer.promise);
		const pending = checkBitbucketConnection("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		answer.resolve(ok({ connected: true }));
		await expect(pending).resolves.toBe(false);
		expect(issues().syncStatus).toBeNull();
	});
});

describe("loadBitbucketIssues", () => {
	it("loads a filter, and starts over for another project", async () => {
		await loadBitbucketIssues("p1");
		issues().toggleChecked(3);
		await loadBitbucketIssues("p1", "closed");
		expect(api.getIssues).toHaveBeenCalledWith("p1", "closed");
		expect(issues()).toMatchObject({ filter: "closed", issues: [{ id: 1 }], isLoading: false, checked: [3] });

		useProjectStore.setState({ selectedProjectId: "p2" });
		api.getIssues.mockResolvedValueOnce(ok({ issuesEnabled: false, issues: [] }));
		await loadBitbucketIssues("p2");
		expect(api.getIssues).toHaveBeenLastCalledWith("p2", "closed");
		expect(issues()).toMatchObject({ projectId: "p2", issuesEnabled: false, issues: [], checked: [] });
	});

	it("shows why loading failed", async () => {
		api.getIssues.mockResolvedValueOnce({ success: false, error: "boom" });
		await loadBitbucketIssues("p1");
		expect(issues()).toMatchObject({ error: "boom", isLoading: false });
		api.getIssues.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketIssues("p1");
		expect(issues().error).toBe("Could not load the Bitbucket issues.");
	});

	it("drops the answer of a filter the person already changed", async () => {
		const first = deferred<unknown>();
		api.getIssues.mockReturnValueOnce(first.promise);
		const pending = loadBitbucketIssues("p1", "open");
		await loadBitbucketIssues("p1", "all");
		first.resolve(ok({ issuesEnabled: true, issues: [{ id: 99 }] }));
		await pending;
		expect(issues()).toMatchObject({ filter: "all", issues: [{ id: 1 }] });
	});
});

describe("issue comments and selection", () => {
	it("keeps the comments of each issue, and drops a late answer", async () => {
		await loadBitbucketIssues("p1");
		issues().selectIssue(1);
		await loadBitbucketIssueComments("p1", 1);
		expect(issues()).toMatchObject({ selectedId: 1, comments: { 1: [{ id: 9 }] } });

		api.getIssueComments.mockResolvedValueOnce({ success: false });
		await loadBitbucketIssueComments("p1", 2);
		expect(issues().comments[2]).toBeUndefined();
		api.getIssueComments.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketIssueComments("p1", 4);
		expect(issues().comments[4]).toBeUndefined();

		useProjectStore.setState({ selectedProjectId: "p2" });
		await loadBitbucketIssueComments("p1", 3);
		expect(issues().comments[3]).toBeUndefined();
	});

	it("checks and unchecks an issue, and sets the filter", () => {
		issues().toggleChecked(1);
		issues().toggleChecked(2);
		issues().toggleChecked(1);
		expect(issues().checked).toEqual([2]);
		issues().setFilter("all");
		expect(issues().filter).toBe("all");
	});
});

describe("importBitbucketIssues", () => {
	it("imports the checked issues, then reloads the board", async () => {
		await loadBitbucketIssues("p1");
		issues().toggleChecked(1);
		await importBitbucketIssues("p1");
		expect(api.importIssues).toHaveBeenCalledWith("p1", [1]);
		expect(issues()).toMatchObject({ isImporting: false, checked: [], importResult: { imported: 1 } });
		expect(loadTasks).toHaveBeenCalledWith("p1");
	});

	it("does nothing without issues, and does not reload when nothing was imported", async () => {
		await importBitbucketIssues("p1", []);
		expect(api.importIssues).not.toHaveBeenCalled();
		await loadBitbucketIssues("p1");
		api.importIssues.mockResolvedValueOnce(ok({ success: false, imported: 0, failed: 1 }));
		await importBitbucketIssues("p1", [1]);
		expect(loadTasks).not.toHaveBeenCalled();
	});

	it("counts every issue as failed when the call fails, and drops a late answer", async () => {
		await loadBitbucketIssues("p1");
		api.importIssues.mockRejectedValueOnce(new Error("x"));
		await importBitbucketIssues("p1", [1, 2]);
		expect(issues().importResult).toEqual({
			success: false,
			imported: 0,
			failed: 2,
			errors: ["Could not import the issues."],
		});

		useProjectStore.setState({ selectedProjectId: "p2" });
		await importBitbucketIssues("p1", [1]);
		expect(issues().isImporting).toBe(true);
		expect(loadTasks).not.toHaveBeenCalled();
	});
});

describe("loadBitbucketPullRequests", () => {
	it("loads a state, keeps it when none is given, and starts over for another project", async () => {
		await loadBitbucketPullRequests("p1", "MERGED");
		expect(api.getPullRequests).toHaveBeenCalledWith("p1", "MERGED");
		expect(prs()).toMatchObject({ projectId: "p1", state: "MERGED", pullRequests: [{ id: 5 }] });
		prs().selectPullRequest(5);

		useProjectStore.setState({ selectedProjectId: "p2" });
		await loadBitbucketPullRequests("p2");
		expect(api.getPullRequests).toHaveBeenLastCalledWith("p2", "MERGED");
		expect(prs()).toMatchObject({ projectId: "p2", selectedId: null });
	});

	it("shows why loading failed, and drops a stale answer", async () => {
		api.getPullRequests.mockResolvedValueOnce({ success: false, error: "403" });
		await loadBitbucketPullRequests("p1");
		expect(prs()).toMatchObject({ error: "403", isLoading: false });
		api.getPullRequests.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketPullRequests("p1");
		expect(prs().error).toBe("Could not load the pull requests.");

		const late = deferred<unknown>();
		api.getPullRequests.mockReturnValueOnce(late.promise);
		const pending = loadBitbucketPullRequests("p1", "OPEN");
		await loadBitbucketPullRequests("p1", "DECLINED");
		late.resolve(ok([{ id: 1 }]));
		await pending;
		expect(prs()).toMatchObject({ state: "DECLINED", pullRequests: [{ id: 5 }] });
	});
});

describe("loadBitbucketPullRequestDetail", () => {
	it("loads the diff and the comments once", async () => {
		await loadBitbucketPullRequests("p1");
		await loadBitbucketPullRequestDetail("p1", 5);
		await loadBitbucketPullRequestDetail("p1", 5);
		expect(api.getPullRequestDiff).toHaveBeenCalledTimes(1);
		expect(api.getPullRequestComments).toHaveBeenCalledTimes(1);
		expect(prs()).toMatchObject({ diffs: { 5: { diff: "d" } }, comments: { 5: [{ id: 7 }] }, detailError: null });
	});

	it("keeps what loaded and says what did not", async () => {
		await loadBitbucketPullRequests("p1");
		api.getPullRequestComments.mockResolvedValueOnce({ success: false, error: "404" });
		await loadBitbucketPullRequestDetail("p1", 5);
		expect(prs()).toMatchObject({ diffs: { 5: { diff: "d" } }, detailError: "404" });
		expect(prs().comments[5]).toBeUndefined();

		api.getPullRequestDiff.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketPullRequestDetail("p1", 6);
		expect(prs().detailError).toBe("Could not load all of this pull request.");
		expect(prs().comments[6]).toEqual([{ id: 7 }]);

		prs().selectPullRequest(6);
		expect(prs().detailError).toBeNull();
		useProjectStore.setState({ selectedProjectId: "p2" });
		await loadBitbucketPullRequestDetail("p1", 8);
		expect(prs().diffs[8]).toBeUndefined();
	});
});

describe("pipelines", () => {
	it("loads the pipelines and a pipeline's steps", async () => {
		await loadBitbucketPipelines("p1");
		expect(prs()).toMatchObject({ pipelines: [{ uuid: "{u}" }], pipelinesLoading: false });
		await loadBitbucketPipelineSteps("p1", "{u}");
		expect(api.getPipelineSteps).toHaveBeenCalledWith("p1", "{u}");
		expect(prs().steps["{u}"]).toEqual([{ uuid: "{s}" }]);
	});

	it("shows why the pipelines did not load, and ignores failed or late steps", async () => {
		api.getPipelines.mockResolvedValueOnce({ success: false, error: "no pipelines" });
		await loadBitbucketPipelines("p1");
		expect(prs()).toMatchObject({ pipelinesError: "no pipelines", pipelinesLoading: false });
		api.getPipelines.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketPipelines("p1");
		expect(prs().pipelinesError).toBe("Could not load the pipelines.");

		api.getPipelineSteps.mockRejectedValueOnce(new Error("x"));
		await loadBitbucketPipelineSteps("p1", "{a}");
		expect(prs().steps["{a}"]).toBeUndefined();

		const late = deferred<unknown>();
		api.getPipelines.mockReturnValueOnce(late.promise);
		const pending = loadBitbucketPipelines("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		late.resolve(ok([{ uuid: "{late}" }]));
		await pending;
		expect(prs().pipelinesLoading).toBe(true);
	});
});
