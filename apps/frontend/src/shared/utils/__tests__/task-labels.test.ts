/**
 * A card's labels: cleaned the same way wherever they come from, and the
 * board's labels listed once each.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { boardLabels, cleanLabel, cleanLabels, MAX_LABEL_LENGTH, MAX_LABELS, taskLabels } from "../task-labels";

describe("cleanLabel", () => {
	it("trims a label and collapses its spaces, and refuses what is not one", () => {
		expect(cleanLabel("  front   end ")).toBe("front end");
		expect(cleanLabel("x".repeat(MAX_LABEL_LENGTH))).toHaveLength(MAX_LABEL_LENGTH);
		expect(cleanLabel("x".repeat(MAX_LABEL_LENGTH + 1))).toBeNull();
		expect(cleanLabel("   ")).toBeNull();
		expect(cleanLabel("tab\there")).toBeNull();
		expect(cleanLabel("del\u007f")).toBeNull();
		expect(cleanLabel(12)).toBeNull();
	});
});

describe("cleanLabels and taskLabels", () => {
	it("keeps valid labels once each, whatever their case, and no more than the limit", () => {
		expect(cleanLabels(["UI", "ui", " api ", 3, "bad\nlabel", "api"])).toEqual(["UI", "api"]);
		expect(cleanLabels(Array.from({ length: 20 }, (_, i) => `l${i}`))).toHaveLength(MAX_LABELS);
		expect(cleanLabels("ui")).toEqual([]);
		expect(taskLabels({ metadata: { labels: ["a", "a"] } } as Task)).toEqual(["a"]);
		expect(taskLabels({} as Task)).toEqual([]);
	});
});

describe("boardLabels", () => {
	it("lists every label of the board once, sorted", () => {
		const cards = [{ metadata: { labels: ["web", "API"] } }, { metadata: { labels: ["api", "docs"] } }, {}] as Task[];
		expect(boardLabels(cards)).toEqual(["API", "docs", "web"]);
	});
});
