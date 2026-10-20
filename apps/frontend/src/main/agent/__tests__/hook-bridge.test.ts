/**
 * The bridge exists because the hooks bus had no producer: `emit_event` was
 * reachable only over HTTP, and nothing in the product called it.
 *
 * The mapping is the part worth pinning. Forwarding everything would point a
 * firehose at an execution engine that can create specs and run agents, so
 * these tests assert both halves: the lifecycle events are carried, and the
 * per-feature progress families are not.
 */

import { describe, expect, it } from "vitest";
import { triggerForTaskEvent } from "../hook-bridge";

describe("triggerForTaskEvent", () => {
	describe("lifecycle events reach the bus", () => {
		it.each([
			["PLANNING_STARTED", "build_started"],
			["ALL_SUBTASKS_DONE", "build_completed"],
			["QA_PASSED", "test_passed"],
			["QA_FAILED", "test_failed"],
			["QA_MAX_ITERATIONS", "build_failed"],
			["QA_FIXING_COMPLETE", "agent_completed"],
			["AUTO_FIX_SUCCESS", "agent_completed"],
			["QA_AGENT_ERROR", "agent_failed"],
			["AUTO_FIX_FAILED", "agent_failed"],
			["AUTO_FIX_ESCALATED", "agent_failed"],
		])("%s maps to %s", (event, trigger) => {
			expect(triggerForTaskEvent(event)).toBe(trigger);
		});
	});

	describe("per-feature progress events do not", () => {
		it.each([
			"CARBON_RESULT",
			"DOC_DRIFT_EVENT",
			"FLAKY_ERROR",
			"SANDBOX_RESULT",
			"COMPLIANCE_EVENT",
			"AGENT_COACH_ERROR",
			"DECISION_LOG_ENTRY",
			"PHASE_START",
		])("%s is not forwarded", (event) => {
			expect(triggerForTaskEvent(event)).toBeNull();
		});
	});

	describe("degrades safely", () => {
		it("returns null for an absent type", () => {
			expect(triggerForTaskEvent(undefined)).toBeNull();
		});

		it("returns null for an empty type", () => {
			expect(triggerForTaskEvent("")).toBeNull();
		});

		it("returns null for an unknown type rather than inventing a trigger", () => {
			expect(triggerForTaskEvent("SOMETHING_NEW")).toBeNull();
		});

		it("does not resolve inherited Object properties as triggers", () => {
			// A plain-object lookup table would answer "constructor" here.
			expect(triggerForTaskEvent("constructor")).toBeNull();
			expect(triggerForTaskEvent("toString")).toBeNull();
			expect(triggerForTaskEvent("__proto__")).toBeNull();
		});
	});
});
