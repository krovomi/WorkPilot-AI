/**
 * The events a rule listens to, read from the project's own connectors:
 * GitHub issues and PRs through the project's GitHub token, the base branch's
 * pipeline through the same CI provider as the « Build rouge » loop, and
 * the clock. A source that cannot be read throws, with the reason; it never
 * answers "nothing new" in its place.
 */

import type {
	AutomationReason,
	AutomationRule,
	CiFailedTrigger,
	IssueLabeledTrigger,
	PrOpenedTrigger,
	Project,
	ScheduleTrigger,
} from "../../shared/types";
import type {
	PipelineProviderAdapter,
	PipelineRun,
} from "../ci-pipeline-providers";

/** An event that may become a card. `key` is what dedups it. */
export interface AutomationEvent {
	key: string;
	/** One line for the activity log: `#12`, `CI #418 on main`, `2026-10-26`. */
	subject: string;
	title: string;
	description: string;
	url?: string;
	issue?: { number: number; url: string; labels: string[]; body?: string };
	/** A PR to review instead of a card to create. */
	pr?: { number: number; url: string };
}

/** A source that cannot be read, for a reason the panel can name. */
export class SourceError extends Error {
	constructor(
		readonly reason: AutomationReason,
		message: string,
	) {
		super(message);
		this.name = "SourceError";
	}
}

export interface SourceResult {
	events: AutomationEvent[];
	/** Events that are not this rule's, remembered so they are not re-read. */
	ignored: Array<{ key: string; subject: string; reason: AutomationReason }>;
	/** The CI source saw a green run: the red streak is over. */
	green?: boolean;
}

export type GitHubFetch = (endpoint: string) => Promise<unknown>;

export interface GitHubSource {
	repo: string;
	fetch: GitHubFetch;
}

const ISSUES_PER_PASS = 50;
const EVENT_PAGES = 5;

export function issueKey(repo: string, number: number): string {
	return `github-issue:${repo.toLowerCase()}#${number}`;
}

interface GitHubIssue {
	number: number;
	title: string;
	body?: string | null;
	html_url: string;
	labels: Array<{ name?: string } | string>;
	pull_request?: unknown;
}

interface GitHubIssueEvent {
	event?: string;
	created_at?: string;
	label?: { name?: string };
}

