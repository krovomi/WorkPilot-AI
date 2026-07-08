import { describe, expect, it } from "vitest";
import type { DebtItem } from "../../preload/api/modules/tech-debt-api";
import { buildDebtTaskSpec } from "./debt-task-spec";

function makeItem(overrides: Partial<DebtItem> = {}): DebtItem {
	return {
		id: "item-1",
		kind: "duplication",
		file_path: "src/foo.cs",
		line: 13,
		message: "Block duplicated in 3960 locations",
		cost: 3960,
		effort: 1.5,
		roi: 2640,
		tags: ["dup"],
		context: "",
		...overrides,
	};
}

describe("buildDebtTaskSpec", () => {
	it("builds a bilingual title prefixed with the debt marker", () => {
		expect(buildDebtTaskSpec(makeItem(), "fr").title).toBe(
			"Dette technique : Block duplicated in 3960 locations",
		);
		expect(buildDebtTaskSpec(makeItem(), "en").title).toBe(
			"Tech debt : Block duplicated in 3960 locations",
		);
	});

	it("truncates long messages in the title", () => {
		const long = "x".repeat(200);
		const { title } = buildDebtTaskSpec(makeItem({ message: long }), "en");
		expect(title.endsWith("…")).toBe(true);
		expect(title.length).toBeLessThan(100);
	});

	it("embeds the location, ROI and acceptance criteria in the description", () => {
		const { description } = buildDebtTaskSpec(makeItem(), "en");
		expect(description).toContain("`src/foo.cs:13`");
		expect(description).toContain("ROI: **2640**");
		expect(description).toContain("Acceptance criteria");
		expect(description).toContain("no longer appears in the next tech debt scan");
	});

	it("includes a context block only when context is present", () => {
		expect(buildDebtTaskSpec(makeItem(), "fr").description).not.toContain(
			"### Contexte",
		);
		const withCtx = buildDebtTaskSpec(
			makeItem({ context: "int a = 1;" }),
			"fr",
		).description;
		expect(withCtx).toContain("### Contexte");
		expect(withCtx).toContain("int a = 1;");
	});

	it("falls back to the raw kind when unknown", () => {
		const { description } = buildDebtTaskSpec(
			makeItem({ kind: "mystery" as DebtItem["kind"] }),
			"en",
		);
		expect(description).toContain("**mystery**");
	});
});
