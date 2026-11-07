/**
 * The automations of a server project (server mode): its rules live on the
 * server, shared by the team, and the server runs them every five minutes,
 * whether or not anyone has the app open
 * (`apps/backend/shared_features/automations/`). The settings panel reads and
 * changes them here, through the server's routes, by project id; this
 * computer's scheduler never runs them (`automations/scheduler.ts`).
 *
 * What the server sends back is checked again: each rule passes the same
 * checks as a rule read from disk (`parseStoredRule`), lists are cut and
 * strings bounded. A rule id goes into a URL only once it has the id's shape.
 */

import type {
	AutomationActivity,
	AutomationRuleStatus,
	AutomationsState,
	IPCResult,
	Project,
} from "../shared/types";
import { isRuleId, MAX_RULES, parseStoredRule } from "./automations/rules";
import { authedFetch } from "./server-connection";

const ROUTE = "/api/board/automations";
const MAX_ACTIVITY = 100;
const MAX_TEXT = 2_000;
const UNEXPECTED = "Unexpected answer from the server";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit = MAX_TEXT): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function toStatus(raw: unknown): AutomationRuleStatus | null {
	if (!isRecord(raw)) return null;
	const status: AutomationRuleStatus = {
		createdToday: count(raw.createdToday),
		deferred: count(raw.deferred),
	};
	const lastRunAt = text(raw.lastRunAt, 64);
	if (lastRunAt) status.lastRunAt = lastRunAt;
	const lastError = text(raw.lastError, 64);
	if (lastError) status.lastError = lastError as AutomationRuleStatus["lastError"];
	const detail = text(raw.lastErrorDetail);
	if (detail) status.lastErrorDetail = detail;
	return status;
}

function toActivity(raw: unknown): AutomationActivity | null {
	if (!isRecord(raw)) return null;
	const at = text(raw.at, 64);
	const ruleId = text(raw.ruleId, 64);
	const outcome = text(raw.outcome, 40);
	if (!at || !ruleId || !outcome) return null;
	const entry: AutomationActivity = {
		at,
		ruleId,
		ruleName: text(raw.ruleName, 200) ?? "",
		outcome: outcome as AutomationActivity["outcome"],
		subject: text(raw.subject, 300) ?? "",
	};
	const specId = text(raw.specId, 200);
	if (specId) entry.specId = specId;
	const url = text(raw.url);
	if (url?.startsWith("https://")) entry.url = url;
	const reason = text(raw.reason, 64);
	if (reason) entry.reason = reason as AutomationActivity["reason"];
	const detail = text(raw.detail);
	if (detail) entry.detail = detail;
	return entry;
}

/** The server's answer as the panel's state, or null when it is not one. */
export function toAutomationsState(raw: unknown): AutomationsState | null {
	if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
	const rules = raw.rules
		.slice(0, MAX_RULES)
		.map(parseStoredRule)
		.filter((rule): rule is NonNullable<typeof rule> => rule !== null);
	const ids = new Set(rules.map((rule) => rule.id));
	const statuses: Record<string, AutomationRuleStatus> = {};
	const owners: Record<string, string> = {};
	if (isRecord(raw.statuses)) {
		for (const [id, value] of Object.entries(raw.statuses)) {
			const status = ids.has(id) ? toStatus(value) : null;
			if (status) statuses[id] = status;
		}
	}
	if (isRecord(raw.owners)) {
		for (const [id, value] of Object.entries(raw.owners)) {
			const name = ids.has(id) ? text(value, 200) : undefined;
			if (name) owners[id] = name;
		}
	}
	const activity = (Array.isArray(raw.activity) ? raw.activity : [])
		.slice(0, MAX_ACTIVITY)
		.map(toActivity)
		.filter((entry): entry is AutomationActivity => entry !== null);
	return { rules, statuses, activity, owners, runsOn: "server" };
}

async function call(
	project: Project,
	route: string,
	method: string,
	body?: unknown,
): Promise<IPCResult<AutomationsState>> {
	const answer = await authedFetch<unknown>(
		`${ROUTE}${route}?project_id=${encodeURIComponent(project.id)}`,
		method,
		body,
	);
	if (!answer.ok) return { success: false, error: answer.error };
	const state = toAutomationsState(answer.data);
	return state ? { success: true, data: state } : { success: false, error: UNEXPECTED };
}

export function getServerAutomations(project: Project): Promise<IPCResult<AutomationsState>> {
	return call(project, "", "GET");
}

/** The rule goes as data; the server checks every field, as the main does locally. */
export function saveServerAutomation(
	project: Project,
	raw: unknown,
): Promise<IPCResult<AutomationsState>> {
	if (!isRecord(raw)) return Promise.resolve({ success: false, error: "A rule must be an object" });
	return call(project, "/rules", "POST", raw);
}

export function deleteServerAutomation(
	project: Project,
	ruleId: unknown,
): Promise<IPCResult<AutomationsState>> {
	if (!isRuleId(ruleId)) return Promise.resolve({ success: false, error: "Unknown rule" });
	return call(project, `/rules/${ruleId}`, "DELETE");
}

export function runServerAutomations(project: Project): Promise<IPCResult<AutomationsState>> {
	return call(project, "/run", "POST");
}
