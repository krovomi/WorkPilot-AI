/**
 * The production incident source: the runner writes the cards' text, and
 * its answer is read back as data. Only `incident:` keys, one-line titles,
 * HTTPS links and known reasons come through; a failure keeps its reason.
 */
import { describe, expect, it, vi } from "vitest";
import type { AutomationRule, ProdIncidentTrigger, Project } from "../../../shared/types";

vi.mock("../../ci-pipeline-service", () => ({ readMergedProjectEnv: () => ({}) }));

import { type FeedRequest, prodIncidentEvents } from "../sources-incidents";
import { SourceError } from "../sources";

const project = { id: "p1", path: "/work/shop" } as Project;
const rule = {
	id: "r-000000000001",
	name: "Prod",
	enabled: true,
	trigger: { type: "prod_incident", org: "acme", project: "api" },
	kind: "bug_fix",
	draft: true,
	dailyCap: 3,
	createdAt: "2026-11-09T08:00:00.000Z",
} as AutomationRule & { trigger: ProdIncidentTrigger };

function answering(line: string) {
	const requests: FeedRequest[] = [];
	const run = async (_: Project, request: FeedRequest) => {
		requests.push(request);
		return `noise\n${line}\n`;
	};
	return { run, requests };
}

describe("prodIncidentEvents", () => {
	it("asks for the rule's incidents and keeps only well-formed events", async () => {
		const { run, requests } = answering(
			`REGRESSION_GUARDIAN_FEED:${JSON.stringify({
				events: [
					{
						key: "incident:sentry:42",
						subject: "sentry 42",
						title: "Regression: KeyError:\n 'sku'",
						description: "# Regression\\n\\n## Done when",
						url: "https://acme.sentry.io/issues/42/",
					},
					{ key: "github-issue:acme/shop#1", title: "x", description: "y" },
					{ key: "incident:inbox:a", title: "y", description: "z", url: "javascript:alert(1)" },
				],
				ignored: [
					{ key: "incident:inbox:old.json", subject: "inbox old.json", reason: "incident_predates_rule" },
					{ key: "incident:inbox:b", subject: "b", reason: "rm -rf" },
				],
			})}`,
		);
		const result = await prodIncidentEvents(
			rule,
			project,
			["incident:sentry:7", "github-issue:acme/shop#3"],
			run,
		);
		expect(requests).toEqual([
			{ since: rule.createdAt, trigger: rule.trigger, seen: ["incident:sentry:7"] },
		]);
		expect(result.events.map((e) => e.key)).toEqual(["incident:sentry:42", "incident:inbox:a"]);
		expect(result.events[0]).toMatchObject({
			title: "Regression: KeyError: 'sku'",
			url: "https://acme.sentry.io/issues/42/",
		});
		expect(result.events[1].url).toBeUndefined();
		expect(result.ignored).toEqual([
			{ key: "incident:inbox:old.json", subject: "inbox old.json", reason: "incident_predates_rule" },
		]);
	});

	it("keeps the runner's reason when the source fails", async () => {
		const { run } = answering(
			`REGRESSION_GUARDIAN_FEED_ERROR:${JSON.stringify({
				reason: "sentry_token_missing",
				message: "SENTRY_AUTH_TOKEN is not set in the project's .env",
			})}`,
		);
		const error = await prodIncidentEvents(rule, project, [], run).catch((e) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error.reason).toBe("sentry_token_missing");

		const unknown = answering(
			`REGRESSION_GUARDIAN_FEED_ERROR:${JSON.stringify({ reason: "owner_not_allowed", message: "x" })}`,
		);
		expect((await prodIncidentEvents(rule, project, [], unknown.run).catch((e) => e)).reason).toBe(
			"source_failed",
		);
	});

	it("fails rather than answer « nothing new » when the runner says nothing", async () => {
		const { run } = answering("Traceback (most recent call last):");
		const error = await prodIncidentEvents(rule, project, [], run).catch((e) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error.reason).toBe("source_failed");
	});
});
