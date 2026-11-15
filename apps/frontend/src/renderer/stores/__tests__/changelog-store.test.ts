/**
 * The changelog store: what each source mode (tasks, git history, branch
 * diff) sends to the generator, the checks that refuse an empty request, the
 * git data it preselects, and saving or copying the result.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveSettings = vi.hoisted(() => vi.fn());
vi.mock("../settings-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../settings-store")>()),
	saveSettings,
}));

import {
	canGenerate,
	copyChangelogToClipboard,
	generateChangelog,
	loadChangelogData,
	loadCommitsPreview,
	loadGitData,
	saveChangelog,
	useChangelogStore,
} from "../changelog-store";
import { useSettingsStore } from "../settings-store";
import { useTaskStore } from "../task-store";

const api = {
	getChangelogDoneTasks: vi.fn(),
	readExistingChangelog: vi.fn(),
	getChangelogBranches: vi.fn(),
	getChangelogTags: vi.fn(),
	getChangelogCommitsPreview: vi.fn(),
	generateChangelog: vi.fn(),
	saveChangelog: vi.fn(),
};

const INITIAL = useChangelogStore.getState();
const store = () => useChangelogStore.getState();
const commit = { hash: "abc", subject: "feat: x" };

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	saveSettings.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	useChangelogStore.setState(INITIAL, true);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("selection and settings", () => {
	it("toggles, selects all and clears the tasks", () => {
		store().setDoneTasks([{ id: "a" }, { id: "b" }] as never);
		store().toggleTaskSelection("a");
		store().toggleTaskSelection("b");
		store().toggleTaskSelection("a");
		expect(store().selectedTaskIds).toEqual(["b"]);
		store().selectAllTasks();
		expect(store().selectedTaskIds).toEqual(["a", "b"]);
		store().deselectAllTasks();
		expect(store().selectedTaskIds).toEqual([]);
		store().setSelectedTaskIds(["x"]);
		expect(store().selectedTaskIds).toEqual(["x"]);
	});

	it("suggests the next patch version after the last one", () => {
		store().setExistingChangelog({ lastVersion: "2.4.9" } as never);
		expect(store().version).toBe("2.4.10");
		store().setVersion("1.0.0");
		store().setExistingChangelog({ lastVersion: "2.4" } as never);
		store().setExistingChangelog({ lastVersion: "v2.x.1" } as never);
		store().setExistingChangelog(null);
		expect(store().version).toBe("1.0.0");
	});

	it("saves format, audience and emoji level as preferences", () => {
		store().setFormat("simple-list" as never);
		store().setAudience("technical" as never);
		store().setEmojiLevel("high" as never);
		expect(saveSettings.mock.calls).toEqual([
			[{ changelogFormat: "simple-list" }],
			[{ changelogAudience: "technical" }],
			[{ changelogEmojiLevel: "high" }],
		]);
		expect(store()).toMatchObject({
			format: "simple-list",
			audience: "technical",
			emojiLevel: "high",
		});
	});

	it("reads the saved preferences, or the defaults", () => {
		const settings = useSettingsStore.getState().settings;
		useSettingsStore.setState({
			settings: { ...settings, changelogFormat: "github-release", changelogAudience: "marketing", changelogEmojiLevel: "little" } as never,
		});
		store().initializeFromSettings();
		expect(store()).toMatchObject({
			format: "github-release",
			audience: "marketing",
			emojiLevel: "little",
		});
		useSettingsStore.setState({
			settings: { ...settings, changelogFormat: undefined, changelogAudience: undefined, changelogEmojiLevel: undefined } as never,
		});
		store().initializeFromSettings();
		expect(store()).toMatchObject({
			format: "keep-a-changelog",
			audience: "user-facing",
			emojiLevel: "none",
		});
		useSettingsStore.setState({ settings });
	});

	it("empties the commit preview whenever the source changes", () => {
		const withPreview = () => useChangelogStore.setState({ previewCommits: [commit] as never });
		for (const change of [
			() => store().setSourceMode("git-history"),
			() => store().setGitHistoryType("tag-range"),
			() => store().setBaseBranch("main"),
			() => store().setCompareBranch("dev"),
		]) {
			withPreview();
			change();
			expect(store().previewCommits).toEqual([]);
		}
	});

	it("keeps each field it is given", () => {
		store().setBranches([{ name: "main" }] as never);
		store().setTags([{ name: "v1" }] as never);
		store().setCurrentBranch("dev");
		store().setPreviewCommits([commit] as never);
		store().setGitHistoryCount(10);
		store().setGitHistorySinceDate("2026-01-01");
		store().setGitHistoryToTag("v2");
		store().setIncludeMergeCommits(true);
		store().setDate("2026-12-01");
		store().setCustomInstructions("terse");
		store().setGenerationProgress({ stage: "generating", progress: 50, message: "m" } as never);
		store().setGeneratedChangelog("## y");
		store().setIsGenerating(true);
		store().setIsLoadingGitData(true);
		store().setIsLoadingCommits(true);
		store().setError("e");
		expect(store()).toMatchObject({
			branches: [{ name: "main" }],
			tags: [{ name: "v1" }],
			currentBranch: "dev",
			previewCommits: [commit],
			gitHistoryCount: 10,
			gitHistorySinceDate: "2026-01-01",
			gitHistoryToTag: "v2",
			includeMergeCommits: true,
			date: "2026-12-01",
			customInstructions: "terse",
			generationProgress: { progress: 50 },
			generatedChangelog: "## y",
			isGenerating: true,
			isLoadingGitData: true,
			isLoadingCommits: true,
			error: "e",
		});
	});

	it("uses the default branch as base unless one was chosen", () => {
		store().setDefaultBranch("main");
		expect(store().baseBranch).toBe("main");
		store().setDefaultBranch("master");
		expect(store()).toMatchObject({ defaultBranch: "master", baseBranch: "main" });
	});

	it("keeps only a valid saved review, and resets to today", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
		store().setSavedReview({ taskId: "t", branch: "b" });
		expect(store().savedReview).toMatchObject({ taskId: "t", branch: "b" });
		store().setSavedReview({ nope: true });
		expect(store().savedReview).toBeNull();
		store().setVersion("9.9.9");
		store().reset();
		expect(store()).toMatchObject({ version: "1.0.0", date: "2026-11-14" });
		store().updateGeneratedChangelog("## x");
		expect(store().generatedChangelog).toBe("## x");
	});
});

describe("loading", () => {
	it("passes the board's tasks and keeps the done ones and the last changelog", async () => {
		useTaskStore.setState({ tasks: [{ id: "t1", status: "done" }] as never });
		api.getChangelogDoneTasks.mockResolvedValue({ success: true, data: [{ id: "t1" }] });
		api.readExistingChangelog.mockResolvedValue({
			success: true,
			data: { lastVersion: "1.2.3" },
		});
		await loadChangelogData("p1");
		expect(api.getChangelogDoneTasks).toHaveBeenCalledWith("p1", [
			{ id: "t1", status: "done" },
		]);
		expect(store().doneTasks).toEqual([{ id: "t1" }]);
		expect(store().version).toBe("1.2.4");
		useTaskStore.setState({ tasks: [] });
	});

	it("keeps the old data when a read fails, and the message when it throws", async () => {
		api.getChangelogDoneTasks.mockResolvedValue({ success: false });
		api.readExistingChangelog.mockResolvedValue({ success: false });
		await loadChangelogData("p1");
		expect(store().doneTasks).toEqual([]);
		expect(store().existingChangelog).toBeNull();
		api.getChangelogDoneTasks.mockRejectedValue(new Error("disk"));
		await loadChangelogData("p1");
		expect(store().error).toBe("disk");
		api.getChangelogDoneTasks.mockRejectedValue("x");
		await loadChangelogData("p1");
		expect(store().error).toBe("Failed to load changelog data");
	});

	it("preselects the current branch, the default branch and the newest tags", async () => {
		api.getChangelogBranches.mockResolvedValue({
			success: true,
			data: [
				{ name: "feature", isCurrent: true },
				{ name: "master", isCurrent: false },
			],
		});
		api.getChangelogTags.mockResolvedValue({
			success: true,
			data: [{ name: "v2.0.0" }, { name: "v1.0.0" }],
		});
		await loadGitData("p1");
		expect(store()).toMatchObject({
			currentBranch: "feature",
			compareBranch: "feature",
			defaultBranch: "master",
			baseBranch: "master",
			gitHistoryFromTag: "v2.0.0",
			gitHistoryToTag: "v1.0.0",
			gitHistorySinceVersion: "v2.0.0",
			isLoadingGitData: false,
		});
	});

	it("keeps what the person already chose", async () => {
		useChangelogStore.setState({
			compareBranch: "mine",
			gitHistoryFromTag: "a",
			gitHistoryToTag: "b",
			gitHistorySinceVersion: "c",
		});
		api.getChangelogBranches.mockResolvedValue({
			success: true,
			data: [{ name: "dev", isCurrent: true }],
		});
		api.getChangelogTags.mockResolvedValue({ success: true, data: [{ name: "v1" }, { name: "v0" }] });
		await loadGitData("p1");
		expect(store()).toMatchObject({
			currentBranch: "dev",
			compareBranch: "mine",
			defaultBranch: "main",
			gitHistoryFromTag: "a",
			gitHistoryToTag: "b",
			gitHistorySinceVersion: "c",
		});
	});

	it("leaves the git data empty when nothing comes back", async () => {
		api.getChangelogBranches.mockResolvedValue({ success: true, data: [{ name: "x", isCurrent: false }] });
		api.getChangelogTags.mockResolvedValue({ success: true, data: [] });
		await loadGitData("p1");
		expect(store()).toMatchObject({ currentBranch: "", gitHistoryFromTag: "" });
		api.getChangelogBranches.mockResolvedValue({ success: false });
		api.getChangelogTags.mockResolvedValue({ success: false });
		await loadGitData("p1");
		api.getChangelogBranches.mockRejectedValue(new Error("not a repo"));
		await loadGitData("p1");
		expect(store()).toMatchObject({ error: "not a repo", isLoadingGitData: false });
		api.getChangelogBranches.mockRejectedValue(1);
		await loadGitData("p1");
		expect(store().error).toBe("Failed to load git data");
	});
});

describe("commit preview", () => {
	it("needs no preview in tasks mode", async () => {
		useChangelogStore.setState({ previewCommits: [commit] as never });
		await loadCommitsPreview("p1");
		expect(api.getChangelogCommitsPreview).not.toHaveBeenCalled();
		expect(store()).toMatchObject({ previewCommits: [], isLoadingCommits: false });
	});

	it("asks for the history since a version", async () => {
		useChangelogStore.setState({
			sourceMode: "git-history",
			gitHistoryType: "since-version",
			gitHistorySinceVersion: "v1.0.0",
			gitHistoryFromTag: "ignored",
			includeMergeCommits: true,
		});
		api.getChangelogCommitsPreview.mockResolvedValue({ success: true, data: [commit] });
		await loadCommitsPreview("p1");
		expect(api.getChangelogCommitsPreview).toHaveBeenCalledWith(
			"p1",
			{
				type: "since-version",
				count: 25,
				sinceDate: undefined,
				fromTag: "v1.0.0",
				toTag: undefined,
				includeMergeCommits: true,
			},
			"git-history",
		);
		expect(store().previewCommits).toEqual([commit]);
	});

	it("asks for a tag range and for a branch diff", async () => {
		useChangelogStore.setState({
			sourceMode: "git-history",
			gitHistoryType: "tag-range",
			gitHistoryFromTag: "v1",
			gitHistoryToTag: "v2",
			gitHistorySinceDate: "2026-01-01",
		});
		api.getChangelogCommitsPreview.mockResolvedValue({ success: true, data: [] });
		await loadCommitsPreview("p1");
		expect(api.getChangelogCommitsPreview.mock.calls[0][1]).toMatchObject({
			fromTag: "v1",
			toTag: "v2",
			sinceDate: "2026-01-01",
		});
		useChangelogStore.setState({ sourceMode: "branch-diff", baseBranch: "main", compareBranch: "dev" });
		await loadCommitsPreview("p1");
		expect(api.getChangelogCommitsPreview).toHaveBeenLastCalledWith(
			"p1",
			{ baseBranch: "main", compareBranch: "dev" },
			"branch-diff",
		);
	});

	it("empties the preview and says why when it fails", async () => {
		useChangelogStore.setState({ sourceMode: "branch-diff", previewCommits: [commit] as never });
		api.getChangelogCommitsPreview.mockResolvedValue({ success: false, error: "no branch" });
		await loadCommitsPreview("p1");
		expect(store()).toMatchObject({ error: "no branch", previewCommits: [] });
		api.getChangelogCommitsPreview.mockResolvedValue({ success: false });
		await loadCommitsPreview("p1");
		expect(store().error).toBe("Failed to load commits");
		api.getChangelogCommitsPreview.mockRejectedValue(new Error("x"));
		await loadCommitsPreview("p1");
		expect(store()).toMatchObject({ error: "x", isLoadingCommits: false });
		api.getChangelogCommitsPreview.mockRejectedValue(1);
		await loadCommitsPreview("p1");
		expect(store().error).toBe("Failed to load commits preview");
	});
});

describe("generation", () => {
	it("refuses an empty request in each mode", () => {
		const refused = (state: object, message: string) => {
			useChangelogStore.setState({ ...INITIAL, ...state }, true);
			expect(canGenerate()).toBe(false);
			generateChangelog("p1");
			expect(store().error).toBe(message);
		};
		refused({ sourceMode: "tasks" }, "Please select at least one task to include in the changelog");
		refused(
			{ sourceMode: "git-history" },
			"No commits found for the selected options. Please adjust your filters.",
		);
		refused({ sourceMode: "branch-diff", baseBranch: "main" }, "Please select both base and compare branches");
		refused(
			{ sourceMode: "branch-diff", baseBranch: "main", compareBranch: "main", previewCommits: [commit] },
			"Base and compare branches must be different",
		);
		refused(
			{ sourceMode: "branch-diff", baseBranch: "main", compareBranch: "dev" },
			"No commits found between the selected branches",
		);
		expect(api.generateChangelog).not.toHaveBeenCalled();
	});

	it("generates from the selected tasks", () => {
		useChangelogStore.setState({
			selectedTaskIds: ["a"],
			version: "2.0.0",
			date: "2026-11-14",
			emojiLevel: "high" as never,
			customInstructions: "short",
		});
		expect(canGenerate()).toBe(true);
		generateChangelog("p1");
		expect(api.generateChangelog).toHaveBeenCalledWith({
			projectId: "p1",
			sourceMode: "tasks",
			version: "2.0.0",
			date: "2026-11-14",
			format: "keep-a-changelog",
			audience: "user-facing",
			emojiLevel: "high",
			customInstructions: "short",
			taskIds: ["a"],
		});
		expect(store()).toMatchObject({
			isGenerating: true,
			generationProgress: { stage: "loading_specs", message: "Loading task specifications..." },
		});
		expect(canGenerate()).toBe(false);
	});

	it("generates from the git history or a branch diff", () => {
		useChangelogStore.setState({
			sourceMode: "git-history",
			previewCommits: [commit] as never,
			gitHistoryType: "since-version",
			gitHistorySinceVersion: "v1",
		});
		expect(canGenerate()).toBe(true);
		generateChangelog("p1");
		expect(api.generateChangelog.mock.calls[0][0]).toMatchObject({
			sourceMode: "git-history",
			emojiLevel: undefined,
			customInstructions: undefined,
			gitHistory: { type: "since-version", fromTag: "v1", count: 25 },
		});
		expect(store().generationProgress?.message).toBe("Preparing commit data...");

		useChangelogStore.setState({
			isGenerating: false,
			sourceMode: "branch-diff",
			baseBranch: "main",
			compareBranch: "dev",
			gitHistoryType: "recent",
			gitHistoryFromTag: "v0",
		});
		expect(canGenerate()).toBe(true);
		generateChangelog("p1");
		expect(api.generateChangelog.mock.calls[1][0]).toMatchObject({
			branchDiff: { baseBranch: "main", compareBranch: "dev" },
		});
		useChangelogStore.setState({ sourceMode: "git-history" });
		generateChangelog("p1");
		expect(api.generateChangelog.mock.calls[2][0].gitHistory.fromTag).toBe("v0");
	});

	it("cannot generate from an unknown mode", () => {
		useChangelogStore.setState({ sourceMode: "other" as never });
		expect(canGenerate()).toBe(false);
	});
});

describe("saving and copying", () => {
	it("needs a changelog first", async () => {
		expect(await saveChangelog("p1")).toBe(false);
		expect(store().error).toBe("No changelog to save");
		expect(await copyChangelogToClipboard()).toBe(false);
		expect(store().error).toBe("No changelog to copy");
	});

	it("saves to a review card and keeps it", async () => {
		useChangelogStore.setState({ generatedChangelog: "## 1.0.0" });
		api.saveChangelog.mockResolvedValue({
			success: true,
			data: { review: { taskId: "t", branch: "docs/changelog" } },
		});
		expect(await saveChangelog("p1", "append")).toBe(true);
		expect(api.saveChangelog).toHaveBeenCalledWith({
			projectId: "p1",
			content: "## 1.0.0",
			mode: "append",
		});
		expect(store().savedReview?.branch).toBe("docs/changelog");
		await saveChangelog("p1");
		expect(api.saveChangelog.mock.calls[1][0].mode).toBe("prepend");
	});

	it("says why a save failed", async () => {
		useChangelogStore.setState({ generatedChangelog: "x" });
		api.saveChangelog.mockResolvedValue({ success: false, error: "dirty tree" });
		expect(await saveChangelog("p1")).toBe(false);
		expect(store().error).toBe("dirty tree");
		api.saveChangelog.mockResolvedValue({ success: false });
		await saveChangelog("p1");
		expect(store().error).toBe("Failed to save changelog");
		api.saveChangelog.mockRejectedValue(new Error("ipc"));
		await saveChangelog("p1");
		expect(store().error).toBe("ipc");
		api.saveChangelog.mockRejectedValue(1);
		await saveChangelog("p1");
		expect(store().error).toBe("Failed to save changelog");
	});

	it("copies, and reports a copy the clipboard refused", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		useChangelogStore.setState({ generatedChangelog: "## x" });
		expect(await copyChangelogToClipboard()).toBe(true);
		expect(writeText).toHaveBeenCalledWith("## x");
		writeText.mockRejectedValue(new DOMException("Document is not focused"));
		expect(await copyChangelogToClipboard()).toBe(false);
		expect(store().error).toBe("Failed to copy to clipboard");
	});
});
