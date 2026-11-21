/**
 * The review's "Create Pull Request" keeps on the card what the main process
 * added while the PR was being created (CI/CD Triggers' run, the visual proof).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorktreeCreatePRResult } from "../../../../shared/types";
import { useTaskStore } from "../../../stores/task-store";
import { createTaskPR } from "../create-task-pr";

const PR_URL = "https://forge.example.test/team/demo/pull/1";
const cicdRun = {
	id: "1",
	provider: "jenkins",
	event: "pr",
	status: "triggered",
	triggeredAt: "2026-11-16T00:00:00.000Z",
} as const;

function makeTask(metadata: Task["metadata"]): Task {
	return { id: "task-1", specId: "001-demo", status: "human_review", metadata } as Task;
}

const createWorktreePR = vi.fn();

beforeEach(() => {
	createWorktreePR.mockReset();
	vi.stubGlobal("electronAPI", { createWorktreePR });
});

afterEach(() => {
	vi.unstubAllGlobals();
	useTaskStore.setState({ tasks: [] });
});

function answer(data: WorktreeCreatePRResult | undefined, success = true, error?: string) {
	createWorktreePR.mockResolvedValue({ success, data, error });
}

describe("createTaskPR", () => {
	it("keeps the run CI/CD Triggers added while the PR was created", async () => {
		const opened = makeTask({ sourceType: "manual" } as Task["metadata"]);
		// What the store holds when the answer comes: main's TASK_UPDATED_EVENT.
		useTaskStore.setState({
			tasks: [{ ...opened, metadata: { ...opened.metadata, cicdRun } } as Task],
		});
		answer({ success: true, prUrl: PR_URL });
		const busy = vi.fn();

		const result = await createTaskPR(opened, { title: "Demo" }, busy);

		expect(result).toEqual({ success: true, prUrl: PR_URL });
		expect(createWorktreePR).toHaveBeenCalledWith("task-1", { title: "Demo" });
		const [stored] = useTaskStore.getState().tasks;
		expect(stored.status).toBe("done");
		expect(stored.metadata).toEqual({ sourceType: "manual", cicdRun, prUrl: PR_URL });
		expect(busy.mock.calls).toEqual([[true], [false]]);
	});

	it("starts from the review's copy when the store does not hold the task", async () => {
		const opened = makeTask({ sourceType: "manual" } as Task["metadata"]);
		const other = makeTask(undefined);
		useTaskStore.setState({ tasks: [{ ...other, id: "task-2" }] });
		const updateTask = vi.spyOn(useTaskStore.getState(), "updateTask");
		answer({ success: true, prUrl: PR_URL });

		await createTaskPR(opened, {}, vi.fn());

		expect(updateTask).toHaveBeenCalledWith("task-1", {
			status: "done",
			metadata: { sourceType: "manual", prUrl: PR_URL },
		});
		updateTask.mockRestore();
	});

	it.each([
		["the PR already existed", { success: true, prUrl: PR_URL, alreadyExists: true }],
		["no URL came back", { success: true }],
		["the PR was not created", { success: false, error: "refused" }],
	])("leaves the card as it is when %s", async (_why, data) => {
		const opened = makeTask(undefined);
		useTaskStore.setState({ tasks: [opened] });
		answer(data);

		expect(await createTaskPR(opened, {}, vi.fn())).toEqual(data);
		expect(useTaskStore.getState().tasks[0]).toBe(opened);
	});

	it("passes on an IPC error, and a cross review that holds the PR back", async () => {
		const opened = makeTask(undefined);
		answer({ success: false, crossReviewBlocked: true }, false, "held");
		expect(await createTaskPR(opened, {}, vi.fn())).toEqual({
			success: false,
			error: "held",
			prUrl: undefined,
			alreadyExists: false,
			crossReviewBlocked: true,
		});

		answer(undefined, false, "no worktree");
		expect(await createTaskPR(opened, {}, vi.fn())).toMatchObject({
			error: "no worktree",
			crossReviewBlocked: false,
		});
	});

	it("turns a thrown error into a failed result, and clears the busy flag", async () => {
		const opened = makeTask(undefined);
		const busy = vi.fn();
		createWorktreePR.mockRejectedValueOnce(new Error("ipc down"));
		expect(await createTaskPR(opened, {}, busy)).toEqual({
			success: false,
			error: "ipc down",
			prUrl: undefined,
			alreadyExists: false,
		});
		expect(busy).toHaveBeenLastCalledWith(false);

		createWorktreePR.mockRejectedValueOnce("not an error");
		expect(await createTaskPR(opened, {}, vi.fn())).toMatchObject({ error: undefined });
	});
});
