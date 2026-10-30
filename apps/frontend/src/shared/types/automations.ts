/**
 * Automations: a rule turns an event (an issue labelled, the base branch's
 * CI going red, a time of day) into a Kanban card. The card then follows the
 * normal cycle; a rule never merges, pushes or comments anything itself.
 * A PR opened by someone else gets the AI review instead of a card, kept as
 * a draft in GitHub PRs: posting it stays the person's click.
 * See docs/architecture/automations.md.
 */

import type { EngineTrio, TaskKind } from "./task";

export interface IssueLabeledTrigger {
	type: "issue_labeled";
	/** The GitHub label that asks for a card. */
	label: string;
}

export interface CiFailedTrigger {
	type: "ci_failed";
	/** The branch whose latest pipeline run is watched; the project's main branch when empty. */
	branch?: string;
}

export interface ScheduleTrigger {
	type: "schedule";
	/** Local time, `HH:MM`. */
	time: string;
	/** Days of the week it fires on, 0 = Sunday. */
	days: number[];
	/** The card's title and description. */
	title: string;
	prompt: string;
}

export interface PrOpenedTrigger {
	type: "pr_opened";
	/** Only PRs into this branch; any base branch when empty. */
	base?: string;
}

export type AutomationTrigger =
	| IssueLabeledTrigger
	| CiFailedTrigger
	| ScheduleTrigger
	| PrOpenedTrigger;

export type AutomationTriggerType = AutomationTrigger["type"];

export interface AutomationRule {
	id: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	/** The card's kind, hence its workflow; the classifier decides when absent. */
	kind?: TaskKind;
	/** The card's engine for every phase; the app's default when absent. */
	engine?: EngineTrio;
	/** A draft card waits in the backlog for a click. On by default; always on for `pr_opened`. */
	draft: boolean;
	/** Cards (or reviews) this rule may start per day; the rest waits for the next day. */
	dailyCap: number;
	/** ISO time. Events older than the rule are not its events. */
	createdAt: string;
}

/** What a rule's last pass found. */
export interface AutomationRuleStatus {
	lastRunAt?: string;
	/** Why the last pass could not read its source; absent when it could. */
	lastError?: AutomationReason;
	/** The raw message behind `lastError`, when there is one. */
	lastErrorDetail?: string;
	/** Cards created today, or reviews started for a `pr_opened` rule. */
	createdToday: number;
	/** Events the daily cap held back on the last pass. */
	deferred: number;
}

export type AutomationOutcome =
	| "created"
	| "started"
	| "duplicate"
	| "ignored"
	| "review_started"
	| "error";

/** Why an event was not a card, or what went wrong; the panel translates it. */
export type AutomationReason =
	| "label_predates_rule"
	| "issue_on_board"
	| "streak_open"
	| "not_started"
	| "github_not_connected"
	| "no_ci_provider"
	| "source_failed"
	| "card_failed"
	| "own_pr"
	| "bot_author"
	| "already_reviewed"
	| "review_failed";

export interface AutomationActivity {
	at: string;
	ruleId: string;
	ruleName: string;
	outcome: AutomationOutcome;
	/** What the event was: an issue, a pipeline run, a day. */
	subject: string;
	specId?: string;
	url?: string;
	reason?: AutomationReason;
	/** The raw error, for `source_failed`, `card_failed`, `not_started` and `review_failed`. */
	detail?: string;
}

export interface AutomationsState {
	rules: AutomationRule[];
	statuses: Record<string, AutomationRuleStatus>;
	activity: AutomationActivity[];
}

/** Pushed to the renderer after a pass that created cards, started reviews or failed. */
export interface AutomationsEvent {
	projectId: string;
	created: number;
	reviews: number;
}

