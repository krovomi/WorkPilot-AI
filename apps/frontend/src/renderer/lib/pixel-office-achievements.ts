/**
 * Pixel Office achievements: what a project's agents have done, as milestones.
 *
 * Every rule reads normalized facts (a task shipped, QA passed on its first
 * session, an incident resolved, a second engine agreeing with the work),
 * never a provider-specific signal: the same project earns the same
 * achievements whether its agents run on Claude, a local model or anything in
 * between. The facts come from data the app already holds (the project's
 * tasks and its Self-Healing incidents), so an achievement is a fact about the
 * project, not a counter that only moves while the office is open.
 */

import type { Task } from "../../shared/types/task";

export const ACHIEVEMENT_IDS = [
	"first-ship",
	"ten-ships-week",
	"qa-first-try",
	"qa-first-try-five",
	"incident-resolved",
	"incident-fixed-by-agent",
	"second-opinion",
] as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

/** The facts the rules read, already normalized. */
export interface OfficeFacts {
	/** When each shipped task (done or turned into a PR) last changed, in ms. */
	shippedAt: number[];
	/** Tasks whose QA approval came from their first QA session. */
	qaFirstTry: number;
	/** Self-Healing incidents marked resolved. */
	incidentsResolved: number;
	/** Resolved incidents whose fix an agent opened as a pull request. */
	incidentsFixedByAgent: number;
	/** Tasks a second engine reviewed and agreed with. */
	reviewsAgreed: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SHIPPED: ReadonlySet<Task["status"]> = new Set<Task["status"]>([
	"done",
	"pr_created",
]);

/** What the rules need from an incident; anything else in it is ignored. */
export interface IncidentFact {
	status: string;
	fixPrUrl?: string;
	/** When it was resolved, in ms; absent when the runner gave no valid date. */
	resolvedAt?: number;
}

/**
 * Read the incidents the Self-Healing runner returned. They come from a
 * subprocess, so each entry is checked: an entry without a string status is
 * dropped, an empty fix URL counts as none, and a resolution date that does
 * not parse counts as no date.
 */
export function incidentFactsOf(data: unknown): IncidentFact[] {
	if (!Array.isArray(data)) return [];
	const facts: IncidentFact[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const {
			status,
			fix_pr_url: url,
			resolved_at: resolved,
		} = entry as Record<string, unknown>;
		if (typeof status !== "string") continue;
		const fact: IncidentFact = { status };
		if (typeof url === "string" && url.length > 0) fact.fixPrUrl = url;
		const at = typeof resolved === "string" ? Date.parse(resolved) : Number.NaN;
		if (Number.isFinite(at)) fact.resolvedAt = at;
		facts.push(fact);
	}
	return facts;
}

export function collectFacts(
	tasks: readonly Task[],
	incidents: readonly IncidentFact[],
): OfficeFacts {
	const resolved = incidents.filter((i) => i.status === "resolved");
	return {
		shippedAt: tasks
			.filter((t) => SHIPPED.has(t.status))
			.map((t) => new Date(t.updatedAt).getTime())
			.filter((at) => Number.isFinite(at)),
		qaFirstTry: tasks.filter(
			(t) => t.qaSignoff?.status === "approved" && t.qaSignoff.session === 1,
		).length,
		incidentsResolved: resolved.length,
		incidentsFixedByAgent: resolved.filter((i) => i.fixPrUrl).length,
		reviewsAgreed: tasks.filter((t) => t.crossReview?.verdict === "agree")
			.length,
	};
}

const RULES: Record<AchievementId, (facts: OfficeFacts, now: number) => boolean> =
	{
		"first-ship": (f) => f.shippedAt.length >= 1,
		"ten-ships-week": (f, now) =>
			f.shippedAt.filter((at) => at <= now && now - at <= WEEK_MS).length >=
			10,
		"qa-first-try": (f) => f.qaFirstTry >= 1,
		"qa-first-try-five": (f) => f.qaFirstTry >= 5,
		"incident-resolved": (f) => f.incidentsResolved >= 1,
		"incident-fixed-by-agent": (f) => f.incidentsFixedByAgent >= 1,
		"second-opinion": (f) => f.reviewsAgreed >= 1,
	};

/** The achievements the facts earn, in catalog order. */
export function earnedAchievements(
	facts: OfficeFacts,
	now: number,
): AchievementId[] {
	return ACHIEVEMENT_IDS.filter((id) => RULES[id](facts, now));
}
