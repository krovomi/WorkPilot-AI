/**
 * How full a column is, and its accent: the accent repeated here must be the
 * one the `.column-*` rules of styles/globals.css give the cards' rail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../shared/constants/task";
import { COLUMN_ACCENTS, columnCapacity } from "./kanban-column-meta";

const CSS = readFileSync(join(__dirname, "..", "styles", "globals.css"), "utf-8");

describe("column capacity", () => {
	it("has none without a limit", () => {
		expect(columnCapacity(3, undefined, "wip")).toBeNull();
		expect(columnCapacity(3, 0, "slots")).toBeNull();
	});

	it("warns on full slots, the hard limit of « En cours »", () => {
		expect(columnCapacity(1, 3, "slots")).toMatchObject({ state: "open", warn: false, fill: 33 });
		expect(columnCapacity(3, 3, "slots")).toMatchObject({ state: "full", warn: true, fill: 100 });
		expect(columnCapacity(4, 3, "slots")).toMatchObject({ state: "over", warn: true, fill: 100 });
	});

	it("warns on a WIP limit only once it is exceeded", () => {
		expect(columnCapacity(2, 2, "wip")).toMatchObject({ state: "full", warn: false });
		expect(columnCapacity(3, 2, "wip")).toMatchObject({ state: "over", warn: true, limit: 2, kind: "wip" });
	});
});

describe("column accents", () => {
	it("match the .column-* rules of globals.css", () => {
		const cls: Record<string, string> = {
			backlog: "backlog",
			queue: "queue",
			in_progress: "in-progress",
			ai_review: "ai-review",
			human_review: "human-review",
			build_failed: "build-failed",
			pr_created: "pr-open",
			done: "done",
		};
		for (const status of TASK_STATUS_COLUMNS) {
			const rule = new RegExp(`\\.column-${cls[status]}\\s*\\{[^}]*--col-accent:\\s*([^;]+);`).exec(CSS);
			expect(rule, status).not.toBeNull();
			const accent = COLUMN_ACCENTS[status];
			const expected = "color" in accent ? accent.color : `var(${accent.token})`;
			expect(rule?.[1].trim().toLowerCase(), status).toBe(expected.toLowerCase());
		}
	});
});
