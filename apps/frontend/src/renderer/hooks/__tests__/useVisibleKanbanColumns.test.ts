import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
	occupiedOutcomeColumns,
	shouldShowBuildFailedColumn,
	shouldShowPrOpenColumn,
} from "../useVisibleKanbanColumns";

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

describe("shouldShowPrOpenColumn", () => {
	it("hides the column while no PR waits to be merged", () => {
		expect(
			shouldShowPrOpenColumn([task("a", "done"), task("b", "human_review")]),
		).toBe(false);
	});

	it("shows the column as soon as a card has an open PR", () => {
		expect(
			shouldShowPrOpenColumn([task("a", "done"), task("b", "pr_created")]),
		).toBe(true);
	});
});

describe("occupiedOutcomeColumns", () => {
	it("lists Failed and Abandoned only while a live task sits there", () => {
		expect(occupiedOutcomeColumns([task("a", "backlog")])).toEqual(new Set());
		expect(
			occupiedOutcomeColumns([
				task("b", "error"),
				{ ...task("c", "queue"), metadata: { abandoned: true } } as Task,
			]),
		).toEqual(new Set(["failed", "abandoned"]));
	});

	it("ignores an archived task", () => {
		const archived = {
			...task("d", "error"),
			metadata: { archivedAt: "2026-11-01" },
		} as Task;
		expect(occupiedOutcomeColumns([archived])).toEqual(new Set());
	});
});
