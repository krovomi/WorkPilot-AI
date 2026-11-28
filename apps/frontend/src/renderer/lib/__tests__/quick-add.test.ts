import { describe, expect, it } from "vitest";
import { resolveCardType } from "../../../shared/constants/card-types";
import type { TaskEngine } from "../../../shared/types";
import { isQuickAddColumn } from "../kanban-columns";
import {
	buildQuickAddItems,
	QUICK_ADD_MAX_CARDS,
	QUICK_ADD_TITLE_MAX,
	quickAddLines,
	quickAddMetadata,
	splitsByDefault,
} from "../quick-add";

const trio = { provider: "anthropic", model: "sonnet", effort: "medium" };
const engine: TaskEngine = {
	spec: trio,
	planning: trio,
	coding: trio,
	qa: trio,
} as TaskEngine;

describe("quick add", () => {
	it("is offered in the planning, queue and in-progress columns only", () => {
		expect(isQuickAddColumn("backlog")).toBe(true);
		expect(isQuickAddColumn("queue")).toBe(true);
		expect(isQuickAddColumn("in_progress")).toBe(true);
		for (const status of [
			"ai_review",
			"human_review",
			"build_failed",
			"pr_created",
			"done",
		] as const) {
			expect(isQuickAddColumn(status)).toBe(false);
		}
	});

	it("reads a pasted list without its markers", () => {
		expect(
			quickAddLines("- Export CSV\n\n* Fix filter\n• Docs\n2) Tests\n[x] Done\n"),
		).toEqual(["Export CSV", "Fix filter", "Docs", "Tests", "Done"]);
	});

	it("splits a list of short lines, not a long description", () => {
		expect(splitsByDefault("Export CSV\nFix the filter")).toBe(true);
		expect(splitsByDefault("Export CSV")).toBe(false);
		const long = "x".repeat(QUICK_ADD_TITLE_MAX + 1);
		expect(splitsByDefault(`Context first\n${long}`)).toBe(false);
		// Typed lines are a title and its description: one card.
		expect(splitsByDefault("Export CSV\nFix the filter", false)).toBe(false);
	});

	it("makes a short line the title and keeps it as the description", () => {
		expect(buildQuickAddItems("  Export the board as CSV ", false)).toEqual([
			{ title: "Export the board as CSV", description: "Export the board as CSV" },
		]);
	});

	it("makes the first line of a multi-line text the title, the whole text the description", () => {
		// Report of 28 November: the description typed under the title was lost.
		expect(buildQuickAddItems("Just tell me if you see this ticket?\nIt is #1405, on GitHub", false)).toEqual([
			{
				title: "Just tell me if you see this ticket?",
				description: "Just tell me if you see this ticket?\nIt is #1405, on GitHub",
			},
		]);
	});

	it("leaves the title to the generator when the first line is too long for one", () => {
		const long = "y".repeat(QUICK_ADD_TITLE_MAX + 1);
		expect(buildQuickAddItems(long, false)).toEqual([
			{ title: "", description: long },
		]);
		expect(buildQuickAddItems(`${long}\nmore`, false)).toEqual([
			{ title: "", description: `${long}\nmore` },
		]);
	});

	it("creates one card per line when split, capped", () => {
		expect(buildQuickAddItems("A\nB", true)).toEqual([
			{ title: "A", description: "A" },
			{ title: "B", description: "B" },
		]);
		const many = Array.from({ length: QUICK_ADD_MAX_CARDS + 5 }, (_, i) => `Card ${i}`);
		expect(buildQuickAddItems(many.join("\n"), true)).toHaveLength(
			QUICK_ADD_MAX_CARDS,
		);
	});

	it("creates nothing from blank text", () => {
		expect(buildQuickAddItems("  \n ", false)).toEqual([]);
		expect(buildQuickAddItems("  \n ", true)).toEqual([]);
	});

	it("gives the card its own engine, priority and type", () => {
		const metadata = quickAddMetadata({ engine, type: "bug", priority: "high" });
		expect(metadata).toMatchObject({
			sourceType: "manual",
			engineLocked: true,
			provider: "anthropic",
			priority: "high",
			kind: "bug_fix",
			kindSource: "user",
		});
		expect(resolveCardType(metadata)?.type).toBe("bug");
	});

	it("leaves type and priority unset when none was picked", () => {
		const metadata = quickAddMetadata({ engine });
		expect(metadata.priority).toBeUndefined();
		expect(metadata.kind).toBeUndefined();
		expect(metadata.kindSource).toBeUndefined();
	});
});
