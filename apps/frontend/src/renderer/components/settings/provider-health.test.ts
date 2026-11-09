import { describe, expect, it } from "vitest";
import { providerIsWorking } from "./provider-health";

describe("providerIsWorking", () => {
	it("is neither working nor failing when not configured", () => {
		// Counted as an error before: « 15 provider(s) with errors » on a fresh install.
		expect(providerIsWorking(false, true)).toBeUndefined();
		expect(providerIsWorking(undefined, false)).toBeUndefined();
	});

	it("follows the switch once configured", () => {
		expect(providerIsWorking(true, true)).toBe(true);
		expect(providerIsWorking(true, false)).toBe(false);
	});
});
