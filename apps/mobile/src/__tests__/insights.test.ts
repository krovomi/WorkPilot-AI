import { digest, humanize, readSaved } from "../insights/digest";
import { count, duration, money, top } from "../insights/Figures";

describe("analysis digest", () => {
	it("keeps the headline numbers, one level deep, and the lists' first items", () => {
		const out = digest({
			score: 82.456,
			passed: true,
			summary: { total_issues: 3, critical: 1, nested: { too: "deep" } },
			issues: [
				{ title: "Missing alt", severity: "high", file: "a.tsx" },
				{ message: "Low contrast", impact: "medium" },
				"plain text",
			],
			empty: [],
			numbers: [1, 2, 3],
		});
		expect(out.figures).toEqual([
			{ label: "Score", value: "82.46" },
			{ label: "Passed", value: "✓" },
			{ label: "Summary · Total issues", value: "3" },
			{ label: "Summary · Critical", value: "1" },
		]);
		expect(out.lists).toHaveLength(1);
		expect(out.lists[0]).toMatchObject({ label: "Issues", total: 3 });
		expect(out.lists[0].items).toEqual([
			{ n: 0, title: "Missing alt", detail: "a.tsx", level: "high" },
			{ n: 1, title: "Low contrast", detail: null, level: "medium" },
			{ n: 2, title: "plain text", detail: null, level: null },
		]);
	});

	it("caps a long list", () => {
		const out = digest({ items: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` })) });
		expect(out.lists[0].total).toBe(50);
		expect(out.lists[0].items).toHaveLength(20);
	});

	it("shows nothing of what is not a report", () => {
		expect(digest(null)).toEqual({ figures: [], lists: [] });
		expect(digest([1, 2])).toEqual({ figures: [], lists: [] });
		expect(readSaved("{")).toBeNull();
		expect(readSaved("[]")).toBeNull();
		expect(readSaved('{"analysis":"i18n","report":{},"finished_at":null,"run_by":null}')?.analysis).toBe("i18n");
	});

	it("humanizes keys", () => {
		expect(humanize("missing_keys")).toBe("Missing keys");
		expect(humanize("totalIssues")).toBe("Total issues");
		expect(humanize("doc-drift")).toBe("Doc drift");
	});
});

describe("figures", () => {
	it("formats money, counts and durations", () => {
		expect(money(1.234)).toBe("$1.23");
		expect(money(null)).toBe("—");
		expect(count(1234.4, "en")).toBe("1,234");
		expect(duration(42)).toBe("42 s");
		expect(duration(600)).toBe("10 min");
		expect(duration(3_900)).toBe("1 h 5 min");
		expect(duration(null)).toBeNull();
	});

	it("lists the largest entries", () => {
		expect(top({ a: 1, b: 5, c: 0, d: 3 }, 2)).toEqual([
			["b", 5],
			["d", 3],
		]);
	});
});
