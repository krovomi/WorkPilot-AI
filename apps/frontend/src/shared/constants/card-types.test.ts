import { describe, expect, it } from "vitest";
import type { TaskMetadata } from "../types/task";
import { CARD_TYPES, resolveCardType } from "./card-types";

const resolve = (m: Partial<TaskMetadata>) =>
	resolveCardType(m as TaskMetadata);

describe("resolveCardType", () => {
	it("has fourteen types, each with its own colour", () => {
		expect(CARD_TYPES).toHaveLength(14);
		expect(new Set(CARD_TYPES.map((t) => t.color)).size).toBe(14);
	});

	it("stays neutral without information", () => {
		expect(resolveCardType(undefined)).toBeNull();
		expect(resolve({})).toBeNull();
		expect(resolve({ kind: "feature", kindSource: "default" })).toBeNull();
	});

	it.each([
		[{ kind: "hotfix", kindSource: "keywords", category: "bug_fix" }, "hotfix"],
		[{ kind: "refactoring", kindSource: "keywords", category: "security" }, "security"],
		[{ kind: "feature", kindSource: "keywords", securitySeverity: "high" }, "security"],
		[{ kind: "feature", kindSource: "keywords", category: "bug_fix" }, "bug"],
		[{ kind: "run", kindSource: "category", category: "infrastructure" }, "run"],
		[{ kind: "feature", kindSource: "keywords", category: "ui_ux" }, "ux"],
		[{ category: "performance" }, "perf"],
		[{ category: "documentation" }, "docs"],
		[{ kind: "upgrade", kindSource: "keywords" }, "upgrade"],
		[{ kind: "feature", kindSource: "keywords" }, "feature"],
		[{ jiraType: "Bug" }, "bug"],
		[{ azureDevOpsType: "User Story" }, null],
		[{ sourceType: "flaky-tests" }, "test"],
		[{ sourceType: "tech-debt" }, "refactor"],
	] as const)("%o → %s", (meta, expected) => {
		expect(resolve(meta as Partial<TaskMetadata>)?.type ?? null).toBe(expected);
	});

	it("keeps the user's own choice over everything", () => {
		const r = resolve({
			kind: "docs",
			kindSource: "user",
			category: "security",
			securitySeverity: "critical",
		});
		expect(r).toEqual({
			type: "docs",
			proposed: false,
			secondary: ["security"],
			basis: "user",
		});
	});

	it("marks a hesitant kind as proposed, never a category", () => {
		expect(resolve({ kind: "spike", kindSource: "keywords", kindConfidence: 0.4 })).toMatchObject({
			type: "spike",
			proposed: true,
			basis: "keywords",
		});
		expect(
			resolve({ kind: "feature", kindSource: "keywords", kindConfidence: 0.4, category: "testing" }),
		).toMatchObject({ type: "test", proposed: false, basis: "category" });
	});

	it("lists the other types as secondary, without repeating the primary", () => {
		expect(
			resolve({ kind: "bug_fix", kindSource: "keywords", category: "performance" }),
		).toMatchObject({ type: "bug", secondary: ["perf"] });
		expect(
			resolve({ kind: "bug_fix", kindSource: "import", category: "bug_fix" }),
		).toMatchObject({ type: "bug", secondary: [], basis: "category" });
	});

	it("says what decided it", () => {
		expect(resolve({ securitySeverity: "low" })?.basis).toBe("severity");
		expect(resolve({ jiraType: "Bug" })?.basis).toBe("import");
		expect(resolve({ sourceType: "flaky-tests" })?.basis).toBe("origin");
		expect(resolve({ kind: "test", kindSource: "category" })?.basis).toBe("category");
	});
});
