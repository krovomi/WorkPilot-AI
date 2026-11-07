import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../services/providerRegistry";
import enSettings from "../locales/en/settings.json";
import frSettings from "../locales/fr/settings.json";

/**
 * The Accounts cards show `sections.accounts.providers.<name>` as each
 * provider's description. A provider without that key showed the raw key
 * (OpenCode, pi, Gemini CLI, Antigravity did).
 */
describe("provider card descriptions", () => {
	const names = providerRegistry
		.getAllProviders()
		.map((p) => p.name)
		.filter((name) => name !== "claude" && name !== "custom");

	it.each([
		["en", enSettings],
		["fr", frSettings],
	])("every listed provider has a description in %s", (_lang, settings) => {
		const descriptions = settings.sections.accounts.providers as Record<
			string,
			string
		>;
		const missing = names.filter((name) => !descriptions[name]);
		expect(missing).toEqual([]);
	});
});
