// @vitest-environment jsdom
/**
 * useTaskDetail — the state behind the task panel: feedback that belongs to
 * one task, the worktree it reviews, the phase logs it follows, the stuck and
 * paused detection, and the plan reload of an incomplete task.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { UIEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../../__tests__/helpers/renderer-api";
import i18n from "../../../../../shared/i18n";
import type {
	ImageAttachment,
	Project,
	Subtask,
	Task,
	TaskLogs,
	WorktreeDiff,
	WorktreeStatus,
} from "../../../../../shared/types";
import { setPendingTaskDetailTab } from "../../../../lib/task-detail-nav";
import { useProjectStore } from "../../../../stores/project-store";
import { useSettingsStore } from "../../../../stores/settings-store";
import { recordTaskActivity, useTaskStore } from "../../../../stores/task-store";
import { useTaskDetail } from "../useTaskDetail";

const PROJECT = { id: "p1", name: "One", path: "/repo/one" } as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "spec-1",
		projectId: "p1",
		title: "Task one",
		description: "",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

function subtask(id: string, overrides: Partial<Subtask> = {}): Subtask {
	return {
		id,
		title: `Subtask ${id}`,
		description: `Do ${id}`,
		status: "pending",
		files: [],
		...overrides,
	} as Subtask;
}

const STATUS = { exists: true, filesChanged: 9, additions: 90, deletions: 90 } as WorktreeStatus;
const DIFF = {
	files: [
		{ path: "a.ts", status: "modified", additions: 3, deletions: 1 },
		{ path: "b.ts", status: "added", additions: 2, deletions: 0 },
	],
	summary: "",
} as unknown as WorktreeDiff;

function logs(phases: Partial<Record<string, { status: string; entries: unknown[] }>>): TaskLogs {
	return {
		spec_id: "spec-1",
		created_at: "",
		updated_at: "",
		phases: {
			planning: { phase: "planning", status: "pending", started_at: null, completed_at: null, entries: [] },
			coding: { phase: "coding", status: "pending", started_at: null, completed_at: null, entries: [] },
			validation: { phase: "validation", status: "pending", started_at: null, completed_at: null, entries: [] },
			...Object.fromEntries(
				Object.entries(phases).map(([phase, value]) => [
					phase,
					{ phase, started_at: null, completed_at: null, ...value },
				]),
			),
		},
	} as unknown as TaskLogs;
}

let api: RendererApi;

function install(overrides: Record<string, unknown> = {}) {
	api.restore();
	api = installRendererApi(overrides);
}

function withProject() {
	useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
}

function hook(task: Task) {
	return renderHook(({ current }) => useTaskDetail({ task: current }), {
		initialProps: { current: task },
	});
}

const projectInitial = useProjectStore.getState();
const taskInitial = useTaskStore.getState();
const settingsInitial = useSettingsStore.getState();

beforeEach(() => {
	api = installRendererApi();
});

afterEach(async () => {
	api.restore();
	vi.useRealTimers();
	useProjectStore.setState(projectInitial, true);
	useTaskStore.setState(taskInitial, true);
	useSettingsStore.setState(settingsInitial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("the tab and the feedback", () => {
	it("opens on the overview, or on the tab a card asked for", () => {
		expect(hook(makeTask()).result.current.activeTab).toBe("overview");
		setPendingTaskDetailTab("logs");
		expect(hook(makeTask()).result.current.activeTab).toBe("logs");
		// The request is used once.
		expect(hook(makeTask()).result.current.activeTab).toBe("overview");
	});

	it("collects feedback images and removes them", () => {
		const { result } = hook(makeTask());
		const image = (id: string) => ({ id, filename: `${id}.png` }) as ImageAttachment;
		act(() => result.current.addFeedbackImage(image("a")));
		act(() => result.current.addFeedbackImages([image("b"), image("c")]));
		act(() => result.current.removeFeedbackImage("b"));
		expect(result.current.feedbackImages.map((i) => i.id)).toEqual(["a", "c"]);
		act(() => result.current.clearFeedbackImages());
		expect(result.current.feedbackImages).toEqual([]);
	});

	it("drops the feedback when the panel steps to another task", () => {
		const { result, rerender } = hook(makeTask());
		act(() => {
			result.current.setFeedback("Rename the button");
			result.current.addFeedbackImage({ id: "a" } as ImageAttachment);
		});
		rerender({ current: makeTask() });
		expect(result.current.feedback).toBe("Rename the button");

		rerender({ current: makeTask({ id: "t2", specId: "spec-2" }) });
		expect(result.current.feedback).toBe("");
		expect(result.current.feedbackImages).toEqual([]);
	});

	it("opening the logs tab follows the logs again", () => {
		const { result } = hook(makeTask());
		act(() => result.current.setIsUserScrolledUp(true));
		act(() => result.current.setActiveTab("logs"));
		expect(result.current.isUserScrolledUp).toBe(false);
	});

	it("derives what the task is doing", () => {
		const { result } = hook(
			makeTask({
				status: "in_progress",
				executionProgress: { phase: "coding" } as Task["executionProgress"],
				subtasks: [subtask("a", { status: "completed" }), subtask("b")],
			}),
		);
		expect(result.current).toMatchObject({
			isRunning: true,
			needsReview: false,
			executionPhase: "coding",
			hasActiveExecution: true,
			taskProgress: { completed: 1, total: 2, percentage: 50 },
		});
	});
});

describe("the worktree under review", () => {
	it("loads status and changes, with the counts the diff gives", async () => {
		install({
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: true, data: DIFF }),
		});
		const { result, rerender } = hook(makeTask({ status: "human_review" }));
		await waitFor(() => expect(result.current.isLoadingWorktree).toBe(false));
		expect(result.current.worktreeStatus).toMatchObject({
			filesChanged: 2,
			additions: 5,
			deletions: 1,
		});
		expect(result.current.worktreeDiff).toBe(DIFF);

		// Leaving review forgets them.
		rerender({ current: makeTask({ status: "done" }) });
		expect(result.current.worktreeStatus).toBeNull();
		expect(result.current.worktreeDiff).toBeNull();
	});

	it("keeps the status when the diff cannot be read, and survives a failure", async () => {
		install({
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: false, error: "no diff" }),
		});
		const { result } = hook(makeTask({ status: "human_review" }));
		await waitFor(() => expect(result.current.worktreeStatus).not.toBeNull());
		expect(result.current.worktreeStatus?.filesChanged).toBe(9);
		expect(result.current.worktreeDiff).toBeNull();

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({ getWorktreeStatus: async () => Promise.reject(new Error("ipc down")) });
		const failed = hook(makeTask({ id: "t2", status: "human_review" }));
		await waitFor(() => expect(failed.result.current.isLoadingWorktree).toBe(false));
		expect(error).toHaveBeenCalledWith("Failed to load worktree info:", expect.any(Error));
		expect(failed.result.current.worktreeStatus).toBeNull();
		error.mockRestore();
	});

	it("the conflict check loads the merge preview and refreshes the worktree", async () => {
		const preview = { files: ["a.ts"], conflicts: [], summary: { totalFiles: 1 } };
		install({
			mergeWorktreePreview: async () => ({ success: true, data: { success: true, preview } }),
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: true, data: DIFF }),
		});
		const { result, rerender } = hook(makeTask());
		await act(() => result.current.loadMergePreview());
		expect(result.current.mergePreview).toEqual(preview);
		expect(result.current.worktreeStatus?.filesChanged).toBe(2);
		expect(result.current.worktreeDiff).toBe(DIFF);
		expect(result.current.workspaceError).toBeNull();
		expect(result.current.isLoadingPreview).toBe(false);

		// The same task keeps it; another task starts without one.
		rerender({ current: makeTask() });
		expect(result.current.mergePreview).toEqual(preview);
		rerender({ current: makeTask({ id: "t2" }) });
		expect(result.current.mergePreview).toBeNull();
	});

	it("names each part that failed, in the app's language", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({
			mergeWorktreePreview: async () => ({ success: false, error: "git busy" }),
			getWorktreeStatus: async () => Promise.reject(new Error("gone")),
			getWorktreeDiff: async () => ({ success: false }),
		});
		const { result } = hook(makeTask());
		await act(() => result.current.loadMergePreview());
		expect(result.current.workspaceError).toBe(
			"Merge preview: git busy; Could not load: Worktree status",
		);
		expect(result.current.worktreeStatus).toBeNull();

		await act(async () => {
			await i18n.changeLanguage("fr");
		});
		await act(() => result.current.loadMergePreview());
		expect(result.current.workspaceError).toBe(
			"Aperçu de la fusion : git busy; Impossible de charger : État du worktree",
		);
		error.mockRestore();
	});

	it("an unexpected failure gives a general error", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({
			mergeWorktreePreview: async () => ({ success: true, data: { success: true } }),
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: true, data: { files: null } }),
		});
		const { result } = hook(makeTask());
		await act(() => result.current.loadMergePreview());
		expect(result.current.workspaceError).toBe(
			"An unexpected error occurred while loading the workspace information",
		);
		expect(result.current.isLoadingPreview).toBe(false);
		error.mockRestore();
	});

	it("reviewing again forgets the staged result and reloads", async () => {
		withProject();
		install({
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: true, data: DIFF }),
		});
		const { result } = hook(makeTask());
		act(() => {
			result.current.setStagedSuccess("Staged");
			result.current.setStagedProjectPath("/repo/one");
			result.current.setSuggestedCommitMessage("feat: x");
			result.current.setWorkspaceError("old");
		});
		await act(() => result.current.handleReviewAgain());
		expect(result.current).toMatchObject({
			stagedSuccess: null,
			stagedProjectPath: undefined,
			suggestedCommitMessage: undefined,
			workspaceError: null,
			isLoadingWorktree: false,
		});
		expect(result.current.worktreeStatus?.filesChanged).toBe(2);
		expect(api.fn("getTasks")).toHaveBeenCalledWith("p1", undefined);
	});

	it("reviewing again without a project or with a failing worktree read stays usable", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({
			getWorktreeStatus: async () => ({ success: false }),
			getWorktreeDiff: async () => ({ success: false }),
		});
		const { result } = hook(makeTask());
		await act(() => result.current.handleReviewAgain());
		expect(result.current.worktreeStatus).toBeNull();
		expect(api.fn("getTasks")).not.toHaveBeenCalled();

		install({ getWorktreeStatus: async () => Promise.reject(new Error("down")) });
		await act(() => result.current.handleReviewAgain());
		expect(error).toHaveBeenCalledWith("Failed to reload worktree info:", expect.any(Error));
		expect(result.current.isLoadingWorktree).toBe(false);
		error.mockRestore();
	});

	it("a light refresh rereads only the status and changes", async () => {
		install({
			getWorktreeStatus: async () => ({ success: true, data: { ...STATUS } }),
			getWorktreeDiff: async () => ({ success: true, data: DIFF }),
		});
		const { result } = hook(makeTask());
		await act(() => result.current.refreshWorktreeDiff());
		expect(result.current.worktreeStatus?.additions).toBe(5);
		expect(api.fn("mergeWorktreePreview")).not.toHaveBeenCalled();

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({ getWorktreeDiff: async () => Promise.reject(new Error("down")) });
		await act(() => result.current.refreshWorktreeDiff());
		expect(error).toHaveBeenCalledWith(
			"[useTaskDetail] Failed to refresh worktree diff:",
			expect.any(Error),
		);
		install({
			getWorktreeStatus: async () => ({ success: false }),
			getWorktreeDiff: async () => ({ success: false }),
		});
		await act(() => result.current.refreshWorktreeDiff());
		expect(result.current.worktreeStatus?.additions).toBe(5);
		error.mockRestore();
	});
});

describe("the phase logs", () => {
	it("load nothing without a project", () => {
		hook(makeTask());
		expect(api.fn("getTaskLogs")).not.toHaveBeenCalled();
	});

	it("open on the active phase and follow its changes", async () => {
		withProject();
		let onChanged: (specId: string, logs: TaskLogs) => void = () => undefined;
		const perLlm = [{ provider: "anthropic", model: "m", logs: logs({}) }];
		install({
			getTaskLogs: async () => ({
				success: true,
				data: logs({ coding: { status: "active", entries: [] } }),
			}),
			getTaskLogsPerLlm: async () => ({ success: true, data: perLlm }),
			onTaskLogsChanged: (callback: typeof onChanged) => {
				onChanged = callback;
				return () => undefined;
			},
		});
		const { result, unmount } = hook(makeTask());
		await waitFor(() => expect(result.current.isLoadingLogs).toBe(false));
		expect([...result.current.expandedPhases]).toEqual(["coding"]);
		expect(result.current.perLlmLogs).toBe(perLlm);
		expect(api.fn("watchTaskLogs")).toHaveBeenCalledWith("p1", "spec-1");

		// Another task's logs are not ours.
		act(() => onChanged("spec-other", logs({ validation: { status: "active", entries: [] } })));
		expect([...result.current.expandedPhases]).toEqual(["coding"]);

		const next = logs({ validation: { status: "active", entries: [] } });
		act(() => onChanged("spec-1", next));
		expect(result.current.phaseLogs).toBe(next);
		expect([...result.current.expandedPhases].sort()).toEqual(["coding", "validation"]);
		await waitFor(() =>
			expect(api.fn("getTaskLogsPerLlm")).toHaveBeenCalledTimes(2),
		);

		// A change with no active phase expands nothing more.
		act(() => onChanged("spec-1", logs({})));
		expect(result.current.expandedPhases.size).toBe(2);

		unmount();
		expect(api.fn("unwatchTaskLogs")).toHaveBeenCalledWith("spec-1");
	});

	it("a finished task opens every phase that has entries", async () => {
		withProject();
		install({
			getTaskLogs: async () => ({
				success: true,
				data: logs({
					planning: { status: "completed", entries: [{}] },
					validation: { status: "completed", entries: [{}] },
				}),
			}),
			getTaskLogsPerLlm: async () => ({ success: false }),
		});
		const { result } = hook(makeTask());
		await waitFor(() => expect(result.current.isLoadingLogs).toBe(false));
		expect([...result.current.expandedPhases]).toEqual(["planning", "validation"]);
		expect(result.current.perLlmLogs).toEqual([]);
	});

	it("an empty or unreadable log opens nothing", async () => {
		withProject();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({ getTaskLogs: async () => ({ success: true, data: logs({}) }) });
		const empty = hook(makeTask());
		await waitFor(() => expect(empty.result.current.isLoadingLogs).toBe(false));
		expect(empty.result.current.expandedPhases.size).toBe(0);

		install({ getTaskLogs: async () => Promise.reject(new Error("no file")) });
		const failed = hook(makeTask({ specId: "spec-2" }));
		await waitFor(() => expect(failed.result.current.isLoadingLogs).toBe(false));
		expect(error).toHaveBeenCalledWith("Failed to load task logs:", expect.any(Error));
		error.mockRestore();
	});

	it("a failed per-model refresh keeps the logs", async () => {
		withProject();
		let onChanged: (specId: string, logs: TaskLogs) => void = () => undefined;
		const perLlm = vi
			.fn()
			.mockResolvedValueOnce({ success: true, data: [] })
			.mockRejectedValueOnce(new Error("gone"))
			.mockResolvedValueOnce({ success: false });
		install({
			getTaskLogs: async () => ({ success: false }),
			getTaskLogsPerLlm: perLlm,
			onTaskLogsChanged: (callback: typeof onChanged) => {
				onChanged = callback;
				return () => undefined;
			},
		});
		const { result } = hook(makeTask());
		await waitFor(() => expect(result.current.isLoadingLogs).toBe(false));
		const next = logs({});
		act(() => onChanged("spec-1", next));
		act(() => onChanged("spec-1", next));
		await waitFor(() => expect(perLlm).toHaveBeenCalledTimes(3));
		expect(result.current.phaseLogs).toBe(next);
		expect(result.current.perLlmLogs).toEqual([]);
	});

	it("a phase folds and unfolds", () => {
		const { result } = hook(makeTask());
		act(() => result.current.togglePhase("coding"));
		expect(result.current.expandedPhases.has("coding")).toBe(true);
		act(() => result.current.togglePhase("coding"));
		expect(result.current.expandedPhases.has("coding")).toBe(false);
	});
});

describe("following the logs while scrolling", () => {
	function scroll(
		result: { current: ReturnType<typeof useTaskDetail> },
		target: Partial<HTMLDivElement>,
	) {
		act(() =>
			result.current.handleLogsScroll({ target } as unknown as UIEvent<HTMLDivElement>),
		);
		return result.current.isUserScrolledUp;
	}

	it("without an active phase, the anchor is the end of the log", () => {
		const { result } = hook(makeTask());
		expect(scroll(result, { scrollHeight: 1000, scrollTop: 950, clientHeight: 0 })).toBe(false);
		expect(scroll(result, { scrollHeight: 1000, scrollTop: 0, clientHeight: 400 })).toBe(true);
	});

	it("in reverse order the anchor is the top", () => {
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, logOrder: "reverse-chronological" },
		});
		const { result } = hook(makeTask());
		expect(scroll(result, { scrollTop: 50 })).toBe(false);
		expect(scroll(result, { scrollTop: 500 })).toBe(true);
	});

	it("with an active phase, the anchor is that phase's edge", () => {
		const { result } = hook(makeTask());
		const container = document.createElement("div");
		const section = document.createElement("div");
		section.dataset.phaseSection = "coding";
		container.append(section);
		result.current.logsContainerRef.current = container;
		act(() => result.current.setPhaseLogs(logs({ coding: { status: "active", entries: [] } })));

		const rect = (top: number, bottom: number) => () => ({ top, bottom }) as DOMRect;
		section.getBoundingClientRect = rect(0, 900);
		const target = { getBoundingClientRect: rect(0, 850) } as Partial<HTMLDivElement>;
		expect(scroll(result, target)).toBe(false);
		section.getBoundingClientRect = rect(0, 2000);
		expect(scroll(result, target)).toBe(true);

		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, logOrder: "reverse-chronological" },
		});
		section.getBoundingClientRect = rect(60, 900);
		expect(scroll(result, target)).toBe(false);
		section.getBoundingClientRect = rect(-400, 900);
		expect(scroll(result, target)).toBe(true);
	});
});

describe("running, stuck and paused", () => {
	it("a running task with no activity for a minute and no process is stuck", async () => {
		vi.useFakeTimers();
		install({ checkTaskRunning: async () => ({ success: true, data: false }) });
		const { result } = hook(makeTask({ status: "in_progress" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(result.current.isStuck).toBe(true);
		expect(result.current.hasCheckedRunning).toBe(true);
	});

	it("a task still alive, or active again, is not stuck", async () => {
		vi.useFakeTimers();
		const running = vi.fn(async () => ({ success: true, data: true }));
		install({ checkTaskRunning: running });
		const { result } = hook(makeTask({ status: "ai_review" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(result.current.isStuck).toBe(false);

		// Activity seen just before the check: no process check at all.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(59_000);
		});
		recordTaskActivity("t1");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(running).toHaveBeenCalledOnce();
		expect(result.current.isStuck).toBe(false);
	});

	it("activity that arrives during the check wins over a dead process", async () => {
		vi.useFakeTimers();
		install({
			checkTaskRunning: async () => {
				recordTaskActivity("t9");
				return { success: true, data: false };
			},
		});
		const { result } = hook(makeTask({ id: "t9", status: "in_progress" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(result.current.isStuck).toBe(false);
		expect(result.current.hasCheckedRunning).toBe(true);
	});

	it("a task that stops running is no longer stuck", async () => {
		vi.useFakeTimers();
		install({ checkTaskRunning: async () => ({ success: true, data: false }) });
		const { result, rerender } = hook(makeTask({ id: "t3", status: "in_progress" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(result.current.isStuck).toBe(true);
		rerender({ current: makeTask({ id: "t3", status: "done" }) });
		expect(result.current.isStuck).toBe(false);
		expect(result.current.hasCheckedRunning).toBe(false);
	});

	it("a paused task is never stuck, and its process is polled", async () => {
		vi.useFakeTimers();
		const running = vi
			.fn()
			.mockResolvedValueOnce({ success: true, data: true })
			.mockResolvedValue({ success: true, data: false });
		install({ checkTaskRunning: running });
		const paused = makeTask({
			id: "t4",
			status: "in_progress",
			metadata: { paused: { enabled: true } } as Task["metadata"],
		});
		const { result, rerender, unmount } = hook(paused);
		expect(result.current.isPaused).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current.pauseProcessAlive).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_000);
		});
		expect(result.current.pauseProcessAlive).toBe(false);
		expect(result.current.isStuck).toBe(false);

		rerender({ current: makeTask({ id: "t4", status: "in_progress" }) });
		expect(result.current.pauseProcessAlive).toBeNull();
		unmount();
	});

	it("an answer that arrives after the pause ends is dropped", async () => {
		let answer: (value: unknown) => void = () => undefined;
		install({
			checkTaskRunning: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		});
		const paused = makeTask({
			id: "t5",
			status: "in_progress",
			metadata: { paused: { enabled: true } } as Task["metadata"],
		});
		const { result, unmount } = hook(paused);
		unmount();
		await act(async () => answer({ success: true, data: true }));
		expect(result.current.pauseProcessAlive).toBeNull();
	});

	it("QA starting after a review reloads the tasks from disk", () => {
		withProject();
		const { rerender } = hook(makeTask({ status: "human_review" }));
		rerender({ current: makeTask({ status: "in_progress" }) });
		expect(api.fn("getTasks")).toHaveBeenCalledWith("p1", { forceRefresh: true });
	});

	it("without a project, no reload", () => {
		const { rerender } = hook(makeTask({ status: "human_review" }));
		rerender({ current: makeTask({ status: "in_progress" }) });
		expect(api.fn("getTasks")).not.toHaveBeenCalled();
	});
});

describe("reloading the plan of an incomplete task", () => {
	const incomplete = (overrides: Partial<Task> = {}) =>
		makeTask({ status: "human_review", subtasks: [], ...overrides });

	async function reload(task: Task) {
		const { result } = hook(task);
		let value: boolean | undefined;
		await act(async () => {
			value = await result.current.reloadPlanForIncompleteTask();
		});
		return { value, result };
	}

	it("needs a project", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await reload(incomplete())).value).toBe(false);
		error.mockRestore();
	});

	it("does nothing for a complete task or a valid plan", async () => {
		withProject();
		expect((await reload(makeTask())).value).toBe(true);
		const valid = incomplete({ subtasks: [subtask("a")] });
		expect((await reload(valid)).value).toBe(true);
		expect(api.fn("getTasks")).not.toHaveBeenCalled();
	});

	it("reloads the plan and puts the fresh subtasks in the store", async () => {
		withProject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const task = incomplete({ subtasks: [subtask("a", { description: " " })] });
		useTaskStore.setState({ tasks: [task] });
		const fresh = { ...task, title: "Fresh", subtasks: [subtask("a"), subtask("b")] };
		install({ getTasks: async () => ({ success: true, data: [fresh] }) });
		const { value, result } = await reload(task);
		expect(value).toBe(true);
		expect(result.current.isLoadingPlan).toBe(false);
		const stored = useTaskStore.getState().tasks[0];
		expect(stored.title).toBe("Fresh");
		expect(stored.subtasks).toHaveLength(2);
		warn.mockRestore();
	});

	it("refuses when the reload fails, loses the task or still finds a broken plan", async () => {
		withProject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const broken: Array<Partial<Subtask> | null> = [
			null,
			{ description: "" },
			{ id: "" },
		];
		const cases: unknown[] = [
			{ success: false, error: "disk" },
			{ success: true, data: [] },
			{ success: true, data: [incomplete({ id: "t1", subtasks: [] })] },
			...broken.map((item) => ({
				success: true,
				data: [
					incomplete({
						subtasks: [
							item === null ? null : subtask("x", item),
						] as unknown as Subtask[],
					}),
				],
			})),
			{ success: true, data: [incomplete({ subtasks: undefined })] },
		];
		for (const answer of cases) {
			install({ getTasks: async () => answer });
			expect((await reload(incomplete())).value, JSON.stringify(answer)).toBe(false);
		}
		install({ getTasks: async () => Promise.reject(new Error("ipc")) });
		expect((await reload(incomplete())).value).toBe(false);
		expect(error).toHaveBeenCalledWith(
			"[reloadPlanForIncompleteTask] Error reloading plan:",
			expect.any(Error),
		);
		warn.mockRestore();
		error.mockRestore();
	});
});
