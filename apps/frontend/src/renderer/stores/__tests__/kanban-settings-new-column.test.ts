/**
 * A column added after the user saved their board (« PR ouverte ») must slot
 * into the saved order and preferences instead of resetting them.
 */
import { describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../../shared/constants";
import {
	DEFAULT_COLUMN_WIDTH,
	normalizeColumnOrder,
	withNewColumnPreferences,
} from "../kanban-settings-store";

const SAVED_BEFORE_PR_OPEN = [
	"done",
	"backlog",
	"queue",
	"in_progress",
	"ai_review",
	"human_review",
	"build_failed",
];

describe("normalizeColumnOrder", () => {
	it("keeps the user's order and slots the new column before its successor", () => {
		expect(normalizeColumnOrder(SAVED_BEFORE_PR_OPEN)).toEqual([
			"pr_created",
			"done",
			"backlog",
			"queue",
			"in_progress",
			"ai_review",
			"human_review",
			"build_failed",
		]);
	});

	it("leaves a complete order untouched", () => {
		expect(normalizeColumnOrder([...TASK_STATUS_COLUMNS])).toEqual([
			...TASK_STATUS_COLUMNS,
		]);
	});

	it("drops unknown and repeated entries", () => {
		expect(
			normalizeColumnOrder([...TASK_STATUS_COLUMNS, "error", "done", 4]),
		).toEqual([...TASK_STATUS_COLUMNS]);
	});

	it("refuses what is not a list of columns", () => {
		expect(normalizeColumnOrder(null)).toBeNull();
		expect(normalizeColumnOrder("done")).toBeNull();
		expect(normalizeColumnOrder(["nope"])).toBeNull();
	});
});

describe("withNewColumnPreferences", () => {
	it("adds a default entry for the new column and keeps the saved ones", () => {
		const saved = Object.fromEntries(
			SAVED_BEFORE_PR_OPEN.map((column) => [
				column,
				{ width: 400, isCollapsed: true, isLocked: false },
			]),
		);
		const prefs = withNewColumnPreferences(saved) as Record<
			string,
			{ width: number; isCollapsed: boolean }
		>;
		expect(prefs.pr_created).toEqual({
			width: DEFAULT_COLUMN_WIDTH,
			isCollapsed: false,
			isLocked: false,
		});
		expect(prefs.done).toEqual({
			width: 400,
			isCollapsed: true,
			isLocked: false,
		});
	});

	it("passes anything else through for the validator to refuse", () => {
		expect(withNewColumnPreferences(null)).toBeNull();
		expect(withNewColumnPreferences([1])).toEqual([1]);
	});
});
