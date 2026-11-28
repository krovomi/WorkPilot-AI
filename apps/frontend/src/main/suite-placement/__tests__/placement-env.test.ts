import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { suitePlacementEnv } from "../build-env";
import { ciRouteAvailable, resetCiRoutes, setCiFollowed, suspendCiRoute } from "../ci-route";
import { PLACEMENT_FILE, parseSuitePlacement, readSuitePlacement } from "../placement-file";

afterEach(() => resetCiRoutes());

describe("suitePlacementEnv", () => {
	it("sends the project's mode and nothing off the machine without a CI", () => {
		expect(suitePlacementEnv(undefined, false)).toEqual({});
		expect(suitePlacementEnv({ testPlacement: "machine" }, false)).toEqual({ TEST_PLACEMENT: "machine" });
		expect(suitePlacementEnv({ testPlacement: "cloud" as never }, false)).toEqual({});
	});

	it("with a CI the app follows, offers it and the branch push unless turned off", () => {
		expect(suitePlacementEnv({}, true)).toEqual({
			WORKPILOT_TEST_PLACEMENT_ROUTES: "ci",
			TEST_PLACEMENT_ALLOW_BRANCH_PUSH: "true",
		});
		expect(suitePlacementEnv({ testPlacementBranchPush: false }, true)).toEqual({
			WORKPILOT_TEST_PLACEMENT_ROUTES: "ci",
		});
	});
});

describe("ci-route", () => {
	it("is available only for a followed project, and not for a day after a suite that never started", () => {
		expect(ciRouteAvailable("p")).toBe(false);
		setCiFollowed("p", true);
		expect(ciRouteAvailable("p")).toBe(true);
		suspendCiRoute("p", 1000);
		expect(ciRouteAvailable("p", 1000 + 60_000)).toBe(false);
		expect(ciRouteAvailable("p", 1000 + 24 * 60 * 60_000)).toBe(true);
		expect(ciRouteAvailable("p", 1000 + 60_000)).toBe(true);
		setCiFollowed("p", false);
		expect(ciRouteAvailable("p")).toBe(false);
	});
});

describe("placement-file", () => {
	const decision = {
		target: "ci",
		reason: "branch_push",
		mode: "auto",
		short: ["cpu", "ram"],
		decidedBy: "default",
		waitedSeconds: 0,
		at: 1_763_800_000,
		facts: { cores: 8, cpuBusy: 92.5 },
	};

	it("reads what the build writes", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "placement-"));
		expect(readSuitePlacement(dir)).toBeNull();
		writeFileSync(path.join(dir, PLACEMENT_FILE), JSON.stringify(decision), "utf-8");
		expect(readSuitePlacement(dir)?.target).toBe("ci");
		writeFileSync(path.join(dir, PLACEMENT_FILE), "{not json", "utf-8");
		expect(readSuitePlacement(dir)).toBeNull();
	});

	it("refuses anything outside its lists and bounds", () => {
		expect(parseSuitePlacement({ ...decision, target: "anywhere" })).toBeNull();
		expect(parseSuitePlacement({ ...decision, reason: "because" })).toBeNull();
		expect(parseSuitePlacement({ ...decision, short: ["disk"] })).toBeNull();
		expect(parseSuitePlacement({ ...decision, facts: { cores: "8" } })).toBeNull();
		const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
		expect(parseSuitePlacement({ ...decision, facts: many })).toBeNull();
		expect(parseSuitePlacement({ target: "machine", reason: "alone", mode: "auto" })?.short).toEqual([]);
	});
});
