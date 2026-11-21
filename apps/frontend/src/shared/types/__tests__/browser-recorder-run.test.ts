/**
 * What the runner says of a test run and of a reshoot is read through bounds,
 * and step ids from the renderer are read again (#387).
 */
import { describe, expect, it } from "vitest";
import { parseReshoot, parseTestRun, readStepIds } from "../browser-recorder-run";

describe("parseTestRun", () => {
	it("keeps a run's result, bounded", () => {
		expect(
			parseTestRun({
				passed: false,
				exitCode: 2,
				durationMs: 1200,
				output: `${"x".repeat(5000)}end`,
				setup: "awaiting-approval",
				firstRun: true,
				firstRuns: 3,
				firstPassed: 9,
			}),
		).toEqual({
			passed: false,
			exitCode: 2,
			durationMs: 1200,
			output: `${"x".repeat(3997)}end`,
			setup: "awaiting-approval",
			firstRun: true,
			firstRuns: 3,
			firstPassed: 3,
		});
		expect(parseTestRun({ passed: true, exitCode: null, setup: "<b>", durationMs: -1, output: 3 })).toEqual({
			passed: true,
			exitCode: null,
			durationMs: 0,
			output: "",
			setup: "",
			firstRun: false,
			firstRuns: 0,
			firstPassed: 0,
		});
		for (const raw of [null, "x", { passed: "yes" }]) expect(parseTestRun(raw)).toBeNull();
	});
});

describe("parseReshoot", () => {
	it("keeps each step's status, and new selectors only for a changed one", () => {
		const css = [{ strategy: "css", value: "#a" }];
		expect(
			parseReshoot({
				steps: [
					{ id: "s1", status: "ok", selectors: css },
					{ id: "s2", status: "changed", selectors: css },
					{ id: "s3", status: "changed", selectors: [{ strategy: "xpath", value: "//a" }] },
					{ id: "s4", status: "evil" },
					{ id: "../x", status: "ok" },
					null,
					{ id: "s5", status: "not-reached" },
				],
			}),
		).toEqual([
			{ id: "s1", status: "ok" },
			{ id: "s2", status: "changed", selectors: [{ strategy: "css", value: "#a" }] },
			{ id: "s5", status: "not-reached" },
		]);
		for (const raw of [null, {}, { steps: "x" }]) expect(parseReshoot(raw)).toEqual([]);
	});

	it("reads step ids once each", () => {
		expect(readStepIds(["s1", "s1", "x", 3, "s2"])).toEqual(["s1", "s2"]);
		expect(readStepIds("s1")).toBeNull();
	});
});
