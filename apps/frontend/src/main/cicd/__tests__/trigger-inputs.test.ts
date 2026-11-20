/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { isProviderRunId, runsLimit, triggerParams } from "../trigger-inputs";

describe("triggerParams", () => {
	it("keeps a known provider and the optional fields that are plain values", () => {
		expect(triggerParams({ provider: "github" })).toEqual({ provider: "github" });
		expect(
			triggerParams({
				provider: "gitlab",
				pr_url: "https://gitlab.example.test/acme/shop/-/merge_requests/4",
				branch: "feature/login",
				workflow: "deploy.yml",
			}),
		).toEqual({
			provider: "gitlab",
			pr_url: "https://gitlab.example.test/acme/shop/-/merge_requests/4",
			branch: "feature/login",
			workflow: "deploy.yml",
		});
		expect(triggerParams({ provider: "jenkins", pr_url: "", branch: null, workflow: undefined })).toEqual({
			provider: "jenkins",
		});
	});

	it.each([
		null,
		"github",
		["github"],
		{},
		{ provider: "GitHub" },
		{ provider: "circleci" },
		{ provider: 1 },
		{ provider: "github", pr_url: "javascript:alert(1)" },
		{ provider: "github", pr_url: "https://user:secret@github.com/a/b/pull/1" },
		{ provider: "github", pr_url: "not a url" },
		{ provider: "github", pr_url: `https://github.com/${"a".repeat(2048)}` },
		{ provider: "github", pr_url: 5 },
		{ provider: "github", branch: "--project=/etc" },
		{ provider: "github", branch: "a..b" },
		{ provider: "github", branch: "a b" },
		{ provider: "github", workflow: "--x" },
		{ provider: "github", workflow: "../../user/repos" },
		{ provider: "github", workflow: ".." },
	])("refuses %j", (value) => {
		expect(triggerParams(value)).toBeNull();
	});
});

describe("isProviderRunId", () => {
	it("is digits only", () => {
		expect(isProviderRunId("123456789")).toBe(true);
		for (const value of ["", "12a", "5/../../user", "1".repeat(21), 12, null]) {
			expect(isProviderRunId(value)).toBe(false);
		}
	});
});

describe("runsLimit", () => {
	it("is a whole number from 1 to 500, 50 otherwise", () => {
		expect(runsLimit(10)).toBe(10);
		expect(runsLimit(500)).toBe(500);
		for (const value of [undefined, 0, 501, 2.5, "10", Number.NaN, -1]) {
			expect(runsLimit(value)).toBe(50);
		}
	});
});
