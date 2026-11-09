/**
 * The API Watcher runner's arguments, built in main from what the renderer
 * sent (S6): the target branch is checked, never passed as an option (#389).
 */

import { describe, expect, it } from "vitest";

import { runnerArgs } from "../api-watcher-args";

describe("runnerArgs", () => {
	it("compares with the detected branch by default", () => {
		expect(runnerArgs({ projectPath: "/repo" })).toEqual(["--project-path", "/repo"]);
	});

	it("passes a target branch the person typed", () => {
		expect(runnerArgs({ projectPath: "/repo", target: " release/2.0 " })).toEqual([
			"--project-path",
			"/repo",
			"--target",
			"release/2.0",
		]);
	});

	it("refuses a target that reads as an option or climbs", () => {
		expect(() => runnerArgs({ projectPath: "/repo", target: "--upload-pack=x" })).toThrow();
		expect(() => runnerArgs({ projectPath: "/repo", target: "a..b" })).toThrow();
		expect(() => runnerArgs({ projectPath: "/repo", target: "a b" })).toThrow();
	});

	it("keeps the saved baseline mode", () => {
		expect(runnerArgs({ projectPath: "/repo", saveBaseline: true })).toEqual([
			"--project-path",
			"/repo",
			"--mode",
			"baseline",
			"--save-baseline",
		]);
		expect(runnerArgs({ projectPath: "/repo", mode: "baseline", target: "x" })).toEqual([
			"--project-path",
			"/repo",
			"--mode",
			"baseline",
		]);
	});
});
