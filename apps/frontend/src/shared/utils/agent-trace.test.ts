/**
 * The Agent Trace summary read from the spec directory is checked before
 * the diff view shows it (F3).
 */

import { describe, expect, it } from "vitest";
import type { WorktreeDiffFile } from "../types/task";
import { applyTraceSummary, parseTraceSummary, sharePercent } from "./agent-trace";

const file = (path: string): WorktreeDiffFile => ({
	path,
	status: "modified",
	additions: 10,
	deletions: 0,
});

describe("agent trace summary", () => {
	it("keeps counts only, and only where they make sense", () => {
		const parsed = parseTraceSummary(
			JSON.stringify({
				files: {
					"src/Cart.vue": { added: 10, ai: 8, human: 2, unknown: 0 },
					"bad.ts": "nope",
				},
				totals: { added: 10, ai: 8, human: -3, unknown: "x" },
				models: { "anthropic/claude-sonnet-5-5": 8 },
			}),
		);
		expect(parsed).toEqual({
			files: { "src/Cart.vue": { added: 10, ai: 8, human: 2, unknown: 0 } },
			totals: { added: 10, ai: 8, human: 0, unknown: 0 },
			models: { "anthropic/claude-sonnet-5-5": 8 },
		});
		expect(parseTraceSummary("{")).toBeNull();
		expect(parseTraceSummary("[]")).toBeNull();
		expect(parseTraceSummary(JSON.stringify({ files: {} }))).toBeNull();
	});

	it("puts each file's share on the diff, and nothing without a record", () => {
		const summary = parseTraceSummary(
			JSON.stringify({
				files: { "src/Cart.vue": { added: 10, ai: 8, human: 2, unknown: 0 } },
				totals: { added: 10, ai: 8, human: 2, unknown: 0 },
				models: {},
			}),
		);
		const applied = applyTraceSummary([file("src/Cart.vue"), file("README.md")], summary);
		expect(applied.files[0].attribution).toEqual({ added: 10, ai: 8, human: 2, unknown: 0 });
		expect(applied.files[1].attribution).toBeUndefined();
		expect(applied.attribution).toMatchObject({ added: 10, ai: 8 });
		expect(applyTraceSummary([file("a")], null)).toEqual({ files: [file("a")] });
		expect(sharePercent(8, 10)).toBe(80);
		expect(sharePercent(1, 0)).toBe(0);
	});
});
