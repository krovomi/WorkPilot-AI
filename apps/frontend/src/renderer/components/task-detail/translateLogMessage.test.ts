import { describe, expect, it } from "vitest";
import { translateLogMessage } from "./translateLogMessage";

// Fake t: echoes the key + a compact JSON of params, so assertions can check
// both the chosen key and the interpolated values without loading real locales.
const fakeT = ((key: string, params?: Record<string, unknown>) =>
	params && Object.keys(params).length
		? `${key} ${JSON.stringify(params)}`
		: key) as unknown as Parameters<typeof translateLogMessage>[0];

describe("translateLogMessage", () => {
	it("returns empty/unchanged for falsy or unknown content", () => {
		expect(translateLogMessage(fakeT, "")).toBe("");
		expect(translateLogMessage(fakeT, null)).toBe("");
		expect(translateLogMessage(fakeT, "Reading spec.md")).toBe("Reading spec.md");
		// Raw agent output must never be rewritten.
		const raw = "I'll now implement the KeyDown handler.";
		expect(translateLogMessage(fakeT, raw)).toBe(raw);
	});

	it("maps QA verdicts to keys with pass numbers/counts", () => {
		expect(
			translateLogMessage(
				fakeT,
				"QA pass #1 rejected by the coverage gate; applying a fix, then re-reviewing (pass #2).",
			),
		).toBe('tasks:execution.logMessages.qaCoverageRejected {"n":1,"next":2}');

		expect(
			translateLogMessage(
				fakeT,
				"QA pass #2 rejected: 3 architecture violation(s); applying a fix, then re-reviewing (pass #3).",
			),
		).toBe(
			'tasks:execution.logMessages.qaArchRejected {"n":2,"count":3,"next":3}',
		);

		expect(
			translateLogMessage(
				fakeT,
				"QA pass #1 rejected: 2 issue(s) found; applying a fix, then re-reviewing (pass #2).",
			),
		).toBe('tasks:execution.logMessages.qaRejected {"n":1,"count":2,"next":2}');

		expect(
			translateLogMessage(
				fakeT,
				"QA pass #2 approved: all criteria met, architecture clean. Validation complete.",
			),
		).toBe('tasks:execution.logMessages.qaApproved {"n":2}');
	});

	it("distinguishes plain vs sandbox manual-verification", () => {
		expect(
			translateLogMessage(
				fakeT,
				"QA pass #2: code validated by review; manual verification required. Validation complete.",
			),
		).toBe('tasks:execution.logMessages.qaManualVerification {"n":2}');

		expect(
			translateLogMessage(
				fakeT,
				"QA pass #2: code validated by review; manual verification required (environment limitation: tests can't run here). Validation complete.",
			),
		).toBe('tasks:execution.logMessages.qaManualVerificationSandbox {"n":2}');
	});

	it("maps model-unavailable and hot-swap resume", () => {
		expect(
			translateLogMessage(
				fakeT,
				"Unavailable model: claude-haiku-4-6. Phase halted — pick a valid model for this phase and re-run it.",
			),
		).toBe(
			'tasks:execution.logMessages.modelUnavailable {"model":"claude-haiku-4-6"}',
		);
		expect(
			translateLogMessage(
				fakeT,
				"Hot LLM swap — resuming with the new model (context replayed).",
			),
		).toBe("tasks:execution.logMessages.hotSwapResumed");
	});

	it("token-translates composite hot-swap / context-switch lines, keeping values", () => {
		expect(
			translateLogMessage(
				fakeT,
				"🔄 Hot swap (qa) — Provider → anthropic · Model → claude-sonnet-4-5 · Effort → low",
			),
		).toBe(
			"🔄 tasks:execution.logMessages.hotSwapLabel (qa) — tasks:execution.logMessages.provider → anthropic · tasks:execution.logMessages.model → claude-sonnet-4-5 · tasks:execution.logMessages.effort → low",
		);

		expect(
			translateLogMessage(
				fakeT,
				"🔄 LLM context switch — Model: claude-haiku-4-5 → claude-sonnet-4-5",
			),
		).toBe(
			"🔄 tasks:execution.logMessages.ctxSwitchLabel — tasks:execution.logMessages.model: claude-haiku-4-5 → claude-sonnet-4-5",
		);
	});
});
