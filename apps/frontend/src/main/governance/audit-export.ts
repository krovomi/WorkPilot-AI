/**
 * The policy's audit trail as a file for compliance: CSV or JSON.
 *
 * The events come from the Python runner, which read them from
 * `.workpilot/policy-audit.jsonl` — a file in the project, so data, never
 * trusted: each event is rebuilt field by field (closed list of decisions,
 * strings bounded), and a CSV cell that a spreadsheet would read as a formula
 * (`=`, `+`, `-`, `@`, tab, carriage return) is prefixed with an apostrophe.
 */

import {
	type AuditExportFormat,
	type GovernanceMetrics,
	POLICY_DECISIONS,
	type PolicyAuditEvent,
	type PolicyDecision,
} from "../../shared/types/governance";

export const AUDIT_FORMATS: readonly AuditExportFormat[] = ["csv", "json"];

/** The columns of the CSV, in this order: who, when, what, decision, why, which model, who approved. */
export const AUDIT_COLUMNS = [
	"at",
	"user",
	"task",
	"tool",
	"targetKind",
	"target",
	"decision",
	"rules",
	"reason",
	"provider",
	"model",
	"approvedBy",
] as const;

const MAX_EVENTS = 10_000;
const MAX_FIELD = 1_000;

export function auditFormat(value: unknown): AuditExportFormat {
	if (typeof value === "string" && (AUDIT_FORMATS as readonly string[]).includes(value)) {
		return value as AuditExportFormat;
	}
	throw new Error("format must be csv or json");
}

function text(value: unknown): string | null {
	return typeof value === "string" && value ? value.slice(0, MAX_FIELD) : null;
}

/** The events of a runner answer, rebuilt; anything else is dropped. */
export function auditEvents(answer: unknown): PolicyAuditEvent[] {
	const raw = (answer as { events?: unknown } | null)?.events;
	if (!Array.isArray(raw)) return [];
	const events: PolicyAuditEvent[] = [];
	for (const item of raw.slice(0, MAX_EVENTS)) {
		if (!item || typeof item !== "object") continue;
		const e = item as Record<string, unknown>;
		if (!(POLICY_DECISIONS as readonly unknown[]).includes(e.decision)) continue;
		events.push({
			id: text(e.id) ?? "",
			at: text(e.at) ?? "",
			user: text(e.user),
			task: text(e.task),
			tool: text(e.tool),
			targetKind: e.targetKind === "file" || e.targetKind === "command" ? e.targetKind : null,
			target: text(e.target),
			decision: e.decision as PolicyDecision,
			rules: Array.isArray(e.rules)
				? e.rules.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, 200)).slice(0, 20)
				: [],
			reason: text(e.reason),
			provider: text(e.provider),
			model: text(e.model),
			approvedBy: e.decision === "approved" ? text(e.approvedBy) : null,
		});
	}
	return events;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), 1_000_000) : 0;
}

/** The trail's counts of a runner answer, each a bounded whole number (0 when unreadable). */
export function auditMetrics(answer: unknown): GovernanceMetrics {
	const raw = (answer as { metrics?: Record<string, unknown> } | null)?.metrics;
	return { blocked24h: count(raw?.blocked24h), breakerTrips7d: count(raw?.breakerTrips7d) };
}

function cell(value: string | null): string {
	let out = value ?? "";
	if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
	return /[",\r\n]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

export function toCsv(events: readonly PolicyAuditEvent[]): string {
	const rows = [AUDIT_COLUMNS.join(",")];
	for (const event of events) {
		rows.push(
			AUDIT_COLUMNS.map((column) =>
				cell(column === "rules" ? event.rules.join(" ") : (event[column] as string | null)),
			).join(","),
		);
	}
	return `${rows.join("\r\n")}\r\n`;
}

export function serializeAudit(format: AuditExportFormat, events: readonly PolicyAuditEvent[]): string {
	return format === "csv" ? toCsv(events) : `${JSON.stringify({ events }, null, 2)}\n`;
}
