import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { shouldShowBuildFailedColumn } from "../useVisibleKanbanColumns";

const task = (id: string, status: Task["status"]) => ({ id, status }) as Task;

describe("shouldShowBuildFailedColumn", () => {
	it("hides the column on a board with no CI run and no red task", () => {
		expect(
			shouldShowBuildFailedColumn([task("a", "done"), task("b", "backlog")], {}),
		).toBe(false);
	});

	it("ignores tasks whose branch has no pipeline run", () => {
		expect(
			shouldShowBuildFailedColumn([task("a", "done")], { a: { state: "none" } }),
		).toBe(false);
	});

	it("shows the column as soon as one task has a CI run", () => {
		expect(
			shouldShowBuildFailedColumn([task("a", "pr_created")], {
				a: { state: "succeeded" },
			}),
		).toBe(true);
	});

	it("always shows the column while a task sits in it", () => {
		expect(shouldShowBuildFailedColumn([task("a", "build_failed")], {})).toBe(
			true,
		);
	});
});
