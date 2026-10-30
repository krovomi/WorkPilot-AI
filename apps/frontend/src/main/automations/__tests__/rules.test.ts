/**
 * A rule comes from the renderer: every field is checked, and what does not
 * pass is refused with a reason, never stored half-right.
 */
import { describe, expect, it } from "vitest";
import type { AutomationRule } from "../../../shared/types";
import { isRuleId, MAX_DAILY_CAP, parseRule, parseStoredRule } from "../rules";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const issueRule = {
	name: "Labelled issues",
	trigger: { type: "issue_labeled", label: "workpilot" },
};

describe("parseRule", () => {
	it("keeps a valid rule, draft and capped by default", () => {
		const rule = parseRule(issueRule, undefined, NOW) as AutomationRule;
		expect(typeof rule).toBe("object");
		expect(isRuleId(rule.id)).toBe(true);
		expect(rule).toMatchObject({
			name: "Labelled issues",
			enabled: true,
			draft: true,
			dailyCap: 3,
			createdAt: NOW.toISOString(),
			trigger: { type: "issue_labeled", label: "workpilot" },
		});
		expect(rule.kind).toBeUndefined();
		expect(rule.engine).toBeUndefined();
	});

	it("starts cards at once only when draft is turned off explicitly", () => {
		expect((parseRule({ ...issueRule, draft: false }) as AutomationRule).draft).toBe(false);
		expect((parseRule({ ...issueRule, draft: "no" }) as AutomationRule).draft).toBe(true);
	});

	it("refuses what it cannot trust", () => {
		expect(parseRule(null)).toMatch(/object/);
		expect(parseRule({ ...issueRule, name: " " })).toMatch(/name/);
		expect(parseRule({ ...issueRule, name: "a\nb" })).toMatch(/name/);
		expect(parseRule({ ...issueRule, trigger: { type: "webhook" } })).toMatch(/Unknown trigger/);
		expect(parseRule({ ...issueRule, trigger: { type: "issue_labeled", label: "" } })).toMatch(/label/);
		expect(parseRule({ ...issueRule, trigger: { type: "issue_labeled", label: "a,b" } })).toMatch(/comma/);
		expect(parseRule({ ...issueRule, kind: "deploy" })).toMatch(/kind/);
		expect(parseRule({ ...issueRule, dailyCap: 0 })).toMatch(/daily cap/);
		expect(parseRule({ ...issueRule, dailyCap: MAX_DAILY_CAP + 1 })).toMatch(/daily cap/);
		expect(parseRule({ ...issueRule, dailyCap: 1.5 })).toMatch(/daily cap/);
		expect(
			parseRule({ ...issueRule, engine: { provider: "../x", model: "m", effort: "low" } }),
		).toMatch(/provider/);
		expect(
			parseRule({ ...issueRule, engine: { provider: "openai", model: "m", effort: "max" } }),
		).toMatch(/effort/);
	});

	it("checks a CI rule's branch as a branch name", () => {
		const ci = { name: "CI", trigger: { type: "ci_failed", branch: "release/2.0" } };
		expect((parseRule(ci) as AutomationRule).trigger).toEqual({ type: "ci_failed", branch: "release/2.0" });
		expect((parseRule({ ...ci, trigger: { type: "ci_failed" } }) as AutomationRule).trigger).toEqual({
			type: "ci_failed",
		});
		for (const branch of ["../main", "main..x", "a b", "-x;rm", "/main", "main/"]) {
			expect(parseRule({ ...ci, trigger: { type: "ci_failed", branch } })).toMatch(/branch/);
		}
	});

	it("keeps a PR rule's review a draft, with no card kind or engine", () => {
		const pr = {
			name: "Others' PRs",
			trigger: { type: "pr_opened", base: "develop" },
			draft: false,
			kind: "bug_fix",
			engine: { provider: "anthropic", model: "m", effort: "high" },
		};
		const rule = parseRule(pr) as AutomationRule;
		expect(rule.trigger).toEqual({ type: "pr_opened", base: "develop" });
		// The review is never posted by a rule, whatever the renderer sent.
		expect(rule.draft).toBe(true);
		expect(rule.kind).toBeUndefined();
		expect(rule.engine).toBeUndefined();
		expect((parseRule({ ...pr, trigger: { type: "pr_opened", base: "" } }) as AutomationRule).trigger).toEqual({
			type: "pr_opened",
		});
		for (const base of ["../main", "a b", "x&state=closed", 7]) {
			expect(parseRule({ ...pr, trigger: { type: "pr_opened", base } })).toMatch(/branch/);
		}
	});

	it("checks a schedule's time, days and card text", () => {
		const schedule = {
			name: "Weekly audit",
			trigger: { type: "schedule", time: "08:30", days: [5, 1, 1], title: "Audit", prompt: "Check deps" },
		};
		expect((parseRule(schedule) as AutomationRule).trigger).toEqual({
			type: "schedule",
			time: "08:30",
			days: [1, 5],
			title: "Audit",
			prompt: "Check deps",
		});
		const bad = (trigger: object) => parseRule({ ...schedule, trigger: { ...schedule.trigger, ...trigger } });
		expect(bad({ time: "24:00" })).toMatch(/time/);
		expect(bad({ days: [] })).toMatch(/day/);
		expect(bad({ days: [7] })).toMatch(/day/);
		expect(bad({ title: "" })).toMatch(/title/);
		expect(bad({ prompt: "" })).toMatch(/description/);
	});

	it("keeps a saved rule's identity and age, and its trigger type", () => {
		const first = parseRule(issueRule, undefined, NOW) as AutomationRule;
		const later = new Date("2026-11-01T00:00:00.000Z");
		const edited = parseRule({ ...issueRule, name: "Renamed" }, first, later) as AutomationRule;
		expect(edited.id).toBe(first.id);
		// Moving createdAt would make issues labelled in between new events.
		expect(edited.createdAt).toBe(first.createdAt);
		expect(parseRule({ name: "x", trigger: { type: "ci_failed" } }, first)).toMatch(/trigger type/);
	});
});

describe("parseStoredRule", () => {
	it("reads back a stored rule and drops a tampered one", () => {
		const rule = parseRule(issueRule, undefined, NOW) as AutomationRule;
		expect(parseStoredRule(JSON.parse(JSON.stringify(rule)))).toEqual(rule);
		expect(parseStoredRule({ ...rule, id: "../../x" })).toBeNull();
		expect(parseStoredRule({ ...rule, createdAt: "yesterday" })).toBeNull();
		expect(parseStoredRule({ ...rule, trigger: { type: "shell", command: "rm" } })).toBeNull();
	});
});
