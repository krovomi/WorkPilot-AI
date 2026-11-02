/**
 * A GitLab issue is an event only once labelled after the rule was created,
 * like a GitHub one; an issue that had the label before is remembered as
 * ignored, not imported.
 */
import { describe, expect, it, vi } from "vitest";
import type { AutomationRule, IssueLabeledTrigger } from "../../../shared/types";
import { gitlabIssueLabeledEvents } from "../sources-gitlab";

const rule = {
	id: "r-000000000001",
	name: "Issues",
	enabled: true,
	trigger: { type: "issue_labeled", label: "WorkPilot" },
	draft: true,
	dailyCap: 3,
	createdAt: "2026-11-01T08:00:00.000Z",
} as AutomationRule & { trigger: IssueLabeledTrigger };

function issue(iid: number) {
	return { iid, title: `Issue ${iid}`, web_url: `https://gitlab.com/a/b/-/issues/${iid}`, labels: ["workpilot", "bug"] };
}

describe("gitlabIssueLabeledEvents", () => {
	it("keeps an issue labelled after the rule, ignores one labelled before", async () => {
		const fetch = vi.fn(async (endpoint: string) => {
			if (endpoint.startsWith("/issues?")) return [issue(1), issue(2), { iid: -3 }];
			const iid = Number(endpoint.split("/")[2]);
			return [
				{
					action: "add",
					created_at: iid === 1 ? "2026-11-01T09:00:00Z" : "2026-10-01T09:00:00Z",
					label: { name: "workpilot" },
				},
			];
		});
		const result = await gitlabIssueLabeledEvents(rule, { slug: "gitlab.com/A/B", fetch }, () => false);
		expect(result.events.map((e) => e.key)).toEqual(["gitlab-issue:gitlab.com/a/b#1"]);
		expect(result.events[0].issue).toMatchObject({ forge: "gitlab", number: 1 });
		expect(result.events[0].description).toContain("**GitLab Issue:** [#1]");
		expect(result.ignored).toEqual([
			{ key: "gitlab-issue:gitlab.com/a/b#2", subject: "#2", reason: "label_predates_rule" },
		]);
		expect(fetch.mock.calls[0][0]).toContain("labels=WorkPilot&updated_after=2026-11-01T08%3A00%3A00.000Z");
	});

	it("skips what it already saw, and fails on an answer that is not a list", async () => {
		const fetch = vi.fn(async () => [issue(1)]);
		const seen = await gitlabIssueLabeledEvents(rule, { slug: "s", fetch }, () => true);
		expect(seen).toEqual({ events: [], ignored: [] });
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(
			gitlabIssueLabeledEvents(rule, { slug: "s", fetch: async () => ({ message: "401" }) }, () => false),
		).rejects.toThrow(/not a list|something else/);
	});
});
