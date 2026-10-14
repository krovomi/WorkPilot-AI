import { describe, expect, it } from "vitest";
import {
	buildContextActionMarker,
	contextZone,
	DEFAULT_CONTEXT_POLICY,
	formatTokenCount,
	isContextEventType,
	isDefaultContextPolicy,
	normalizeContextPolicy,
	normalizeThreshold,
	parseContextEvent,
	resolveContextPolicy,
	sameContextPolicy,
} from "../context-policy";

describe("normalizeThreshold", () => {
	it("clamps to 30..90 and snaps to the 5-point grid", () => {
		expect(normalizeThreshold(10)).toBe(30);
		expect(normalizeThreshold(99)).toBe(90);
		expect(normalizeThreshold(52)).toBe(50);
		expect(normalizeThreshold(53)).toBe(55);
		expect(normalizeThreshold("65")).toBe(65);
	});

	it("falls back to the default on garbage", () => {
		expect(normalizeThreshold(Number.NaN)).toBe(50);
		expect(normalizeThreshold(undefined)).toBe(50);
		expect(normalizeThreshold("abc")).toBe(50);
		expect(normalizeThreshold(null)).toBe(50);
	});
});

describe("normalizeContextPolicy / resolveContextPolicy", () => {
	it("absent metadata gives the defaults", () => {
		expect(resolveContextPolicy(undefined)).toEqual(DEFAULT_CONTEXT_POLICY);
		expect(resolveContextPolicy({})).toEqual({
			mode: "auto",
			thresholdPct: 50,
			prepareHandoff: true,
		});
	});

	it("keeps valid fields and repairs the rest", () => {
		expect(
			normalizeContextPolicy({ mode: "clear", thresholdPct: 72, prepareHandoff: false }),
		).toEqual({ mode: "clear", thresholdPct: 70, prepareHandoff: false });
		expect(
			normalizeContextPolicy({ mode: "nuke", thresholdPct: "x", prepareHandoff: "yes" }),
		).toEqual({ mode: "auto", thresholdPct: 50, prepareHandoff: true });
	});

	it("compares policies by value", () => {
		expect(isDefaultContextPolicy({ ...DEFAULT_CONTEXT_POLICY })).toBe(true);
		expect(
			sameContextPolicy(DEFAULT_CONTEXT_POLICY, {
				...DEFAULT_CONTEXT_POLICY,
				thresholdPct: 55,
			}),
		).toBe(false);
	});
});

describe("contextZone", () => {
	it("is green below, amber within 10 points, red at or above the threshold", () => {
		expect(contextZone(20, 50)).toBe("ok");
		expect(contextZone(40, 50)).toBe("near");
		expect(contextZone(49.9, 50)).toBe("near");
		expect(contextZone(50, 50)).toBe("over");
		expect(contextZone(88, 50)).toBe("over");
	});
});

describe("formatTokenCount", () => {
	it("formats compactly", () => {
		expect(formatTokenCount(950)).toBe("950");
		expect(formatTokenCount(1_500)).toBe("1.5k");
		expect(formatTokenCount(84_000)).toBe("84k");
		expect(formatTokenCount(200_000)).toBe("200k");
		expect(formatTokenCount(1_250_000)).toBe("1.3M");
		expect(formatTokenCount(-3)).toBe("0");
	});
});

describe("parseContextEvent", () => {
	it("parses a CONTEXT_USAGE event and bounds its numbers", () => {
		const event = parseContextEvent({
			type: "CONTEXT_USAGE",
			taskId: "t1",
			sequence: 4,
			phase: "coding",
			subtaskId: "1.2",
			provider: "claude",
			model: "claude-sonnet",
			usedTokens: 84_000,
			windowTokens: 200_000,
			percent: 142,
			source: "exact",
			thresholdPct: 60,
			mode: "compact",
			handoffState: "ready",
			recommended: "clear",
			compactSupport: "native",
		});
		expect(event).toMatchObject({
			type: "CONTEXT_USAGE",
			percent: 100,
			source: "exact",
			thresholdPct: 60,
			mode: "compact",
			handoffState: "ready",
			recommended: "clear",
			compactSupport: "native",
			subtaskId: "1.2",
		});
	});

	it("defaults the enums of a sparse CONTEXT_USAGE", () => {
		expect(parseContextEvent({ type: "CONTEXT_USAGE" })).toMatchObject({
			percent: 0,
			source: "estimated",
			mode: "auto",
			handoffState: "idle",
			recommended: "compact",
			compactSupport: "emulated",
			subtaskId: null,
		});
	});

	it("parses CONTEXT_ACTION_APPLIED and refuses an unknown action", () => {
		expect(
			parseContextEvent({
				type: "CONTEXT_ACTION_APPLIED",
				action: "compact",
				trigger: "manual",
				phase: "coding",
				subtaskId: null,
				provider: "codex",
				native: true,
				beforePct: 62,
				afterPct: 18,
			}),
		).toMatchObject({ action: "compact", trigger: "manual", native: true, afterPct: 18 });
		expect(
			parseContextEvent({ type: "CONTEXT_ACTION_APPLIED", action: "clear", beforePct: 71 }),
		).toMatchObject({ action: "clear", trigger: "auto", afterPct: null });
		expect(parseContextEvent({ type: "CONTEXT_ACTION_APPLIED", action: "wipe" })).toBeNull();
	});

	it("ignores other event types", () => {
		expect(parseContextEvent({ type: "QA_PASSED" })).toBeNull();
		expect(parseContextEvent(null)).toBeNull();
		expect(isContextEventType("CONTEXT_USAGE")).toBe(true);
		expect(isContextEventType("CONTEXT_ACTION_APPLIED")).toBe(true);
		expect(isContextEventType("DECISION_LOG_ENTRY")).toBe(false);
		expect(isContextEventType(undefined)).toBe(false);
	});
});

describe("buildContextActionMarker", () => {
	it("matches the backend contract", () => {
		const now = new Date("2026-10-14T10:00:00.000Z");
		expect(buildContextActionMarker("clear", now)).toEqual({
			action: "clear",
			phase: null,
			subtaskId: null,
			requestedAt: "2026-10-14T10:00:00.000Z",
		});
	});
});
