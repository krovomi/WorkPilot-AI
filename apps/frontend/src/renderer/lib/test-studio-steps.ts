import type {
	LiveStage,
	TestGenerationPhase,
	TestRunKind,
} from "../stores/test-generation-store";

/**
 * The test studio's pipeline: four steps per mode, drawn as cards on wires.
 *
 * Pure: the state of each card is derived from the store's live stages, so the
 * graph and its tests agree on what "running", "done" and "failed" mean.
 * `scenario` and `spec` are the person's own input (an E2E user story, a TDD
 * description): they are done the moment a run starts. `gaps` is the ranked
 * answer of an analysis, done when the analysis is.
 */
export type StudioMode = TestRunKind;

export type StudioStep =
	| "scenario"
	| "spec"
	| "detect"
	| "read"
	| "analyze"
	| "gaps"
	| "generate"
	| "write";

export type StudioStepState = "pending" | "running" | "done" | "error" | "skipped";

export const STUDIO_MODES: readonly StudioMode[] = ["analyze", "unit", "e2e", "tdd"];

export const STUDIO_STEPS: Record<StudioMode, readonly StudioStep[]> = {
	analyze: ["detect", "read", "analyze", "gaps"],
	unit: ["detect", "read", "generate", "write"],
	e2e: ["scenario", "detect", "generate", "write"],
	tdd: ["spec", "detect", "generate", "write"],
};

const INPUT_STEPS = new Set<StudioStep>(["scenario", "spec"]);

export interface StepStateInput {
	mode: StudioMode;
	runKind: TestRunKind | null;
	phase: TestGenerationPhase;
	liveStages: readonly LiveStage[];
}

/** The state of every step of `mode`, for the run the store holds. */
export function studioStepStates(
	input: StepStateInput,
): Record<StudioStep, StudioStepState> {
	const steps = STUDIO_STEPS[input.mode];
	const states = Object.fromEntries(
		steps.map((step) => [step, "pending" as StudioStepState]),
	) as Record<StudioStep, StudioStepState>;

	// Another mode's run, or none yet: this pipeline has not started.
	if (input.runKind !== input.mode || input.phase === "idle") return states;

	const finished = input.phase === "complete";
	const failed = input.phase === "error";
	let sawFailure = false;

	for (const step of steps) {
		if (INPUT_STEPS.has(step)) {
			states[step] = "done";
			continue;
		}
		if (step === "gaps") {
			states[step] = finished ? "done" : failed ? "skipped" : "pending";
			continue;
		}
		const live = input.liveStages.find((stage) => stage.id === step);
		if (finished) {
			states[step] = "done";
		} else if (live?.status === "failed") {
			states[step] = "error";
			sawFailure = true;
		} else if (live?.status === "done") {
			states[step] = "done";
		} else if (live?.status === "active") {
			states[step] = failed ? "error" : "running";
			if (failed) sawFailure = true;
		} else {
			states[step] = failed ? "skipped" : "pending";
		}
	}

	// A run that died before naming any stage (an invalid input, a backend
	// that never started) still has to show where: on its first real step.
	if (failed && !sawFailure) {
		const first = steps.find((step) => !INPUT_STEPS.has(step));
		if (first) states[first] = "error";
	}
	return states;
}

/** Whether the wire from `steps[i]` to `steps[i + 1]` carries the flow. */
export function liveWires(
	mode: StudioMode,
	states: Record<StudioStep, StudioStepState>,
): boolean[] {
	const steps = STUDIO_STEPS[mode];
	return steps.slice(0, -1).map((step, i) => {
		const next = steps[i + 1];
		return (
			states[step] === "done" &&
			(states[next] === "running" || states[next] === "done")
		);
	});
}

/** Which inspector tab a step opens when its card is clicked. */
export type InspectorTab = "code" | "tests" | "gaps" | "stack";

export function inspectorTabForStep(step: StudioStep): InspectorTab {
	switch (step) {
		case "detect":
		case "read":
		case "scenario":
		case "spec":
			return "stack";
		case "analyze":
		case "gaps":
			return "gaps";
		default:
			return "code";
	}
}

/** Count assertion-like calls in a test body, for the per-test summary chip. */
export function countAssertions(code: string): number {
	if (!code) return 0;
	const matches = code.match(
		/\b(assert\w*|expect|Assert|should|verify|Verify|XCTAssert\w*)\b|\.toBe|\.toEqual|\.Should\(/g,
	);
	return matches ? matches.length : 0;
}
