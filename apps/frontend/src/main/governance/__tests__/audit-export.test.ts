/**
 * The policy's audit trail exported for compliance (#353, lot 2): each event
 * rebuilt from what the runner read in the project, and no CSV cell a
 * spreadsheet would run as a formula.
 */

import { describe, expect, it } from "vitest";
import { AUDIT_COLUMNS, auditEvents, auditFormat, auditMetrics, serializeAudit, toCsv } from "../audit-export";

const event = {
	id: "abc",
	at: "2026-06-01T08:00:00+00:00",
	user: "dev",
	task: "007-db",
	tool: "Write",
	targetKind: "file",
	target: "db/migrations/1.sql",
	decision: "deny",
	rules: ["files.forbidden:**/migrations/**"],
	reason: 'Guardrail triggered: "no", really',
	provider: "openai",
	model: "gpt-5",
};

describe("auditFormat", () => {
	it("takes csv or json only", () => {
		expect(auditFormat("csv")).toBe("csv");
		expect(auditFormat("json")).toBe("json");
		expect(() => auditFormat("xlsx")).toThrow(/csv or json/);
		expect(() => auditFormat(undefined)).toThrow(/csv or json/);
	});
});

describe("auditEvents", () => {
	it("rebuilds each event and drops what is not one", () => {
		const events = auditEvents({
			events: [
				event,
				null,
				"line",
				{ ...event, decision: "forged" },
				{ decision: "warn", rules: [1, "a".repeat(300)], targetKind: "elsewhere", reason: "x".repeat(2000) },
				{ decision: "review", rules: "not a list" },
			],
		});
		expect(events).toHaveLength(3);
		expect(events[0]).toEqual(event);
		expect(events[1]).toMatchObject({ id: "", at: "", user: null, targetKind: null });
		expect(events[1].rules).toEqual(["a".repeat(200)]);
		expect(events[1].reason).toHaveLength(1000);
		expect(events[2].rules).toEqual([]);
		expect(events[2].targetKind).toBeNull();
	});

	it("reads nothing from an answer without events", () => {
		expect(auditEvents(null)).toEqual([]);
		expect(auditEvents({ events: "x" })).toEqual([]);
	});

	it("keeps command targets", () => {
		expect(auditEvents({ events: [{ ...event, targetKind: "command" }] })[0].targetKind).toBe("command");
	});
});

describe("auditMetrics", () => {
	it("keeps whole, positive, bounded counts and reads garbage as zero", () => {
		expect(auditMetrics({ metrics: { blocked24h: 3, breakerTrips7d: 2 } })).toEqual({ blocked24h: 3, breakerTrips7d: 2 });
		expect(auditMetrics({ metrics: { blocked24h: -1, breakerTrips7d: "9" } })).toEqual({
			blocked24h: 0,
			breakerTrips7d: 0,
		});
		expect(auditMetrics({ metrics: { blocked24h: Number.NaN } })).toEqual({ blocked24h: 0, breakerTrips7d: 0 });
		expect(auditMetrics(null)).toEqual({ blocked24h: 0, breakerTrips7d: 0 });
	});

	it("keeps a breaker trip in the trail", () => {
		expect(auditEvents({ events: [{ ...event, decision: "tool_loop" }] })[0].decision).toBe("tool_loop");
	});
});

describe("toCsv", () => {
	it("writes a header and quotes what needs it", () => {
		const [header, row] = toCsv(auditEvents({ events: [event] })).split("\r\n");
		expect(header).toBe(AUDIT_COLUMNS.join(","));
		expect(row).toContain('"Guardrail triggered: ""no"", really"');
		expect(row).toContain("files.forbidden:**/migrations/**");
	});

	it("neutralises cells a spreadsheet would run", () => {
		const csv = toCsv(
			auditEvents({ events: [{ ...event, target: "=HYPERLINK(1)", reason: "@SUM(A1)", user: "-1", model: "+x" }] }),
		);
		expect(csv).toContain("'=HYPERLINK(1)");
		expect(csv).toContain("'@SUM(A1)");
		expect(csv).toContain("'-1");
		expect(csv).toContain("'+x");
	});
});

describe("serializeAudit", () => {
	it("writes JSON with the events", () => {
		const events = auditEvents({ events: [event] });
		expect(JSON.parse(serializeAudit("json", events))).toEqual({ events });
		expect(serializeAudit("csv", events).startsWith("at,user")).toBe(true);
	});
});
