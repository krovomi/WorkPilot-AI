/**
 * The studio's pipeline cards are derived from the store's live stages. These
 * pin what each card shows for a run that has not started, one in flight, one
 * that finished and one that failed — so the graph never claims a step ran
 * when another mode's run is the one in the store.
 */

import { describe, expect, it } from "vitest";
import type { LiveStage } from "../../stores/test-generation-store";
import {
	countAssertions,
	inspectorTabForStep,
	liveWires,
	STUDIO_MODES,
	STUDIO_STEPS,
	studioStepStates,
} from "../test-studio-steps";

describe("STUDIO_STEPS", () => {
	it("draws four steps for every mode", () => {
		for (const mode of STUDIO_MODES) {
			expect(STUDIO_STEPS[mode]).toHaveLength(4);
		}
	});
});

describe("studioStepStates", () => {
	it("leaves every step pending while another mode's run is in the store", () => {
		const states = studioStepStates({
			mode: "unit",
			runKind: "analyze",
			phase: "complete",
			liveStages: [{ id: "detect", status: "done" }],
		});
		expect(Object.values(states)).toEqual(["pending", "pending", "pending", "pending"]);
	});

	it("marks the person's own input done and follows the live stages", () => {
		const liveStages: LiveStage[] = [
			{ id: "detect", status: "done" },
			{ id: "generate", status: "active" },
		];
		const states = studioStepStates({
			mode: "e2e",
			runKind: "e2e",
			phase: "generating",
			liveStages,
		});
		expect(states).toMatchObject({
			scenario: "done",
			detect: "done",
			generate: "running",
			write: "pending",
		});
	});

	it("finishes the gaps step only when the analysis completes", () => {
		const running = studioStepStates({
			mode: "analyze",
			runKind: "analyze",
			phase: "analyzing",
			liveStages: [{ id: "analyze", status: "active" }],
		});
		expect(running.gaps).toBe("pending");

		const done = studioStepStates({
			mode: "analyze",
			runKind: "analyze",
			phase: "complete",
			liveStages: [],
		});
		expect(Object.values(done)).toEqual(["done", "done", "done", "done"]);
	});

	it("blames the stage that failed and skips the ones after it", () => {
		const states = studioStepStates({
			mode: "unit",
			runKind: "unit",
			phase: "error",
			liveStages: [
				{ id: "detect", status: "done" },
				{ id: "read", status: "done" },
				{ id: "generate", status: "failed" },
			],
		});
		expect(states).toMatchObject({
			detect: "done",
			read: "done",
			generate: "error",
			write: "skipped",
		});
	});

	it("shows a failure with no stage on the first real step", () => {
		const states = studioStepStates({
			mode: "tdd",
			runKind: "tdd",
			phase: "error",
			liveStages: [],
		});
		expect(states).toMatchObject({
			spec: "done",
			detect: "error",
			generate: "skipped",
			write: "skipped",
		});
	});
});

describe("liveWires", () => {
	it("lights a wire once its source is done and its target has started", () => {
		const states = studioStepStates({
			mode: "unit",
			runKind: "unit",
			phase: "generating",
			liveStages: [
				{ id: "detect", status: "done" },
				{ id: "read", status: "active" },
			],
		});
		expect(liveWires("unit", states)).toEqual([true, false, false]);
	});
});

describe("inspectorTabForStep", () => {
	it("opens the tab that holds each step's part of the result", () => {
		expect(inspectorTabForStep("detect")).toBe("stack");
		expect(inspectorTabForStep("spec")).toBe("stack");
		expect(inspectorTabForStep("gaps")).toBe("gaps");
		expect(inspectorTabForStep("write")).toBe("code");
	});
});

describe("countAssertions", () => {
	it("counts assertions across frameworks", () => {
		expect(countAssertions("")).toBe(0);
		expect(countAssertions("expect(a).toBe(1);")).toBe(2);
		expect(countAssertions("Assert.Equal(1, x);\nresult.Should().Be(2);")).toBe(2);
		expect(countAssertions("XCTAssertEqual(a, b)")).toBe(1);
	});
});
