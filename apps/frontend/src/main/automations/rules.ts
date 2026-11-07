/**
 * Automation rules as the main process accepts them. A rule arrives from the
 * renderer, which is not trusted: every field is checked against a closed
 * list or a bound here, and anything else is refused with a reason.
 */

import { randomBytes } from "node:crypto";
import type {
	AutomationRule,
	AutomationTrigger,
	EngineTrio,
	TaskKind,
} from "../../shared/types";
import { TASK_KINDS } from "../../shared/types/task";

export const MAX_RULES = 20;
export const DEFAULT_DAILY_CAP = 3;
export const MAX_DAILY_CAP = 20;

const RULE_ID = /^r-[a-f0-9]{12}$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORTS = new Set(["none", "low", "medium", "high", "ultrathink"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// GitHub refuses labels over 50 characters; git refs have their own grammar.
const LABEL_MAX = 50;
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

export function newRuleId(): string {
	return `r-${randomBytes(6).toString("hex")}`;
}

export function isRuleId(value: unknown): value is string {
	return typeof value === "string" && RULE_ID.test(value);
}

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > max) return null;
	// Control characters other than newlines and tabs have no business in a rule.
	if ([...trimmed].some((c) => c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t")) {
		return null;
	}
	return trimmed;
}

function singleLine(value: unknown, max: number): string | null {
	const result = text(value, max);
	return result && !/[\n\t]/.test(result) ? result : null;
}

function parseTrigger(raw: unknown): AutomationTrigger | string {
	if (!raw || typeof raw !== "object") return "A rule needs a trigger";
	const trigger = raw as Record<string, unknown>;
	switch (trigger.type) {
		case "issue_labeled": {
			const label = singleLine(trigger.label, LABEL_MAX);
			if (!label) return "The trigger needs a label";
			// The issue list takes labels comma-separated: a comma would be two labels.
			if (label.includes(",")) return "A label cannot contain a comma";
			return { type: "issue_labeled", label };
		}
		case "ci_failed": {
			if (trigger.branch === undefined || trigger.branch === "") {
				return { type: "ci_failed" };
			}
			if (typeof trigger.branch !== "string" || !BRANCH.test(trigger.branch)) {
				return "The trigger's branch is not a branch name";
			}
			return { type: "ci_failed", branch: trigger.branch };
		}
		case "schedule": {
			if (typeof trigger.time !== "string" || !TIME.test(trigger.time)) {
				return "The schedule needs a time as HH:MM";
			}
			if (
				!Array.isArray(trigger.days) ||
				trigger.days.length === 0 ||
				trigger.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
			) {
				return "The schedule needs at least one day of the week";
			}
			const title = singleLine(trigger.title, 200);
			if (!title) return "The schedule needs a card title";
			const prompt = text(trigger.prompt, 10000);
			if (!prompt) return "The schedule needs a description for its card";
			const days = [...new Set(trigger.days as number[])].sort();
			return { type: "schedule", time: trigger.time, days, title, prompt };
		}
		case "pr_opened": {
			if (trigger.base === undefined || trigger.base === "") {
				return { type: "pr_opened" };
			}
			if (typeof trigger.base !== "string" || !BRANCH.test(trigger.base)) {
				return "The trigger's base branch is not a branch name";
			}
			return { type: "pr_opened", base: trigger.base };
		}
		default:
			return "Unknown trigger";
	}
}

function parseEngine(raw: unknown): EngineTrio | undefined | string {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object") return "The engine must be an object";
	const { provider, model, effort } = raw as Record<string, unknown>;
	if (typeof provider !== "string" || !PROVIDER.test(provider)) {
		return "The engine has no valid provider";
	}
	const cleanModel = singleLine(model, 200);
	if (!cleanModel) return "The engine has no valid model";
	if (typeof effort !== "string" || !EFFORTS.has(effort)) {
		return "The engine has no valid effort";
	}
	return { provider, model: cleanModel, effort } as EngineTrio;
}

/**
 * The rule the renderer sent, checked. `existing` is the stored rule with
 * the same id, whose `createdAt` a save keeps: moving it would make old
 * events new.
 */
export function parseRule(
	raw: unknown,
	existing?: AutomationRule,
	now: Date = new Date(),
): AutomationRule | string {
	if (!raw || typeof raw !== "object") return "A rule must be an object";
	const rule = raw as Record<string, unknown>;
	const name = singleLine(rule.name, 80);
	if (!name) return "A rule needs a name";
	const trigger = parseTrigger(rule.trigger);
	if (typeof trigger === "string") return trigger;
	let kind: TaskKind | undefined;
	if (rule.kind !== undefined && rule.kind !== null && rule.kind !== "") {
		if (!TASK_KINDS.includes(rule.kind as TaskKind)) return "Unknown card kind";
		kind = rule.kind as TaskKind;
	}
	const engine = parseEngine(rule.engine);
	if (typeof engine === "string") return engine;
	const cap = rule.dailyCap ?? DEFAULT_DAILY_CAP;
	if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > MAX_DAILY_CAP) {
		return `The daily cap is between 1 and ${MAX_DAILY_CAP}`;
	}
	if (existing && existing.trigger.type !== trigger.type) {
		// A new kind of event is a new rule: its history says nothing about it.
		return "A rule keeps its trigger type; create another rule instead";
	}
	// A PR rule makes no card: it starts the GitHub PRs review, with that
	// page's engine, and its result is a draft nothing here can turn off.
	const review = trigger.type === "pr_opened";
	return {
		id: existing?.id ?? newRuleId(),
		name,
		enabled: rule.enabled !== false,
		trigger,
		...(kind && !review && { kind }),
		...(engine && !review && { engine }),
		// Draft unless the person turned it off, explicitly.
		draft: review || rule.draft !== false,
		dailyCap: cap as number,
		createdAt: existing?.createdAt ?? now.toISOString(),
	};
}

/** A rule read back from disk: the same checks, the stored identity kept. */
export function parseStoredRule(raw: unknown): AutomationRule | null {
	if (!raw || typeof raw !== "object") return null;
	const stored = raw as Record<string, unknown>;
	if (!isRuleId(stored.id) || typeof stored.createdAt !== "string") return null;
	if (Number.isNaN(Date.parse(stored.createdAt))) return null;
	const parsed = parseRule(raw);
	if (typeof parsed === "string") return null;
	return { ...parsed, id: stored.id, createdAt: stored.createdAt };
}
