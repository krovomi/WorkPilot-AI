/**
 * A failed generation has to be *legible*, not merely detected.
 *
 * These pin the two halves of that: the failure the runner describes reaches
 * the store intact (code, stage, redacted technical text), and the stepper
 * blames the step that actually broke rather than whichever one happened to be
 * in flight.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-store", () => ({
	useProjectStore: {
		getState: () => ({ getActiveProject: () => ({ path: "/proj" }) }),
	},
}));

import { useTestGenerationStore } from "../test-generation-store";

const initial = useTestGenerationStore.getState();

beforeEach(() => {
	useTestGenerationStore.setState(initial, true);
});

/** Walk the pipeline up to (but not through) the given stage. */
function enterStages(...stages: Array<"detect" | "read" | "generate" | "write">) {
	const { applyStageEvent } = useTestGenerationStore.getState();
	for (const stage of stages) {
		applyStageEvent({ type: "stage", stage });
	}
}

describe("structured failures", () => {
	it("keeps the code, stage and technical details the runner reported", () => {
		useTestGenerationStore.getState().setError({
			message: "The AI provider rejected the request.",
			code: "auth",
			stage: "generate",
			details: "RuntimeError: HTTP 401",
			provider: "claude",
			model: "claude-haiku-4-5",
		});

		const { error, errorDetail } = useTestGenerationStore.getState();
		expect(error).toBe("The AI provider rejected the request.");
		expect(errorDetail).toMatchObject({
			code: "auth",
			stage: "generate",
			details: "RuntimeError: HTTP 401",
			provider: "claude",
			model: "claude-haiku-4-5",
		});
	});

	it("accepts a bare string from an older main process", () => {
		useTestGenerationStore.getState().setError("something broke");

		expect(useTestGenerationStore.getState().errorDetail).toMatchObject({
			message: "something broke",
			code: "unknown",
		});
	});

	it("falls back to a known code rather than inventing one", () => {
		useTestGenerationStore.getState().setError({
			message: "nope",
			// A code from a newer backend the UI has no copy for.
			code: "meteor_strike",
		} as never);

		expect(useTestGenerationStore.getState().errorDetail?.code).toBe("unknown");
	});
});

describe("the failed stage", () => {
	it("blames the stage the runner named, not the one still active", () => {
		// "write" fails after "generate" already completed, which is exactly the
		// case the old "whichever stage is active" guess got wrong.
		enterStages("detect", "read", "generate");
		useTestGenerationStore
			.getState()
			.applyStageEvent({ type: "stage", stage: "generate", status: "done" });
		enterStages("write");

		useTestGenerationStore.getState().setPhase("error");
		useTestGenerationStore.getState().applyStageEvent({
			type: "stage",
			stage: "write",
			status: "failed",
		});

		const stages = useTestGenerationStore.getState().liveStages;
		expect(stages.find((s) => s.id === "generate")?.status).toBe("done");
		expect(stages.find((s) => s.id === "write")?.status).toBe("failed");
	});

	it("falls back to the in-flight stage when the failure names none", () => {
		enterStages("detect", "read", "generate");

		const handler = useTestGenerationStore
			.getState()
			.createErrorHandler(
				() => undefined,
				() => undefined,
			);
		handler({ message: "boom", code: "unknown" });

		const stages = useTestGenerationStore.getState().liveStages;
		expect(stages.find((s) => s.id === "generate")?.status).toBe("failed");
		expect(useTestGenerationStore.getState().phase).toBe("error");
	});

	it("freezes the elapsed clock at the moment of failure", () => {
		useTestGenerationStore.getState().resetLive();
		const handler = useTestGenerationStore
			.getState()
			.createErrorHandler(
				() => undefined,
				() => undefined,
			);
		handler({ message: "boom", code: "network" });

		expect(useTestGenerationStore.getState().genEndedAt).toBeTypeOf("number");
	});
});

describe("stage detail", () => {
	it("carries the line count structurally, not only as a pre-rendered string", () => {
		useTestGenerationStore.getState().applyStageEvent({
			type: "stage",
			stage: "read",
			status: "done",
			lines: 105,
			detail: "105 lines",
		});

		// The number is what the UI localises; the string is only the fallback.
		expect(
			useTestGenerationStore.getState().liveStages.find((s) => s.id === "read")
				?.lines,
		).toBe(105);
	});
});

describe("retry", () => {
	it("does nothing when no run has been launched", () => {
		expect(() => useTestGenerationStore.getState().retryLastRun()).not.toThrow();
	});

	it("replays the last run and clears the previous failure", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		useTestGenerationStore.setState({
			lastRun: run,
			error: "old",
			errorDetail: { message: "old", code: "auth" },
		});

		useTestGenerationStore.getState().retryLastRun();

		expect(run).toHaveBeenCalledTimes(1);
		expect(useTestGenerationStore.getState().errorDetail).toBeNull();
	});

	it("swallows a rejected retry — the store already renders the failure", async () => {
		useTestGenerationStore.setState({
			lastRun: vi.fn().mockRejectedValue(new Error("still broken")),
		});

		expect(() => useTestGenerationStore.getState().retryLastRun()).not.toThrow();
		await Promise.resolve();
	});
});
