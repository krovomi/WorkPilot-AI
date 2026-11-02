/**
 * The changelog of a server project is the server's: the view's handlers send
 * each request there by project id, the done cards are the server board's,
 * the branches, tags and commits the clone's, and the changelog is built by a
 * job whose report every member reads. No path goes to the server, and
 * nothing of the project goes to a model on this computer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogGenerationRequest, Project, Task } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	runServerAnalysis: vi.fn(),
	getRemoteTasks: vi.fn(),
	getMirrorTasks: vi.fn(),
	getCompletedTasks: vi.fn(),
	loadTaskSpecs: vi.fn(),
}));

vi.mock("../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../server-analyses", () => ({
	AnalysisStopped: class AnalysisStopped extends Error {},
	runServerAnalysis: mocks.runServerAnalysis,
	serverAnalysisReport: vi.fn(),
}));
vi.mock("../../remote-board", () => ({
	getRemoteTasks: mocks.getRemoteTasks,
	parseServerTaskId: (id: unknown) => {
		const match = typeof id === "string" ? /^server:([^:]+):(.+)$/.exec(id) : null;
		return match ? { projectId: match[1], cardId: match[2] } : null;
	},
	serverTaskId: (projectId: string, cardId: string) => `server:${projectId}:${cardId}`,
}));
vi.mock("../../project-store", () => ({
	projectStore: { getMirrorTasks: mocks.getMirrorTasks },
}));
vi.mock("../../changelog-service", () => ({
	changelogService: {
		getCompletedTasks: mocks.getCompletedTasks,
		loadTaskSpecs: mocks.loadTaskSpecs,
	},
}));

import { AnalysisStopped } from "../server-analyses";
import {
	generateServerChangelog,
	parseSources,
	saveServerChangelog,
	serverChangelogCommits,
	serverChangelogDoneTasks,
	serverChangelogSources,
	serverChangelogSpecs,
	suggestVersionFromCommitTypes,
	toServerOptions,
} from "../server-changelog";

const project = {
	id: "p-1",
	path: "/mirror/p-1",
	autoBuildPath: ".workpilot",
	remote: { repoUrl: "https://github.com/acme/shop.git", defaultBranch: "main", role: "member" },
} as unknown as Project;

const request: ChangelogGenerationRequest = {
	projectId: "p-1",
	sourceMode: "tasks",
	taskIds: ["server:p-1:001-cart", "server:p-2:002-other", "001-local", "server:p-1:001-cart"],
	version: "1.2.0",
	date: "2026-11-02",
	format: "keep-a-changelog",
	audience: "technical",
	customInstructions: "Short",
};

function events() {
	return { progress: vi.fn(), complete: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("a server project's changelog", () => {
	it("reads the clone's branches, tags and changelog by project id", async () => {
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: {
				branches: [{ name: "main", isRemote: false, isCurrent: true }, { name: "" }, "x"],
				tags: [{ name: "v1.0.0", date: "2026-10-01", commit: "abc" }],
				currentBranch: "main",
				defaultBranch: "main",
				existing: { exists: true, content: "## [1.0.0]", lastVersion: "1.0.0" },
			},
		});
		const sources = await serverChangelogSources(project);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/changelog/sources?project_id=p-1",
			"GET",
		);
		expect(sources.data?.branches).toEqual([{ name: "main", isRemote: false, isCurrent: true }]);
		expect(sources.data?.tags[0].name).toBe("v1.0.0");
		expect(sources.data?.existing.lastVersion).toBe("1.0.0");
		expect(parseSources({ existing: { exists: true, lastVersion: null } })?.existing).toEqual({
			exists: true,
			content: "",
			lastVersion: undefined,
		});
		expect(parseSources("nope")).toBeNull();
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Forbidden" });
		expect(await serverChangelogSources(project)).toEqual({ success: false, error: "Forbidden" });
	});

	it("asks the server for the commits of a range, never a path", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: { commits: [{ hash: "abc", subject: "feat: cart", author: "Ada" }, { subject: "x" }] },
		});
		const recent = await serverChangelogCommits(
			project,
			{ type: "tag-range", fromTag: "v1.0.0", count: 10, includeMergeCommits: true },
			"git-history",
		);
		expect(recent.data).toHaveLength(1);
		expect(recent.data?.[0]).toMatchObject({ hash: "abc", subject: "feat: cart" });
		const [url] = mocks.authedFetch.mock.calls[0];
		expect(url).toBe(
			"/api/features/changelog/commits?project_id=p-1&mode=git-history&type=tag-range&count=10&from_tag=v1.0.0&include_merge_commits=true",
		);
		await serverChangelogCommits(
			project,
			{ baseBranch: "main", compareBranch: "feature/pay" },
			"branch-diff",
		);
		expect(mocks.authedFetch.mock.calls[1][0]).toBe(
			"/api/features/changelog/commits?project_id=p-1&mode=branch-diff&base_branch=main&compare_branch=feature%2Fpay",
		);
		expect(
			await serverChangelogCommits(project, null as never, "git-history"),
		).toEqual({ success: false, error: "Invalid range" });
	});

	it("lists the done cards of the server board, read fresh", async () => {
		const tasks = [{ id: "server:p-1:001-cart", specId: "001-cart" }] as Task[];
		mocks.getRemoteTasks.mockResolvedValueOnce({ success: true, data: tasks });
		mocks.getCompletedTasks.mockReturnValueOnce([{ id: "server:p-1:001-cart" }]);
		const done = await serverChangelogDoneTasks(project);
		expect(mocks.getCompletedTasks).toHaveBeenCalledWith("/mirror/p-1", tasks, ".workpilot/specs");
		expect(done.data).toEqual([{ id: "server:p-1:001-cart" }]);

		// The server out of reach: the mirror it last sent.
		mocks.getRemoteTasks.mockResolvedValueOnce({ success: false, error: "down" });
		mocks.getMirrorTasks.mockReturnValueOnce([{ id: "001-cart", specId: "001-cart" }]);
		await serverChangelogDoneTasks(project);
		expect(mocks.getCompletedTasks.mock.calls[1][1][0].id).toBe("server:p-1:001-cart");
	});

	it("reads the specs of this project's cards only", async () => {
		mocks.getMirrorTasks.mockReturnValueOnce([{ id: "001-cart", specId: "001-cart" }]);
		mocks.loadTaskSpecs.mockResolvedValueOnce([]);
		await serverChangelogSpecs(project, ["server:p-1:001-cart", "server:p-2:001-cart", 3]);
		expect(mocks.loadTaskSpecs.mock.calls[0][1]).toEqual(["server:p-1:001-cart"]);
	});

	it("names the cards by their ids on the board, in the server's closed model", () => {
		expect(toServerOptions(project, request)).toEqual({
			source_mode: "tasks",
			task_ids: ["001-cart"],
			git_history: null,
			branch_diff: null,
			version: "1.2.0",
			date: "2026-11-02",
			format: "keep-a-changelog",
			audience: "technical",
			emoji_level: "none",
			custom_instructions: "Short",
		});
		const git = toServerOptions(project, {
			...request,
			sourceMode: "git-history",
			version: "",
			gitHistory: { type: "since-date", sinceDate: "2026-10-01" },
		});
		expect(git).toMatchObject({
			task_ids: [],
			version: "1.0.0",
			git_history: { type: "since-date", count: 25, since_date: "2026-10-01", from_tag: null },
		});
	});

	it("builds the changelog on the server and tells the view", async () => {
		mocks.runServerAnalysis.mockImplementationOnce(async (_p, _k, _o, onEvent) => {
			onEvent({ stage: "generating", progress: 30, message: "Generating" });
			onEvent({ stage: "nonsense" });
			return { changelog: "## [1.2.0]\n- Cart", version: "1.2.0", itemsIncluded: 1 };
		});
		const told = events();
		await generateServerChangelog(project, request, told);
		expect(mocks.runServerAnalysis).toHaveBeenCalledWith(
			project,
			"changelog",
			expect.objectContaining({ task_ids: ["001-cart"] }),
			expect.any(Function),
		);
		expect(told.progress).toHaveBeenCalledTimes(1);
		expect(told.progress).toHaveBeenCalledWith("p-1", {
			stage: "generating",
			progress: 30,
			message: "Generating",
		});
		expect(told.complete).toHaveBeenCalledWith("p-1", {
			success: true,
			changelog: "## [1.2.0]\n- Cart",
			version: "1.2.0",
			tasksIncluded: 1,
		});
		expect(told.error).not.toHaveBeenCalled();
	});

	it("says why a build failed, and stays quiet on one it replaced", async () => {
		mocks.runServerAnalysis.mockRejectedValueOnce(new Error("No done card"));
		const failed = events();
		await generateServerChangelog(project, request, failed);
		expect(failed.error).toHaveBeenCalledWith("p-1", "No done card");

		mocks.runServerAnalysis.mockResolvedValueOnce({ version: "1.2.0" });
		const empty = events();
		await generateServerChangelog(project, request, empty);
		expect(empty.error).toHaveBeenCalledWith("p-1", "The changelog was not saved on the server");

		mocks.runServerAnalysis.mockRejectedValueOnce(new AnalysisStopped());
		const stopped = events();
		await generateServerChangelog(project, request, stopped);
		expect(stopped.error).not.toHaveBeenCalled();
		expect(stopped.complete).not.toHaveBeenCalled();
	});

	it("keeps a member's correction on the server, not in a file here", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { saved: true } });
		const saved = await saveServerChangelog(project, "## [1.2.0]\n- Cart, fixed");
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/changelog/report?project_id=p-1",
			"PUT",
			{ changelog: "## [1.2.0]\n- Cart, fixed" },
		);
		expect(saved).toMatchObject({ success: true, data: { filePath: "" } });
		expect(await saveServerChangelog(project, "  ")).toMatchObject({ success: false });
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Requires project role 'member'" });
		expect(await saveServerChangelog(project, "x")).toEqual({
			success: false,
			error: "Requires project role 'member'",
		});
	});

	it("suggests a version from the commits' types, with no model", () => {
		const commits = (...subjects: string[]) => subjects.map((subject) => ({ subject }));
		expect(suggestVersionFromCommitTypes(commits("fix: a", "feat(cart): b"), "1.2.3")).toEqual({
			version: "1.3.0",
			reason: "feature",
		});
		expect(suggestVersionFromCommitTypes(commits("refactor!: drop v1"), "1.2.3")).toEqual({
			version: "2.0.0",
			reason: "breaking",
		});
		expect(suggestVersionFromCommitTypes(commits("docs: x"), "1.2.3").version).toBe("1.2.4");
		expect(suggestVersionFromCommitTypes(commits("feat: x"), undefined).version).toBe("1.0.0");
		expect(suggestVersionFromCommitTypes("nope", "bad").version).toBe("1.0.0");
	});
});
