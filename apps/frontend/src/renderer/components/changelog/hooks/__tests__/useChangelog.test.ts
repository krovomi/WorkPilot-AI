/**
 * The changelog wizard hook: what it loads for the open project, which
 * generation events it keeps, the version it suggests on Continue, and the
 * feedback of saving and copying.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
	copyChangelogToClipboard: vi.fn(),
	generateChangelog: vi.fn(),
	loadChangelogData: vi.fn(),
	loadCommitsPreview: vi.fn(),
	loadGitData: vi.fn(),
	saveChangelog: vi.fn(),
	loadTasks: vi.fn(),
}));

vi.mock("../../../../stores/changelog-store", async (importOriginal) => {
	const { loadTasks: _unused, ...storeActions } = actions;
	return {
		...(await importOriginal<
			typeof import("../../../../stores/changelog-store")
		>()),
		...storeActions,
	};
});
vi.mock("../../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../stores/task-store")>()),
	loadTasks: actions.loadTasks,
}));

import { useChangelogStore } from "../../../../stores/changelog-store";
import { useProjectStore } from "../../../../stores/project-store";
import { useChangelog } from "../useChangelog";

type Listener = (projectId: string, payload: unknown) => void;

const listeners: Record<string, Listener> = {};
const unsubscribe = vi.fn();
const api = {
	onChangelogGenerationProgress: vi.fn((cb: Listener) => {
		listeners.progress = cb;
		return unsubscribe;
	}),
	onChangelogGenerationComplete: vi.fn((cb: Listener) => {
		listeners.complete = cb;
		return unsubscribe;
	}),
	onChangelogGenerationError: vi.fn((cb: Listener) => {
		listeners.error = cb;
		return unsubscribe;
	}),
	suggestChangelogVersion: vi.fn(),
	suggestChangelogVersionFromCommits: vi.fn(),
};

const INITIAL_CHANGELOG = useChangelogStore.getState();
const INITIAL_PROJECT = useProjectStore.getState();
const COMMIT = { hash: "abc", subject: "feat: x" };

function openProject(id: string | null) {
	useProjectStore.setState({ selectedProjectId: id });
}

beforeEach(() => {
	useChangelogStore.setState(INITIAL_CHANGELOG, true);
	useProjectStore.setState(INITIAL_PROJECT, true);
	for (const fn of [...Object.values(actions), ...Object.values(api)]) {
		fn.mockClear();
	}
	unsubscribe.mockClear();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	openProject("p1");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useChangelog loading", () => {
	it("loads the changelog and git data of the open project", () => {
		renderHook(() => useChangelog());
		expect(actions.loadChangelogData).toHaveBeenCalledWith("p1");
		expect(actions.loadGitData).toHaveBeenCalledWith("p1");
	});

	it("loads nothing without a project, and generate, save, refresh do nothing", async () => {
		openProject(null);
		const { result } = renderHook(() => useChangelog());
		expect(actions.loadChangelogData).not.toHaveBeenCalled();
		act(() => result.current.handleGenerate());
		await act(() => result.current.handleSave());
		expect(result.current.handleRefresh()).toBeFalsy();
		expect(actions.generateChangelog).not.toHaveBeenCalled();
		expect(actions.saveChangelog).not.toHaveBeenCalled();
	});

	it("previews commits only in a git source mode", () => {
		const { result } = renderHook(() => useChangelog());
		result.current.handleLoadCommitsPreview();
		expect(actions.loadCommitsPreview).not.toHaveBeenCalled();
		act(() => useChangelogStore.setState({ sourceMode: "branch-diff" }));
		result.current.handleLoadCommitsPreview();
		expect(actions.loadCommitsPreview).toHaveBeenCalledWith("p1");
	});

	it("refreshes the open project's data", () => {
		const { result } = renderHook(() => useChangelog());
		actions.loadChangelogData.mockClear();
		result.current.handleRefresh();
		expect(actions.loadChangelogData).toHaveBeenCalledWith("p1");
	});
});

describe("useChangelog generation events", () => {
	it("keeps the progress of the open project only", () => {
		const { result } = renderHook(() => useChangelog());
		const progress = { stage: "generating", progress: 40, message: "…" };
		act(() => listeners.progress("other", progress));
		expect(result.current.generationProgress).toBeNull();
		act(() => listeners.progress("p1", progress));
		expect(result.current.generationProgress).toEqual(progress);
	});

	it("shows the generated changelog when it completes", () => {
		useChangelogStore.setState({ isGenerating: true });
		const { result } = renderHook(() => useChangelog());
		act(() => listeners.complete("other", { success: true, changelog: "x" }));
		expect(result.current.isGenerating).toBe(true);
		act(() =>
			listeners.complete("p1", { success: true, changelog: "## 1.0.0" }),
		);
		expect(result.current.isGenerating).toBe(false);
		expect(result.current.generatedChangelog).toBe("## 1.0.0");
		expect(result.current.generationProgress?.stage).toBe("complete");
		expect(result.current.canSave).toBe(true);
	});

	it("shows the refusal of a failed generation, or a default message", () => {
		const { result } = renderHook(() => useChangelog());
		act(() => listeners.complete("p1", { success: false, error: "no key" }));
		expect(result.current.error).toBe("no key");
		act(() => listeners.complete("p1", { success: false }));
		expect(result.current.error).toBe("Generation failed");
	});

	it("shows a generation error of the open project only", () => {
		useChangelogStore.setState({ isGenerating: true });
		const { result } = renderHook(() => useChangelog());
		act(() => listeners.error("other", "boom"));
		expect(result.current.error).toBeNull();
		act(() => listeners.error("p1", "boom"));
		expect(result.current.isGenerating).toBe(false);
		expect(result.current.error).toBe("boom");
		expect(result.current.generationProgress).toMatchObject({
			stage: "error",
			error: "boom",
		});
	});

	it("unsubscribes the three listeners on unmount", () => {
		const { unmount } = renderHook(() => useChangelog());
		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(3);
	});
});

describe("useChangelog actions", () => {
	it("generates for the open project", () => {
		const { result } = renderHook(() => useChangelog());
		act(() => result.current.handleGenerate());
		expect(actions.generateChangelog).toHaveBeenCalledWith("p1");
	});

	it("prepends on save, then moves to the last step a second later", async () => {
		vi.useFakeTimers();
		actions.saveChangelog.mockResolvedValue(true);
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleSave());
		expect(actions.saveChangelog).toHaveBeenCalledWith("p1", "prepend");
		expect(result.current.saveSuccess).toBe(true);
		act(() => vi.advanceTimersByTime(1000));
		expect(result.current.saveSuccess).toBe(false);
		expect(result.current.step).toBe(3);
	});

	it("stays on the step when the save fails", async () => {
		actions.saveChangelog.mockResolvedValue(false);
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleSave());
		expect(result.current.saveSuccess).toBe(false);
		expect(result.current.step).toBe(1);
	});

	it("confirms a copy for two seconds", async () => {
		vi.useFakeTimers();
		actions.copyChangelogToClipboard.mockResolvedValue(true);
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleCopy());
		expect(result.current.copySuccess).toBe(true);
		act(() => vi.advanceTimersByTime(2000));
		expect(result.current.copySuccess).toBe(false);
	});

	it("does not confirm a copy the system refused", async () => {
		actions.copyChangelogToClipboard.mockResolvedValue(false);
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleCopy());
		expect(result.current.copySuccess).toBe(false);
	});

	it("goes back to the first step", async () => {
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(result.current.step).toBe(2);
		act(() => result.current.handleBack());
		expect(result.current.step).toBe(1);
	});

	it("resets and reloads on done", async () => {
		actions.loadTasks.mockResolvedValue(undefined);
		useChangelogStore.setState({ generatedChangelog: "## old" });
		const { result } = renderHook(() => useChangelog());
		actions.loadChangelogData.mockClear();
		await act(() => result.current.handleDone());
		expect(result.current.generatedChangelog).toBe("");
		expect(result.current.step).toBe(1);
		expect(actions.loadTasks).toHaveBeenCalledWith("p1");
		expect(actions.loadChangelogData).toHaveBeenCalledWith("p1");
	});

	it("resets without reloading when no project is open", async () => {
		openProject(null);
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleDone());
		expect(actions.loadTasks).not.toHaveBeenCalled();
	});
});

describe("useChangelog version suggestion", () => {
	it("suggests a version from the selected tasks", async () => {
		useChangelogStore.setState({ sourceMode: "tasks", selectedTaskIds: ["t1"] });
		api.suggestChangelogVersion.mockResolvedValue({
			success: true,
			data: { version: "1.2.0", reason: "new feature" },
		});
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(api.suggestChangelogVersion).toHaveBeenCalledWith("p1", ["t1"]);
		expect(result.current.version).toBe("1.2.0");
		expect(result.current.versionReason).toBe("new feature");
		expect(result.current.step).toBe(2);
	});

	it("suggests a version from the previewed commits", async () => {
		useChangelogStore.setState({
			sourceMode: "git-history",
			previewCommits: [COMMIT] as never,
		});
		api.suggestChangelogVersionFromCommits.mockResolvedValue({
			success: true,
			data: { version: "2.0.0", reason: "breaking" },
		});
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(api.suggestChangelogVersionFromCommits).toHaveBeenCalledWith("p1", [
			COMMIT,
		]);
		expect(result.current.version).toBe("2.0.0");
	});

	it("keeps the version when the suggestion is refused", async () => {
		useChangelogStore.setState({
			sourceMode: "tasks",
			selectedTaskIds: ["t1"],
			version: "1.0.0",
		});
		api.suggestChangelogVersion.mockResolvedValue({ success: false });
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(result.current.version).toBe("1.0.0");
		expect(result.current.versionReason).toBeNull();
	});

	it("keeps the version when the commit suggestion is refused", async () => {
		useChangelogStore.setState({
			sourceMode: "branch-diff",
			previewCommits: [COMMIT] as never,
			version: "1.0.0",
		});
		api.suggestChangelogVersionFromCommits.mockResolvedValue({
			success: false,
		});
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(result.current.version).toBe("1.0.0");
	});

	it("still moves on when the suggestion throws", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		useChangelogStore.setState({ sourceMode: "tasks", selectedTaskIds: ["t1"] });
		api.suggestChangelogVersion.mockRejectedValue(new Error("down"));
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(result.current.versionReason).toBeNull();
		expect(result.current.step).toBe(2);
		consoleError.mockRestore();
	});

	it("asks nothing without tasks or commits to base it on", async () => {
		useChangelogStore.setState({ sourceMode: "git-history" });
		const { result } = renderHook(() => useChangelog());
		await act(() => result.current.handleContinue());
		expect(api.suggestChangelogVersionFromCommits).not.toHaveBeenCalled();
		expect(api.suggestChangelogVersion).not.toHaveBeenCalled();
	});
});

describe("useChangelog canContinue", () => {
	const cases: Array<[string, Record<string, unknown>, boolean]> = [
		["tasks without a selection", { sourceMode: "tasks" }, false],
		["tasks with a selection", { sourceMode: "tasks", selectedTaskIds: ["t"] }, true],
		["git history without commits", { sourceMode: "git-history" }, false],
		[
			"git history with commits",
			{ sourceMode: "git-history", previewCommits: [COMMIT] },
			true,
		],
		[
			"a diff of a branch with itself",
			{
				sourceMode: "branch-diff",
				baseBranch: "main",
				compareBranch: "main",
				previewCommits: [COMMIT],
			},
			false,
		],
		[
			"a diff without a base branch",
			{ sourceMode: "branch-diff", compareBranch: "dev", previewCommits: [COMMIT] },
			false,
		],
		[
			"a diff of two branches with commits",
			{
				sourceMode: "branch-diff",
				baseBranch: "main",
				compareBranch: "dev",
				previewCommits: [COMMIT],
			},
			true,
		],
		["an unknown mode", { sourceMode: "other" }, false],
	];

	it.each(cases)("%s", (_label, state, expected) => {
		useChangelogStore.setState(state as never);
		const { result } = renderHook(() => useChangelog());
		expect(result.current.canContinue).toBe(expected);
	});
});