/** Whether `label` was put on the issue at or after `since`. */
async function labeledSince(
	github: GitHubSource,
	number: number,
	label: string,
	since: number,
): Promise<boolean> {
	const wanted = label.toLowerCase();
	for (let page = 1; page <= EVENT_PAGES; page++) {
		const events = (await github.fetch(
			`/repos/${github.repo}/issues/${number}/events?per_page=100&page=${page}`,
		)) as GitHubIssueEvent[];
		if (!Array.isArray(events)) return false;
		for (const event of events) {
			if (
				event.event === "labeled" &&
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

/**
 * Open issues that received the rule's label after the rule was created.
 * An issue that carried the label before is ignored: turning a rule on is
 * not a request to import the backlog.
 */
export async function issueLabeledEvents(
	rule: AutomationRule & { trigger: IssueLabeledTrigger },
	github: GitHubSource,
	alreadySeen: (key: string) => boolean,
): Promise<SourceResult> {
	const since = Date.parse(rule.createdAt);
	const label = rule.trigger.label;
	const issues = (await github.fetch(
		`/repos/${github.repo}/issues?state=open&labels=${encodeURIComponent(label)}` +
			`&since=${encodeURIComponent(rule.createdAt)}&sort=created&direction=asc` +
			`&per_page=${ISSUES_PER_PASS}`,
	)) as GitHubIssue[];
	if (!Array.isArray(issues)) {
		throw new Error("GitHub answered the issue list with something else than a list");
	}
	const result: SourceResult = { events: [], ignored: [] };
	for (const issue of issues) {
		if (issue.pull_request) continue;
		const key = issueKey(github.repo, issue.number);
		if (alreadySeen(key)) continue;
		const subject = `#${issue.number}`;
		if (!(await labeledSince(github, issue.number, label, since))) {
			result.ignored.push({
				key,
				subject,
				reason: "label_predates_rule",
			});
			continue;
		}
		const labels = issue.labels
			.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
			.filter(Boolean);
		result.events.push({
			key,
			subject,
			title: issue.title,
			description: `# ${issue.title}

**GitHub Issue:** [#${issue.number}](${issue.html_url})
${labels.length ? `**Labels:** ${labels.join(", ")}` : ""}

## Description

${issue.body || "No description provided."}
`,
			url: issue.html_url,
			issue: {
				number: issue.number,
				url: issue.html_url,
				labels,
				body: issue.body ?? undefined,
			},
		});
	}
	return result;
}

export function prKey(repo: string, number: number): string {
	return `github-pr:${repo.toLowerCase()}#${number}`;
}

interface GitHubPull {
	number: number;
	html_url: string;
	draft?: boolean;
	created_at?: string;
	user?: { login?: string; type?: string } | null;
}

/**
 * Open PRs another person opened after the rule was created, oldest first.
 * The person's own PRs and bots' are ignored, and remembered as such; a
 * draft PR is not an event yet and comes back once it is ready for review.
 * Who "the person" is comes from the token: when GitHub does not say, the
 * source fails rather than review the person's own work.
 */
export async function prOpenedEvents(
	rule: AutomationRule & { trigger: PrOpenedTrigger },
	github: GitHubSource,
	alreadySeen: (key: string) => boolean,
): Promise<SourceResult> {
	const since = Date.parse(rule.createdAt);
	const base = rule.trigger.base;
	const pulls = (await github.fetch(
		`/repos/${github.repo}/pulls?state=open&sort=created&direction=desc` +
			`${base ? `&base=${encodeURIComponent(base)}` : ""}&per_page=${ISSUES_PER_PASS}`,
	)) as GitHubPull[];
	if (!Array.isArray(pulls)) {
		throw new Error("GitHub answered the PR list with something else than a list");
	}
	const candidates = pulls
		.filter(
			(pull) =>
				Number.isInteger(pull.number) &&
				pull.number > 0 &&
				!pull.draft &&
				Date.parse(pull.created_at ?? "") >= since &&
				!alreadySeen(prKey(github.repo, pull.number)),
		)
		.reverse();
	const result: SourceResult = { events: [], ignored: [] };
	if (candidates.length === 0) return result;

	const me = (await github.fetch("/user")) as { login?: unknown } | null;
	const login = typeof me?.login === "string" ? me.login.toLowerCase() : "";
	if (!login) throw new Error("GitHub did not say whose token this is");

	for (const pull of candidates) {
		const key = prKey(github.repo, pull.number);
		const subject = `PR #${pull.number}`;
		const author = pull.user?.login?.toLowerCase();
		if (!author || pull.user?.type === "Bot") {
			result.ignored.push({ key, subject, reason: "bot_author" });
			continue;
		}
		if (author === login) {
			result.ignored.push({ key, subject, reason: "own_pr" });
			continue;
		}
		// Only the number goes on: the PR's title and body reach the reviewer
		// through its own fetch, as untrusted content, never through the rule.
		result.events.push({
			key,
			subject,
			title: subject,
			description: "",
			url: pull.html_url,
			pr: { number: pull.number, url: pull.html_url },
		});
	}
	return result;
}

export function ciBranch(trigger: CiFailedTrigger, project: Project): string {
	return trigger.branch || project.settings?.mainBranch || "main";
}

/**
 * The base branch's latest pipeline run, when it failed. A run that is still
 * going is not an event yet, and a green one ends the streak.
 */
export async function ciFailedEvents(
	rule: AutomationRule & { trigger: CiFailedTrigger },
	project: Project,
	adapter: PipelineProviderAdapter | null,
): Promise<SourceResult> {
	if (!adapter) {
		throw new SourceError(
			"no_ci_provider",
			"No CI provider is configured for this project",
		);
	}
	const branch = ciBranch(rule.trigger, project);
	const run: PipelineRun | null = await adapter.fetchLatestRun(branch);
	if (!run) return { events: [], ignored: [] };
	if (run.state === "succeeded" || run.state === "partiallySucceeded") {
		return { events: [], ignored: [], green: true };
	}
	if (run.state !== "failed") return { events: [], ignored: [] };

	let errors: string[] = [];
	try {
		errors = await adapter.fetchRunErrors(run);
	} catch {
		// The run's state is known; its details are a bonus.
	}
	const name = run.definitionName ?? adapter.label;
	const reference = run.runNumber ?? String(run.runId);
	return {
		ignored: [],
		events: [
			{
				key: `ci:${adapter.id}:${branch}:${run.runId}`,
				subject: `${name} ${reference} on ${branch}`,
				title: `Fix CI on ${branch}: ${name}`,
				description: `# Fix CI on ${branch}

The latest ${adapter.label} run on \`${branch}\` failed.

- **Pipeline:** ${name} ${reference}
${run.webUrl ? `- **Run:** ${run.webUrl}\n` : ""}${run.finishTime ? `- **Finished:** ${run.finishTime}\n` : ""}
## What failed

${errors.length ? errors.map((line) => `- ${line}`).join("\n") : "The provider did not say which step failed."}

## Done when

The pipeline on \`${branch}\` passes again. Fix the cause; do not skip, disable or loosen a test or a check.
`,
				url: run.webUrl,
			},
		],
	};
}

export function localDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Today's slot, once its time has passed. A rule created after today's time
 * starts tomorrow, and a day the app was closed is not made up.
 */
export function scheduleEvents(
	rule: AutomationRule & { trigger: ScheduleTrigger },
	now: Date,
): SourceResult {
	const { time, days, title, prompt } = rule.trigger;
	if (!days.includes(now.getDay())) return { events: [], ignored: [] };
	const [hours, minutes] = time.split(":").map(Number);
	const slot = new Date(now);
	slot.setHours(hours, minutes, 0, 0);
	if (now < slot || Date.parse(rule.createdAt) > slot.getTime()) {
		return { events: [], ignored: [] };
	}
	const day = localDate(now);
	return {
		ignored: [],
		events: [
			{
				key: `schedule:${rule.id}:${day}`,
				subject: day,
				title,
				description: prompt,
			},
		],
	};
}
