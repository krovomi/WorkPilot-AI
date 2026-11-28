/**
 * The organization's usage report and token budgets (server mode).
 *
 * Report: its settings (`GET` / `PUT /admin/usage/report/settings`), the
 * report of one day, week or month (`GET /admin/usage/report`, what the email
 * carries) and a send now (`POST /admin/usage/report/send`). Budgets: the
 * monthly token budgets per person, group or project (`GET` / `PUT
 * /admin/usage/budgets`, `DELETE /admin/usage/budgets/{id}`).
 *
 * The renderer is not trusted (rule S6): every argument is checked here with
 * the server's own bounds (`services/report_settings.py`,
 * `routers/usage_budgets.py`) before a request leaves, and an id reaches the
 * URL only when it has the shape of one. The server checks the permission
 * (`usage.read` to read, `usage.write` to change or send) and the values again.
 */

import type {
	UsageBudgets,
	UsageBudgetScope,
	UsageBudgetUpdate,
	UsageReport,
	UsageReportKind,
	UsageReportSent,
	UsageReportSettings,
	UsageReportSettingsUpdate,
	UsageResult,
} from "../shared/types/server-usage";
import { authedFetch } from "./server-connection";

/** As the server bounds them (`services/report_settings.py`). */
export const MAX_RECIPIENTS = 20;
/** As the server bounds a budget (`services/usage_budgets.py`). */
export const MAX_BUDGET_TOKENS = 10 ** 12;
export const REPORT_KINDS: readonly UsageReportKind[] = ["daily", "weekly", "monthly"];
export const BUDGET_SCOPES: readonly UsageBudgetScope[] = ["person", "group", "project"];

const SETTINGS = "/admin/usage/report/settings";
const BUDGETS = "/admin/usage/budgets";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** An IANA name's characters; the server checks the zone exists. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
/** A plain address: one `@`, no space, a dot in the domain (as the server reads it). */
const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9-]{1,36}$/;

function invalid(what: string): { ok: false; error: string } {
	return { ok: false, error: `Invalid ${what}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function weekdays(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 7) return null;
	if (!value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
	return [...new Set(value as number[])].sort((a, b) => a - b);
}

function addresses(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) return null;
	const found: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") return null;
		const address = raw.trim();
		if (address.length > 254 || !EMAIL.test(address)) return null;
		if (!found.some((a) => a.toLowerCase() === address.toLowerCase())) found.push(address);
	}
	return found;
}

/** The settings the renderer sent, checked, or null when anything is off. */
export function reportSettingsOf(body: unknown): UsageReportSettingsUpdate | null {
	if (!isRecord(body)) return null;
	const days = weekdays(body.days);
	const recipients = addresses(body.recipients);
	const flags = ["enabled", "names", "weekly", "monthly"] as const;
	if (
		days === null ||
		recipients === null ||
		!flags.every((f) => typeof body[f] === "boolean") ||
		typeof body.time !== "string" ||
		!TIME.test(body.time) ||
		typeof body.timezone !== "string" ||
		!ZONE.test(body.timezone) ||
		(body.language !== "fr" && body.language !== "en")
	) {
		return null;
	}
	return {
		enabled: body.enabled as boolean,
		time: body.time,
		timezone: body.timezone,
		days,
		recipients,
		language: body.language,
		names: body.names as boolean,
		weekly: body.weekly as boolean,
		monthly: body.monthly as boolean,
	};
}

/** When and to whom the report goes, and its last sends (`usage.read`). */
export function getReportSettings(): Promise<UsageResult<UsageReportSettings>> {
	return authedFetch<UsageReportSettings>(SETTINGS, "GET");
}

/** Change them (`usage.write`). */
export async function setReportSettings(
	body: unknown,
): Promise<UsageResult<UsageReportSettings>> {
	const update = reportSettingsOf(body);
	if (update === null) return invalid("report settings");
	return authedFetch<UsageReportSettings>(SETTINGS, "PUT", update);
}

/**
 * The report of the period of `kind` holding `day` (by default the last full
 * one), as the email carries it (`usage.read`).
 */
export async function getReport(kind: unknown, day?: unknown): Promise<UsageResult<UsageReport>> {
	if (typeof kind !== "string" || !REPORT_KINDS.includes(kind as UsageReportKind)) {
		return invalid("report kind");
	}
	const params = new URLSearchParams({ kind });
	if (day !== undefined && day !== null && day !== "") {
		if (typeof day !== "string" || !DAY.test(day)) return invalid("report day");
		params.set("day", day);
	}
	return authedFetch<UsageReport>(`/admin/usage/report?${params.toString()}`, "GET");
}

/** Send the last daily report now, to its recipients (`usage.write`). */
export function sendReportNow(): Promise<UsageResult<UsageReportSent>> {
	return authedFetch<UsageReportSent>("/admin/usage/report/send", "POST");
}

/** The budgets with this month's use, and the last alerts (`usage.read`). */
export function getBudgets(): Promise<UsageResult<UsageBudgets>> {
	return authedFetch<UsageBudgets>(BUDGETS, "GET");
}

/** The budget the renderer sent, checked, or null when anything is off. */
export function budgetOf(body: unknown): UsageBudgetUpdate | null {
	if (!isRecord(body)) return null;
	const { scope, target_id: target, monthly_tokens: tokens, block } = body;
	if (
		typeof scope !== "string" ||
		!BUDGET_SCOPES.includes(scope as UsageBudgetScope) ||
		typeof target !== "string" ||
		!ID.test(target) ||
		typeof tokens !== "number" ||
		!Number.isInteger(tokens) ||
		tokens < 1 ||
		tokens > MAX_BUDGET_TOKENS ||
		typeof block !== "boolean"
	) {
		return null;
	}
	return { scope: scope as UsageBudgetScope, target_id: target, monthly_tokens: tokens, block };
}

/** Set one budget, new or changed (`usage.write`). */
export async function setBudget(body: unknown): Promise<UsageResult<UsageBudgets>> {
	const budget = budgetOf(body);
	if (budget === null) return invalid("budget");
	return authedFetch<UsageBudgets>(BUDGETS, "PUT", budget);
}

/** Remove one (`usage.write`). */
export async function removeBudget(budgetId: unknown): Promise<UsageResult<UsageBudgets>> {
	if (typeof budgetId !== "string" || !ID.test(budgetId)) return invalid("budget");
	return authedFetch<UsageBudgets>(`${BUDGETS}/${budgetId}`, "DELETE");
}
