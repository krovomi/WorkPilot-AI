import { describe, expect, it } from "vitest";
import type { TaskLogEntry, TaskLogPhase, TaskLogs } from "../types";
import {
	flattenTaskLogsToLines,
	getActiveLogPhase,
	LOG_PHASE_ORDER,
} from "./task-logs";

function makeLogs(
	statuses: Partial<Record<TaskLogPhase, string>>,
): TaskLogs {
	const phase = (status: string) => ({ status, entries: [] });
	return {
		phases: {
			planning: phase(statuses.planning ?? "pending"),
			coding: phase(statuses.coding ?? "pending"),
			validation: phase(statuses.validation ?? "pending"),
		},
	} as unknown as TaskLogs;
}

describe("getActiveLogPhase", () => {
	it("returns null for null/undefined logs", () => {
		expect(getActiveLogPhase(null)).toBeNull();
		expect(getActiveLogPhase(undefined)).toBeNull();
	});

	it("returns null when no phase is active", () => {
		expect(
			getActiveLogPhase(
				makeLogs({ planning: "completed", coding: "completed" }),
			),
		).toBeNull();
	});

	it("returns the active phase when it is the last one (validation)", () => {
		expect(
			getActiveLogPhase(
				makeLogs({
					planning: "completed",
					coding: "completed",
					validation: "active",
				}),
			),
		).toBe("validation");
	});

	it("returns planning when the task regressed to an earlier phase", () => {
		// validation already ran (completed) but planning is active again — the
		// exact regression case where anchoring to the document bottom is wrong.
		expect(
			getActiveLogPhase(
				makeLogs({ planning: "active", validation: "completed" }),
			),
		).toBe("planning");
	});

	it("prefers the earliest active phase in canonical order", () => {
		expect(
			getActiveLogPhase(makeLogs({ coding: "active", validation: "active" })),
		).toBe("coding");
	});

	it("exposes the canonical phase order", () => {
		expect(LOG_PHASE_ORDER).toEqual(["planning", "coding", "validation"]);
	});
});

function makeLogsWithEntries(
	entries: Partial<Record<TaskLogPhase, Partial<TaskLogEntry>[]>>,
): TaskLogs {
	const phase = (list: Partial<TaskLogEntry>[] = []) => ({
		status: "completed",
		entries: list,
	});
	return {
		phases: {
			planning: phase(entries.planning),
			coding: phase(entries.coding),
			validation: phase(entries.validation),
		},
	} as unknown as TaskLogs;
}

describe("flattenTaskLogsToLines", () => {
	it("returns an empty array for null/undefined logs", () => {
		expect(flattenTaskLogsToLines(null)).toEqual([]);
		expect(flattenTaskLogsToLines(undefined)).toEqual([]);
	});

	it("flattens entries in canonical phase order", () => {
		const lines = flattenTaskLogsToLines(
			makeLogsWithEntries({
				validation: [{ type: "text", content: "QA passed" }],
				planning: [{ type: "text", content: "Plan ready" }],
				coding: [{ type: "text", content: "Wrote code" }],
			}),
		);
		expect(lines).toEqual(["Plan ready", "Wrote code", "QA passed"]);
	});

	it("formats tool entries with name and input, and skips empty lines", () => {
		const lines = flattenTaskLogsToLines(
			makeLogsWithEntries({
				coding: [
					{ type: "tool_start", tool_name: "Edit", tool_input: "file.ts" },
					{ type: "tool_end", tool_name: "Edit" },
					{ type: "text", content: "   " },
				],
			}),
		);
		expect(lines).toEqual(["⚙️ Edit file.ts", "✅ Edit"]);
	});
});
