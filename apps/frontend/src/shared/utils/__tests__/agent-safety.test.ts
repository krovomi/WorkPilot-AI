/** The agent safety settings are bounded here as the backend bounds them. */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_AGENT_SAFETY,
	MAX_ALLOWED_PATHS,
	normalizeAgentSafety,
	normalizeAllowedPath,
	SNAPSHOT_ID,
} from "../agent-safety";

describe("normalizeAllowedPath", () => {
	it("keeps a project-relative path", () => {
		expect(normalizeAllowedPath(" src\\app/./x/ ")).toBe("src/app/x");
		expect(normalizeAllowedPath("docs")).toBe("docs");
	});

	it("refuses what could leave the project", () => {
		for (const entry of ["/etc", "C:/Windows", "c:x", "a/../b", "..", ".", "", "   ", "a\0b", 3, null]) {
			expect(normalizeAllowedPath(entry)).toBeNull();
		}
		expect(normalizeAllowedPath("a".repeat(401))).toBeNull();
	});
});

describe("normalizeAgentSafety", () => {
	it("gives the defaults for nothing", () => {
		expect(normalizeAgentSafety(undefined)).toEqual(DEFAULT_AGENT_SAFETY);
		expect(normalizeAgentSafety({ snapshots: [], sandbox: "x", anomaly: null })).toEqual(
			DEFAULT_AGENT_SAFETY,
		);
	});

	it("bounds every number and keeps stop at or below pause", () => {
		const safety = normalizeAgentSafety({
			snapshots: { enabled: false, keep: 999, autoRollback: "yes" },
			sandbox: {
				mode: "restricted",
				maxFilesWritten: -5,
				maxFileSizeMb: 2.5,
				maxSessionMinutes: Number.NaN,
			},
			anomaly: { pauseBelow: 30.7, stopBelow: 90, massDeletionCount: 0, rapidChangeWindowS: 1e9 },
		});
		expect(safety.snapshots).toEqual({ enabled: false, keep: 50, autoRollback: true });
		expect(safety.sandbox).toMatchObject({
			mode: "restricted",
			maxFilesWritten: 0,
			maxFileSizeMb: 2.5,
			maxSessionMinutes: 0,
		});
		expect(safety.anomaly).toMatchObject({
			pauseBelow: 30,
			stopBelow: 30,
			massDeletionCount: 1,
			rapidChangeWindowS: 3600,
		});
		expect(normalizeAgentSafety({ sandbox: { mode: "docker" } }).sandbox.mode).toBe("normal");
	});

	it("dedupes and caps the allowed paths", () => {
		const many = Array.from({ length: MAX_ALLOWED_PATHS + 10 }, (_, i) => `dir${i}`);
		const safety = normalizeAgentSafety({ sandbox: { allowedPaths: ["src", "src/", "/etc", ...many] } });
		expect(safety.sandbox.allowedPaths[0]).toBe("src");
		expect(safety.sandbox.allowedPaths).not.toContain("/etc");
		expect(safety.sandbox.allowedPaths).toHaveLength(MAX_ALLOWED_PATHS);
	});
});

describe("SNAPSHOT_ID", () => {
	it("matches the backend's names only", () => {
		expect(SNAPSHOT_ID.test("20261115T142000123456Z-before_rollback")).toBe(true);
		expect(SNAPSHOT_ID.test("20261115T142000123456Z-../x")).toBe(false);
		expect(SNAPSHOT_ID.test("HEAD")).toBe(false);
	});
});
