/**
 * Where a project's automations live: `rules.json` (what the person set up)
 * and `ledger.json` (what the rules already did). Both are written whole,
 * through a temporary file, so a crash leaves the previous version.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
	AutomationActivity,
	AutomationOutcome,
	AutomationRule,
	AutomationRuleStatus,
	Project,
} from "../../shared/types";
import { parseStoredRule } from "./rules";

const MAX_SEEN = 2000;
const MAX_ACTIVITY = 100;

/** An event a rule already answered, by its dedup key. */
export interface SeenEvent {
	ruleId: string;
	at: string;
	outcome: AutomationOutcome;
	specId?: string;
}

export interface Ledger {
	seen: Record<string, SeenEvent>;
	/** Cards created, per rule, per local day (`YYYY-MM-DD`). */
	created: Record<string, Record<string, number>>;
	/** The card a CI rule opened for the current red streak. */
	openCi: Record<string, string>;
	statuses: Record<string, AutomationRuleStatus>;
	activity: AutomationActivity[];
}

export function automationsDir(project: Project): string {
	return path.join(project.path, project.autoBuildPath || ".workpilot", "automations");
}

function readJson(file: string): unknown {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	renameSync(tmp, file);
}

export function readRules(project: Project): AutomationRule[] {
	const raw = readJson(path.join(automationsDir(project), "rules.json"));
	const list = Array.isArray((raw as { rules?: unknown })?.rules)
		? (raw as { rules: unknown[] }).rules
		: [];
	// A rule that no longer passes the checks is not run; it is not guessed at.
	return list
		.map(parseStoredRule)
		.filter((rule): rule is AutomationRule => rule !== null);
}

export function writeRules(project: Project, rules: AutomationRule[]): void {
	writeJson(path.join(automationsDir(project), "rules.json"), { version: 1, rules });
}

function emptyLedger(): Ledger {
	return { seen: {}, created: {}, openCi: {}, statuses: {}, activity: [] };
}

export function readLedger(project: Project): Ledger {
	const raw = readJson(path.join(automationsDir(project), "ledger.json"));
	if (!raw || typeof raw !== "object") return emptyLedger();
	const ledger = raw as Partial<Ledger>;
	const record = (value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		seen: record(ledger.seen) as Ledger["seen"],
		created: record(ledger.created) as Ledger["created"],
		openCi: record(ledger.openCi) as Ledger["openCi"],
		statuses: record(ledger.statuses) as Ledger["statuses"],
		activity: Array.isArray(ledger.activity) ? ledger.activity : [],
	};
}

export function writeLedger(project: Project, ledger: Ledger): void {
	const seen = Object.entries(ledger.seen);
	if (seen.length > MAX_SEEN) {
		// The oldest go first. A card's own metadata still dedups an issue,
		// and an ignored event is ignored again when it comes back.
		seen.sort(([, a], [, b]) => a.at.localeCompare(b.at));
		ledger.seen = Object.fromEntries(seen.slice(seen.length - MAX_SEEN));
	}
	ledger.activity = ledger.activity.slice(-MAX_ACTIVITY);
	writeJson(path.join(automationsDir(project), "ledger.json"), ledger);
}

/** A rule's history goes with it: a new rule with the same name starts clean. */
export function forgetRule(ledger: Ledger, ruleId: string): void {
	for (const [key, event] of Object.entries(ledger.seen)) {
		if (event.ruleId === ruleId) delete ledger.seen[key];
	}
	delete ledger.created[ruleId];
	delete ledger.openCi[ruleId];
	delete ledger.statuses[ruleId];
}
