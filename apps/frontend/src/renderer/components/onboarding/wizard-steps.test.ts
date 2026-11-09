import { describe, expect, it } from "vitest";
import en from "../../../shared/i18n/locales/en/onboarding.json";
import fr from "../../../shared/i18n/locales/fr/onboarding.json";
import { WIZARD_STEPS } from "./wizard-steps";

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
