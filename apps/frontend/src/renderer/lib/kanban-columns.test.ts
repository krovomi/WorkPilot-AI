/**
 * « PR ouverte » column: where each status is drawn and where a person may
 * move a card by hand.
 */
import { describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../shared/constants";
import {
	canMoveTaskTo,
	emptyColumnGroups,
	getVisualColumn,
	manualMoveTargets,
	VALID_BULK_TRANSITIONS,
} from "./kanban-columns";

describe("getVisualColumn", () => {
	it("draws an open PR in its own column, between Red build and Done", () => {
		expect(getVisualColumn("pr_created")).toBe("pr_created");
		const order = [...TASK_STATUS_COLUMNS];
		expect(order.indexOf("pr_created")).toBe(order.indexOf("done") - 1);
		expect(order.indexOf("pr_created")).toBeGreaterThan(
			order.indexOf("human_review"),
		);
	});

	it("still draws an error under Human review", () => {
		expect(getVisualColumn("error")).toBe("human_review");
	});
});

describe("emptyColumnGroups", () => {
	it("has one empty list per column", () => {
		const groups = emptyColumnGroups();
		expect(Object.keys(groups)).toEqual([...TASK_STATUS_COLUMNS]);
		expect(Object.values(groups).every((list) => list.length === 0)).toBe(
			true,
		);
	});
});

describe("canMoveTaskTo", () => {
	it("refuses Open PR to a card without a pull request", () => {
		expect(canMoveTaskTo({ status: "human_review" }, "pr_created")).toBe(false);
		expect(
			canMoveTaskTo({ status: "human_review", metadata: {} }, "pr_created"),
		).toBe(false);
	});

	it("accepts Open PR once the card has a pull request", () => {
		expect(
			canMoveTaskTo(
				{
					status: "done",
					metadata: { prUrl: "https://github.com/o/r/pull/1" },
				},
				"pr_created",
			),
		).toBe(true);
	});

	it("never offers the column the card is already in", () => {
		expect(canMoveTaskTo({ status: "done" }, "done")).toBe(false);
	});
});

describe("manualMoveTargets", () => {
	it("leaves Open PR out of the menu of a card without a PR", () => {
		const targets = manualMoveTargets({ status: "human_review" });
		expect(targets).not.toContain("pr_created");
		expect(targets).not.toContain("human_review");
		expect(targets).toContain("done");
	});

	it("lets an open PR be marked done by hand", () => {
		const targets = manualMoveTargets({
			status: "pr_created",
			metadata: { prUrl: "https://github.com/o/r/pull/1" },
		});
		expect(targets).toContain("done");
		expect(targets).not.toContain("pr_created");
		expect(VALID_BULK_TRANSITIONS.pr_created).toEqual(["done"]);
	});
});
