/**
 * What the learned suppressions add to a saved review (#361), read back with
 * only their known fields, whatever the file holds.
 */
import { describe, expect, it } from "vitest";
import { reviewFromJson } from "../review-result";

function review(extra: Record<string, unknown>, finding: Record<string, unknown> = {}) {
	return JSON.stringify({
		pr_number: 1,
		repo: "o/r",
		success: true,
		findings: [
			{
				id: "f",
				severity: "low",
				category: "style",
				title: "t",
				description: "d",
				file: "a.py",
				line: 1,
				...finding,
			},
		],
		...extra,
	});
}

describe("learned feedback in a saved review", () => {
	it("keeps a downgrade count, drops anything else", () => {
		expect(
			reviewFromJson(review({}, { learned_rejections: 4 })).findings[0]
				.learnedRejections,
		).toBe(4);
		for (const value of [0, "4", null]) {
			expect(
				reviewFromJson(review({}, { learned_rejections: value })).findings[0]
					.learnedRejections,
			).toBeUndefined();
		}
	});

	it("reads the dropped findings to their known fields", () => {
		const result = reviewFromJson(
			review({
				learned_suppressions: [
					{
						id: "x",
						title: "Prefer early return",
						category: "style",
						severity: "low",
						file: "b.ts",
						line: 9,
						rejections: 6,
						extra: "<script>",
					},
					{ title: "Bare" },
					{ title: 42 },
					null,
					"nope",
				],
			}),
		);
		expect(result.learnedSuppressions).toEqual([
			{
				id: "x",
				title: "Prefer early return",
				category: "style",
				severity: "low",
				file: "b.ts",
				line: 9,
				rejections: 6,
			},
			{
				id: "",
				title: "Bare",
				category: "",
				severity: "",
				file: "",
				line: 0,
				rejections: 0,
			},
		]);
	});

	it("is empty when the field is missing or not a list", () => {
		expect(reviewFromJson(review({})).learnedSuppressions).toEqual([]);
		expect(
			reviewFromJson(review({ learned_suppressions: { a: 1 } }))
				.learnedSuppressions,
		).toEqual([]);
	});
});
