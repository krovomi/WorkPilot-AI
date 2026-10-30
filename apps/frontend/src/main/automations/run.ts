/**
 * One pass over a project's rules: read each rule's source, drop what was
 * already answered, hold back what the daily cap does not allow, create the
 * rest as cards (or, for a PR, start its unposted review). The ledger is
 * written once, at the end.
 */

import type {
	AutomationActivity,
	AutomationOutcome,
	AutomationReason,
	AutomationRule,
	AutomationRuleStatus,
	Project,
} from "../../shared/types";
import type { AutomationCard } from "./cards";
import type { AutomationEvent, SourceResult } from "./sources";
import { localDate, SourceError } from "./sources";
import { type Ledger, readLedger, readRules, writeLedger } from "./store";

export interface RunDeps {
	now(): Date;
	/** The rule's events. Throws when the source cannot be read. */
	readSource(project: Project, rule: AutomationRule, ledger: Ledger): Promise<SourceResult>;
	createCard(project: Project, rule: AutomationRule, event: AutomationEvent): Promise<AutomationCard>;
	/** Launches a card that is not a draft. */
	startCard(project: Project, card: AutomationCard): Promise<void> | void;
	/** Whether the board still has the card open (not done, not archived). */
	isCardOpen(project: Project, specId: string): boolean;
	issueNumbersOnBoard(project: Project): Set<number>;
	/** Whether the PR already has a review, saved or running. */
	hasPRReview(project: Project, prNumber: number): Promise<boolean>;
	/** Starts the PR's review, never posted; resolves once launched. */
	startPRReview(project: Project, prNumber: number): Promise<void>;
}

export interface RunSummary {
	created: number;
	reviews: number;
	errors: number;
}

const MAX_ERROR = 300;

function message(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR)}…` : text;
}

export async function runProjectAutomations(
	project: Project,
	deps: RunDeps,
): Promise<RunSummary> {
	const rules = readRules(project).filter((rule) => rule.enabled);
	const summary: RunSummary = { created: 0, reviews: 0, errors: 0 };
	if (rules.length === 0) return summary;

	const ledger = readLedger(project);
	const now = deps.now();
	const today = localDate(now);
	let boardIssues: Set<number> | null = null;

	for (const rule of rules) {
		const previous = ledger.statuses[rule.id];
		const created = ledger.created[rule.id] ?? {};
		ledger.created[rule.id] = created;
		// Only today's count matters; yesterday's goes.
		for (const day of Object.keys(created)) if (day !== today) delete created[day];
		const status: AutomationRuleStatus = {
			lastRunAt: now.toISOString(),
			createdToday: created[today] ?? 0,
			deferred: 0,
		};
		const log = (
			outcome: AutomationOutcome,
			subject: string,
			extra: Partial<AutomationActivity> = {},
		) =>
			ledger.activity.push({
				at: now.toISOString(),
				ruleId: rule.id,
				ruleName: rule.name,
				outcome,
				subject,
				...extra,
			});
		const remember = (key: string, outcome: AutomationOutcome, specId?: string) => {
			ledger.seen[key] = {
				ruleId: rule.id,
				at: now.toISOString(),
				outcome,
				...(specId && { specId }),
			};
		};
		const fail = (reason: AutomationReason, detail: string, subject: string) => {
			status.lastError = reason;
			status.lastErrorDetail = detail;
			summary.errors += 1;
			// The same failure every few minutes is one line, not a hundred.
			if (reason !== previous?.lastError || detail !== previous?.lastErrorDetail) {
				log("error", subject, { reason, detail });
			}
		};

		let source: SourceResult;
		try {
			source = await deps.readSource(project, rule, ledger);
		} catch (error) {
			fail(
				error instanceof SourceError ? error.reason : "source_failed",
				message(error),
				rule.name,
			);
			ledger.statuses[rule.id] = status;
			continue;
		}

		for (const ignored of source.ignored) {
			remember(ignored.key, "ignored");
			log("ignored", ignored.subject, { reason: ignored.reason });
		}
		if (source.green) delete ledger.openCi[rule.id];

		for (const event of source.events) {
			if (ledger.seen[event.key]) continue;
			if (event.issue) {
				boardIssues ??= deps.issueNumbersOnBoard(project);
				if (boardIssues.has(event.issue.number)) {
					remember(event.key, "duplicate");
					log("duplicate", event.subject, {
						url: event.url,
						reason: "issue_on_board",
					});
					continue;
				}
			}
			if (event.pr && (await deps.hasPRReview(project, event.pr.number))) {
				// Reviewed by hand, or by another rule: one draft per PR.
				remember(event.key, "duplicate");
				log("duplicate", event.subject, { url: event.url, reason: "already_reviewed" });
				continue;
			}
			const streak = ledger.openCi[rule.id];
			if (rule.trigger.type === "ci_failed" && streak && deps.isCardOpen(project, streak)) {
				// Same red streak: the open card is the answer to it.
				remember(event.key, "duplicate", streak);
				log("duplicate", event.subject, {
					url: event.url,
					specId: streak,
					reason: "streak_open",
				});
				continue;
			}
			if (status.createdToday >= rule.dailyCap) {
				// Not remembered: it comes back tomorrow, under tomorrow's cap.
				status.deferred += 1;
				continue;
			}

			if (event.pr) {
				try {
					await deps.startPRReview(project, event.pr.number);
				} catch (error) {
					// Not remembered: the next pass tries again, and logs the same failure once.
					fail("review_failed", message(error), event.subject);
					continue;
				}
				status.createdToday += 1;
				created[today] = status.createdToday;
				summary.reviews += 1;
				remember(event.key, "review_started");
				log("review_started", event.subject, { url: event.url });
				continue;
			}

			let card: AutomationCard;
			try {
				card = await deps.createCard(project, rule, event);
			} catch (error) {
				fail("card_failed", message(error), event.subject);
				continue;
			}
			status.createdToday += 1;
			created[today] = status.createdToday;
			summary.created += 1;
			if (event.issue) boardIssues?.add(event.issue.number);
			if (rule.trigger.type === "ci_failed") ledger.openCi[rule.id] = card.specId;

			let outcome: AutomationOutcome = "created";
			let failure: string | undefined;
			if (!rule.draft) {
				try {
					await deps.startCard(project, card);
					outcome = "started";
				} catch (error) {
					// The card exists; only its launch failed, and the log says so.
					failure = message(error);
				}
			}
			remember(event.key, outcome, card.specId);
			log(outcome, event.subject, {
				specId: card.specId,
				url: event.url,
				...(failure && { reason: "not_started" as const, detail: failure }),
			});
		}
		ledger.statuses[rule.id] = status;
	}

	writeLedger(project, ledger);
	return summary;
}
