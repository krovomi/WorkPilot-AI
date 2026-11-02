/**
 * GitLab issues as an automation source: the GitLab twin of
 * `issueLabeledEvents` (sources.ts), read with the project's GitLab
 * connection (Settings › GitLab). The same rule: only an issue labelled
 * after the rule was created, read from the issue's label events.
 */

import type { AutomationRule, IssueLabeledTrigger } from "../../shared/types";
import type { AutomationEvent, SourceResult } from "./sources";

/** `endpoint` is below the project, `/projects/<encoded path>`. */
export interface GitLabSource {
	/** `host/group/project`, for the dedup keys. */
	slug: string;
	fetch: (endpoint: string) => Promise<unknown>;
}

const ISSUES_PER_PASS = 50;
const EVENT_PAGES = 5;

export function gitlabIssueKey(slug: string, iid: number): string {
	return `gitlab-issue:${slug.toLowerCase()}#${iid}`;
}

interface GitLabIssue {
	iid: number;
	title: string;
	description?: string | null;
	web_url: string;
	labels?: string[];
}

interface GitLabLabelEvent {
	action?: string;
	created_at?: string;
	label?: { name?: string } | null;
}

async function labeledSince(
	gitlab: GitLabSource,
	iid: number,
	label: string,
	since: number,
): Promise<boolean> {
	const wanted = label.toLowerCase();
	for (let page = 1; page <= EVENT_PAGES; page++) {
		const events = (await gitlab.fetch(
			`/issues/${iid}/resource_label_events?per_page=100&page=${page}`,
		)) as GitLabLabelEvent[];
		if (!Array.isArray(events)) return false;
		for (const event of events) {
			if (
				event.action === "add" &&
				event.label?.name?.toLowerCase() === wanted &&
				event.created_at &&
				Date.parse(event.created_at) >= since
			) {
				return true;
			}
		}
		if (events.length < 100) return false;
	}
	return false;
}

/** Open GitLab issues that received the rule's label after the rule was created. */
export async function gitlabIssueLabeledEvents(
	rule: AutomationRule & { trigger: IssueLabeledTrigger },
	gitlab: GitLabSource,
	alreadySeen: (key: string) => boolean,
): Promise<SourceResult> {
	const since = Date.parse(rule.createdAt);
	const label = rule.trigger.label;
	const issues = (await gitlab.fetch(
		`/issues?state=opened&labels=${encodeURIComponent(label)}` +
			`&updated_after=${encodeURIComponent(rule.createdAt)}&order_by=created_at&sort=asc` +
			`&per_page=${ISSUES_PER_PASS}`,
	)) as GitLabIssue[];
	if (!Array.isArray(issues)) {
		throw new Error("GitLab answered the issue list with something else than a list");
	}
	const result: SourceResult = { events: [], ignored: [] };
	for (const issue of issues) {
		if (!Number.isInteger(issue.iid) || issue.iid <= 0) continue;
		const key = gitlabIssueKey(gitlab.slug, issue.iid);
		if (alreadySeen(key)) continue;
		const subject = `#${issue.iid}`;
		if (!(await labeledSince(gitlab, issue.iid, label, since))) {
			result.ignored.push({ key, subject, reason: "label_predates_rule" });
			continue;
		}
		const labels = (issue.labels ?? []).filter(
			(l): l is string => typeof l === "string" && l.length > 0,
		);
		const event: AutomationEvent = {
			key,
			subject,
			title: issue.title,
			description: `# ${issue.title}

**GitLab Issue:** [#${issue.iid}](${issue.web_url})
${labels.length ? `**Labels:** ${labels.join(", ")}` : ""}

## Description

${issue.description || "No description provided."}
`,
			url: issue.web_url,
			issue: {
				forge: "gitlab",
				number: issue.iid,
				url: issue.web_url,
				labels,
				body: issue.description ?? undefined,
			},
		};
		result.events.push(event);
	}
	return result;
}
