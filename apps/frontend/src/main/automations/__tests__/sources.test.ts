/**
 * The sources say what happened, and only what happened after the rule: an
 * issue labelled before it, a run still going, a slot not reached yet are
 * not events. A source that cannot be read throws instead of answering empty.
 */
import { describe, expect, it, vi } from "vitest";
import type { AutomationRule, Project, ScheduleTrigger } from "../../../shared/types";
import type { PipelineProviderAdapter, PipelineRun } from "../../ci-pipeline-providers";
import {
	ciFailedEvents,
	issueKey,
	issueLabeledEvents,
	SourceError,
	scheduleEvents,
} from "../sources";

const CREATED = "2026-10-20T00:00:00.000Z";
const project = { id: "p1", path: "/p", autoBuildPath: ".workpilot", settings: { mainBranch: "develop" } } as unknown as Project;

function rule<T extends AutomationRule["trigger"]>(trigger: T) {
	return {
		id: "r-000000000001",
		name: "rule",
		enabled: true,
		trigger,
		draft: true,
		dailyCap: 3,
		createdAt: CREATED,
	} as AutomationRule & { trigger: T };
}

function github(routes: Record<string, unknown>) {
	const fetch = vi.fn(async (endpoint: string) => {
		const match = Object.keys(routes).find((prefix) => endpoint.startsWith(prefix));
		if (!match) throw new Error(`unexpected ${endpoint}`);
		return routes[match];
	});
	return { repo: "acme/app", fetch };
}

const labeled = (at: string, name = "WorkPilot") => ({ event: "labeled", created_at: at, label: { name } });

describe("issueLabeledEvents", () => {
	const trigger = { type: "issue_labeled", label: "workpilot" } as const;

	it("turns an issue labelled after the rule into an event", async () => {
		const source = github({
			"/repos/acme/app/issues?": [
				{ number: 7, title: "Login fails", body: "steps", html_url: "https://github.com/acme/app/issues/7", labels: [{ name: "WorkPilot" }, "bug"] },
			],
			"/repos/acme/app/issues/7/events": [labeled("2026-10-19T00:00:00Z", "other"), labeled("2026-10-21T08:00:00Z")],
		});
		const result = await issueLabeledEvents(rule(trigger), source, () => false);
		expect(result.ignored).toEqual([]);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({
			key: issueKey("acme/app", 7),
			subject: "#7",
			title: "Login fails",
			issue: { number: 7, labels: ["WorkPilot", "bug"] },
		});
		expect(result.events[0].description).toContain("steps");
		const list = source.fetch.mock.calls[0][0];
		expect(list).toContain("labels=workpilot");
		expect(list).toContain(`since=${encodeURIComponent(CREATED)}`);
	});

	it("ignores an issue that had the label before the rule, and pull requests", async () => {
		const source = github({
			"/repos/acme/app/issues?": [
				{ number: 3, title: "Old", html_url: "u", labels: [] },
				{ number: 4, title: "PR", html_url: "u", labels: [], pull_request: {} },
			],
			"/repos/acme/app/issues/3/events": [labeled("2026-10-01T00:00:00Z")],
		});
		const result = await issueLabeledEvents(rule(trigger), source, () => false);
		expect(result.events).toEqual([]);
		expect(result.ignored).toEqual([{ key: issueKey("acme/app", 3), subject: "#3", reason: "label_predates_rule" }]);
		expect(source.fetch.mock.calls.some(([e]) => e.includes("/issues/4/"))).toBe(false);
	});

	it("does not re-read an issue the ledger already answered", async () => {
		const source = github({ "/repos/acme/app/issues?": [{ number: 9, title: "x", html_url: "u", labels: [] }] });
		const result = await issueLabeledEvents(rule(trigger), source, () => true);
		expect(result).toEqual({ events: [], ignored: [] });
		expect(source.fetch).toHaveBeenCalledTimes(1);
	});

	it("throws on an answer that is not a list", async () => {
		const source = github({ "/repos/acme/app/issues?": { message: "Bad credentials" } });
		await expect(issueLabeledEvents(rule(trigger), source, () => false)).rejects.toThrow(/list/);
	});
});

function adapter(run: PipelineRun | null, errors: string[] = []): PipelineProviderAdapter {
	return {
		id: "github-actions",
		label: "GitHub Actions",
		fetchLatestRun: vi.fn(async () => run),
		fetchRunErrors: vi.fn(async () => errors),
	} as unknown as PipelineProviderAdapter;
}

describe("ciFailedEvents", () => {
	const trigger = { type: "ci_failed" } as const;
	const failed: PipelineRun = { state: "failed", runId: 418, runNumber: "#418", definitionName: "CI", webUrl: "https://ci/418" };

	it("makes the latest failed run on the base branch an event", async () => {
		const ci = adapter(failed, ['[test] step "pytest" failure']);
		const result = await ciFailedEvents(rule(trigger), project, ci);
		expect(ci.fetchLatestRun).toHaveBeenCalledWith("develop");
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({
			key: "ci:github-actions:develop:418",
			subject: "CI #418 on develop",
			url: "https://ci/418",
		});
		expect(result.events[0].description).toContain('step "pytest" failure');
		expect(result.events[0].description).toContain("do not skip, disable or loosen a test");
	});

	it("waits for a run that is still going, and ends the streak on green", async () => {
		expect(await ciFailedEvents(rule(trigger), project, adapter({ ...failed, state: "running" }))).toEqual({
			events: [],
			ignored: [],
		});
		expect(await ciFailedEvents(rule(trigger), project, adapter({ ...failed, state: "succeeded" }))).toEqual({
			events: [],
			ignored: [],
			green: true,
		});
		expect((await ciFailedEvents(rule(trigger), project, adapter(null))).events).toEqual([]);
	});

	it("still reports the failure when its details cannot be read", async () => {
		const ci = adapter(failed);
		vi.mocked(ci.fetchRunErrors).mockRejectedValue(new Error("403"));
		const result = await ciFailedEvents(rule({ type: "ci_failed", branch: "main" }), project, ci);
		expect(result.events[0].key).toBe("ci:github-actions:main:418");
		expect(result.events[0].description).toContain("did not say which step failed");
	});

	it("says no CI provider is configured rather than seeing no failure", async () => {
		await expect(ciFailedEvents(rule(trigger), project, null)).rejects.toBeInstanceOf(SourceError);
	});
});

describe("scheduleEvents", () => {
	const trigger: ScheduleTrigger = { type: "schedule", time: "09:00", days: [1, 3], title: "Audit", prompt: "Check" };
	// 2026-10-26 is a Monday.
	const at = (h: number, m = 0) => new Date(2026, 9, 26, h, m);

	it("fires once the time has passed on a chosen day", () => {
		expect(scheduleEvents(rule(trigger), at(8, 59)).events).toEqual([]);
		const result = scheduleEvents(rule(trigger), at(9, 1));
		expect(result.events).toEqual([
			{ key: "schedule:r-000000000001:2026-10-26", subject: "2026-10-26", title: "Audit", description: "Check" },
		]);
	});

	it("does not fire on another day, nor for a rule made after the slot", () => {
		expect(scheduleEvents(rule(trigger), new Date(2026, 9, 27, 10)).events).toEqual([]);
		const late = { ...rule(trigger), createdAt: at(9, 30).toISOString() };
		expect(scheduleEvents(late, at(10)).events).toEqual([]);
	});
});
