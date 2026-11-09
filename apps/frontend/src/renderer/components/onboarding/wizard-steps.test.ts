import { describe, expect, it } from "vitest";
import en from "../../../shared/i18n/locales/en/onboarding.json";
import fr from "../../../shared/i18n/locales/fr/onboarding.json";
import { WIZARD_STEPS, neighbourStep, stepsForPath } from "./wizard-steps";

function lookup(pack: unknown, key: string): unknown {
	return key
		.split(".")
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === "object"
					? (node as Record<string, unknown>)[part]
					: undefined,
			pack,
		);
}

describe("setup wizard step labels", () => {
	it.each([
		["en", en],
		["fr", fr],
	])("every step label exists in %s", (_lang, pack) => {
		// A missing key is printed raw in the progress bar ("steps.claudeCode").
		const missing = WIZARD_STEPS.filter(
			(step) => typeof lookup(pack, step.labelKey) !== "string",
		).map((step) => step.labelKey);
		expect(missing).toEqual([]);
	});
});

describe("setup wizard paths", () => {
	const ids = (path: Parameters<typeof stepsForPath>[0]) =>
		stepsForPath(path).map((step) => step.id);

	it("walks the Claude sign-in and CLI steps on the Claude path", () => {
		expect(ids("claude")).toEqual([
			"welcome",
			"auth-choice",
			"oauth",
			"claude-code",
			"devtools",
			"privacy",
			"completion",
		]);
	});

	it("configures any other provider without the Claude steps", () => {
		expect(ids("other")).toEqual([
			"welcome",
			"auth-choice",
			"providers",
			"devtools",
			"privacy",
			"completion",
		]);
	});

	it("keeps the dev tools and privacy steps after an API key", () => {
		// The API-key path used to jump straight to the last screen.
		expect(neighbourStep("api-key", "auth-choice", 1)).toBe("devtools");
		expect(neighbourStep("api-key", "devtools", -1)).toBe("auth-choice");
	});

	it("skips the sign-in but still offers the CLI when skipped", () => {
		expect(neighbourStep("skipped", "auth-choice", 1)).toBe("claude-code");
	});

	it("stays put at either end", () => {
		expect(neighbourStep("claude", "welcome", -1)).toBe("welcome");
		expect(neighbourStep("claude", "completion", 1)).toBe("completion");
	});
});
