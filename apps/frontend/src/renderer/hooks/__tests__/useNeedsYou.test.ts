import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";

const submitReview = vi.fn();
const startTask = vi.fn();
let tasks: Partial<Task>[] = [];

vi.mock("../../stores/task-store", () => ({
	submitReview: (...args: unknown[]) => submitReview(...args),
	startTask: (...args: unknown[]) => startTask(...args),
	useTaskStore: { getState: () => ({ tasks }) },
}));
vi.mock("../../stores/project-store", () => ({ useProjectStore: { getState: () => ({}) } }));

const { approvePlan } = await import("../useNeedsYou");

describe("approvePlan", () => {
	beforeEach(() => {
		submitReview.mockReset().mockResolvedValue(true);
		startTask.mockReset();
		tasks = [];
	});

	it("runs the Approve button's two steps", async () => {
		tasks = [{ id: "t1", status: "human_review", reviewReason: "plan_review" }];
		expect(await approvePlan("t1")).toBe("approved");
		expect(submitReview).toHaveBeenCalledWith("t1", true);
		expect(startTask).toHaveBeenCalledWith("t1");
	});

	it("approves nothing for a task the board shows elsewhere", async () => {
		tasks = [{ id: "t1", status: "in_progress" }];
		expect(await approvePlan("t1")).toBe("notPending");
		expect(submitReview).not.toHaveBeenCalled();
	});

	it("does not start a task whose review was refused", async () => {
		submitReview.mockResolvedValue(false);
		expect(await approvePlan("t1")).toBe("notPending");
		expect(startTask).not.toHaveBeenCalled();
	});
});
