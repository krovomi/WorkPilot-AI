/**
 * The six steps Import Design shows, and the state of each one, derived from
 * the runner's phase. Pure functions, so the page and its tests agree.
 *
 * The backend runs: analysing → design tokens → specification → code →
 * visual tests → (Figma sync) → complete. The page adds a last step, the
 * project, which is the person's: the files are written only on their click.
 */

export const DESIGN_STEPS = [
	"vision",
	"tokens",
	"spec",
	"code",
	"tests",
	"project",
] as const;
export type DesignStep = (typeof DESIGN_STEPS)[number];

export type DesignStepState =
	| "pending"
	| "running"
	| "done"
	| "ready"
	| "off"
	| "unsupported"
	| "error";

/** The step each backend phase is working on. */
const PHASE_STEP: Record<string, DesignStep> = {
	analyzing: "vision",
	design_token_integration: "tokens",
	spec_generation: "spec",
	code_generation: "code",
	visual_test_generation: "tests",
	figma_sync: "project",
};

export interface StepInputs {
	phase: string;
	/** The step that was running when the run failed. */
	failedStep?: DesignStep | null;
	useDesignTokens: boolean;
	generateTests: boolean;
	testsSupported: boolean;
	written: boolean;
}

export function stepOfPhase(phase: string): DesignStep | null {
	return PHASE_STEP[phase] ?? null;
}

/** The state of every step for the current phase of the run. */
export function stepStates(input: StepInputs): Record<DesignStep, DesignStepState> {
	const states = {} as Record<DesignStep, DesignStepState>;
	const optionalState = (step: DesignStep): DesignStepState | null => {
		if (step === "tokens" && !input.useDesignTokens) return "off";
		if (step === "tests" && !input.generateTests) return "off";
		if (step === "tests" && !input.testsSupported) return "unsupported";
		return null;
	};

	if (input.phase === "complete") {
		for (const step of DESIGN_STEPS) {
			states[step] =
				optionalState(step) ??
				(step === "project" && !input.written ? "ready" : "done");
		}
		return states;
	}

	const current =
		input.phase === "error" ? (input.failedStep ?? null) : stepOfPhase(input.phase);
	const currentIndex = current ? DESIGN_STEPS.indexOf(current) : -1;
	DESIGN_STEPS.forEach((step, index) => {
		const optional = optionalState(step);
		if (optional) {
			states[step] = optional;
		} else if (currentIndex < 0) {
			states[step] = "pending";
		} else if (index < currentIndex) {
			states[step] = "done";
		} else if (index === currentIndex) {
			states[step] = input.phase === "error" ? "error" : "running";
		} else {
			states[step] = "pending";
		}
	});
	return states;
}

/** Default sentences written between two steps (index i joins step i and i+1). */
export const DEFAULT_NOTE_KEYS = [
	"notes.visionToTokens",
	"notes.tokensToSpec",
	"notes.specToCode",
	"notes.codeToTests",
	"notes.testsToProject",
] as const;
