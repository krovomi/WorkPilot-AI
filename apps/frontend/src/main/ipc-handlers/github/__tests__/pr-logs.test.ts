/**
 * @vitest-environment node
 *
 * The PR review log, in a real project folder: the runner's lines become
 * entries of the context, analysis and synthesis phases, saved as they come
 * so the window can follow them; what is read back is cleaned first. The PR
 * number names the file, so only a positive integer can.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../../../../shared/types";
import {
	PRLogCollector,
	type PRLogs,
	addLogEntry,
	createEmptyPRLogs,
	getGitHubDir,
	getPRLogsPath,
	getPhaseFromSource,
	loadPRLogs,
	parseLogLine,
	sanitizeNetworkData,
} from "../pr-logs";

let root: string;
let project: Project;
const logsFile = (n = 7) => path.join(root, ".workpilot", "github", "pr", `logs_${n}.json`);
const onDisk = (n = 7): PRLogs => JSON.parse(readFileSync(logsFile(n), "utf-8"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-pr-logs-"));
	project = { id: "p", name: "P", path: root } as Project;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("sanitizeNetworkData", () => {
	it("drops control characters but keeps tabs and line breaks, and bounds the length", () => {
		expect(sanitizeNetworkData("a\u0000b\u0007c\u001bd\u007fe\tf\ng\rh\u000bi")).toBe("abcde\tf\ng\rhi");
		expect(sanitizeNetworkData("x".repeat(20), 5)).toBe("xxxxx");
	});
});

describe("parseLogLine", () => {
	it.each([
		["[Context] Fetching PR", { source: "Context", content: "Fetching PR", isError: false }],
		["[AI] Thinking", { source: "AI", content: "Thinking", isError: false }],
		["[PR Review Engine] Done", { source: "PR Review Engine", content: "Done", isError: false }],
		["[ParallelOrchestrator] go", { source: "ParallelOrchestrator", content: "go", isError: false }],
		["[AI]", { source: "AI", content: "[AI]", isError: false }],
		["[Agent:security-reviewer] scan", { source: "Agent:security-reviewer", content: "scan", isError: false }],
		["[Specialist:perf] hot loop", { source: "Specialist:perf", content: "hot loop", isError: false }],
		["[DEBUG orchestrator] step 2", { source: "orchestrator", content: "step 2", isError: false }],
		["[ERROR PRReview] worktree failed", { source: "PRReview", content: "worktree failed", isError: true }],
		["[PR #12] [ 40%] Analyzing", { source: "Progress", content: "[40%] Analyzing", isError: false }],
		["[75%] Writing", { source: "Progress", content: "[75%] Writing", isError: false }],
		["Verdict: APPROVE", { source: "Summary", content: "Verdict: APPROVE", isError: false }],
		["PR #12 Follow-up Review Complete", { source: "Summary", content: "PR #12 Follow-up Review Complete", isError: false }],
		["## Summary", { source: "Summary", content: "## Summary", isError: false }],
		["  - [MEDIUM] unchecked input", { source: "Summary", content: "  - [MEDIUM] unchecked input", isError: false }],
		["**Recommended Actions:**", { source: "Summary", content: "**Recommended Actions:**", isError: false }],
		["1. Add a test", { source: "Summary", content: "1. Add a test", isError: false }],
		["    File: src/a.ts", { source: "Summary", content: "    File: src/a.ts", isError: false }],
	])("reads %j", (line, expected) => {
		expect(parseLogLine(line)).toEqual(expected);
	});

	it("skips the message-type debug lines and any other line", () => {
		expect(parseLogLine("[DEBUG sdk] Message #4: AssistantMessage")).toBeNull();
		expect(parseLogLine("plain output")).toBeNull();
		expect(parseLogLine("")).toBeNull();
	});
});

describe("getPhaseFromSource", () => {
	it.each([
		["Context", "context"],
		["BotDetector", "context"],
		["Followup", "context"],
		["AI", "analysis"],
		["orchestrator", "analysis"],
		["ClientCache", "analysis"],
		["Agent:x", "analysis"],
		["Specialist:y", "analysis"],
		["Summary", "synthesis"],
		["Progress", "synthesis"],
		["Whatever", "synthesis"],
	])("puts %s in the %s phase", (source, phase) => {
		expect(getPhaseFromSource(source)).toBe(phase);
	});
});

describe("the log on disk", () => {
	it("is kept under .workpilot/github/pr, one file per pull request", () => {
		expect(getGitHubDir(project)).toBe(path.join(root, ".workpilot", "github"));
		expect(getPRLogsPath(project, 7)).toBe(logsFile(7));
	});

	it.each([["../../../outside"], ["7/../../x"], [0], [-1], [1.5], [Number.NaN], [null]])(
		"refuses %j as a PR number, which could name another file",
		(prNumber) => {
			expect(() => getPRLogsPath(project, prNumber as number)).toThrow("Invalid PR number");
			expect(loadPRLogs(project, prNumber as number)).toBeNull();
		},
	);

	it("reads back a saved log, cleaned, and answers null when there is none or it is broken", () => {
		expect(loadPRLogs(project, 7)).toBeNull();

		mkdirSync(path.dirname(logsFile()), { recursive: true });
		const logs = createEmptyPRLogs(7, "acme/shop", true);
		writeFileSync(logsFile(), JSON.stringify(logs).replace('"acme/shop"', '"acme/\u0007shop"'));
		expect(loadPRLogs(project, 7)).toMatchObject({ pr_number: 7, repo: "acme/shop", is_followup: true });

		writeFileSync(logsFile(), "{not json");
		expect(loadPRLogs(project, 7)).toBeNull();
	});

	it("starts a pending phase on its first entry, and only then", () => {
		const logs = createEmptyPRLogs(7, "acme/shop", false);
		const entry = { timestamp: "2026-11-15T00:00:00Z", type: "text" as const, content: "a", phase: "analysis" as const };

		expect(addLogEntry(logs, entry)).toBe(true);
		expect(addLogEntry(logs, { ...entry, content: "b" })).toBe(false);
		expect(logs.phases.analysis).toMatchObject({ status: "active", started_at: "2026-11-15T00:00:00Z" });
		expect(logs.phases.analysis.entries.map((e) => e.content)).toEqual(["a", "b"]);
		expect(logs.phases.context.status).toBe("pending");
	});
});

describe("PRLogCollector", () => {
	it("saves the empty log at once, then follows the phases of a review", () => {
		const collector = new PRLogCollector(project, 7, "acme/shop", false);
		expect(onDisk()).toMatchObject({ pr_number: 7, repo: "acme/shop", is_followup: false });
		expect(onDisk().phases.context.status).toBe("pending");

		collector.processLine("[Context] Fetching PR");
		expect(onDisk().phases.context.status).toBe("active");

		collector.processLine("noise that is not a log line");
		collector.processLine("[AI] Reviewing");
		const midway = onDisk();
		expect(midway.phases.context.status).toBe("completed");
		expect(midway.phases.analysis.status).toBe("active");

		collector.processLine("[ERROR PRReview] tool failed");
		collector.processLine("Verdict: NEEDS_REVISION");
		collector.finalize(true);

		const done = onDisk();
		expect(done.phases.analysis.status).toBe("completed");
		expect(done.phases.analysis.entries.map((e) => [e.type, e.content])).toEqual([
			["text", "Reviewing"],
			["error", "tool failed"],
		]);
		expect(done.phases.synthesis).toMatchObject({ status: "completed" });
		expect(done.phases.synthesis.entries[0]).toMatchObject({ source: "Summary", content: "Verdict: NEEDS_REVISION" });
		expect(done.phases.synthesis.completed_at).not.toBeNull();
	});

	it("marks the phase still running failed when the review fails, and leaves a skipped one pending", () => {
		const collector = new PRLogCollector(project, 8, "acme/shop", true);

		collector.processLine("[Followup] Comparing commits");
		collector.processLine("[75%] Writing");
		collector.finalize(false);

		const logs = onDisk(8);
		expect(logs.phases.context.status).toBe("completed");
		expect(logs.phases.analysis.status).toBe("pending");
		expect(logs.phases.synthesis.status).toBe("failed");
	});

	it("keeps an analysis phase open when the review goes back to it, and saves every third entry", () => {
		const collector = new PRLogCollector(project, 9, "acme/shop", false);

		collector.processLine("[AI] one");
		collector.processLine("[Context] late context");
		collector.processLine("[AI] two");
		collector.processLine("[AI] three");
		expect(onDisk(9).phases.analysis.entries).toHaveLength(2);

		collector.processLine("[AI] four");
		collector.processLine("[AI] five");
		expect(onDisk(9).phases.analysis.entries).toHaveLength(5);
		expect(onDisk(9).phases.analysis.status).toBe("active");
	});

	it("does not create a log for a number that is not one", () => {
		expect(() => new PRLogCollector(project, "../x" as unknown as number, "acme/shop", false)).toThrow(
			"Invalid PR number",
		);
		expect(existsSync(path.join(root, ".workpilot"))).toBe(false);
	});
});
