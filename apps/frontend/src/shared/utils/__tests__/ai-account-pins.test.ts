/**
 * The AI account a project or a card pins per provider (ai-account-pins.ts):
 * only providers with accounts and well-formed ids survive a file the
 * renderer wrote, a card's pin wins over its project's, aliases share one key.
 */

import { describe, expect, it } from "vitest";
import {
	mergeAccountPins,
	pinKeysOf,
	pinnedAccountOf,
	pinnedLoginAccountOf,
	pinProviderOf,
	pinsForProviders,
	sanitizeAccountPins,
	siblingPinKeys,
	withAccountPin,
} from "../ai-account-pins";

describe("pinProviderOf", () => {
	it("names Claude claude, an alias by its account provider, and nothing else", () => {
		expect(pinProviderOf("anthropic")).toBe("claude");
		expect(pinProviderOf("Claude")).toBe("claude");
		expect(pinProviderOf("gemini")).toBe("google");
		expect(pinProviderOf("openrouter")).toBe("openrouter");
		expect(pinProviderOf("ollama")).toBeUndefined();
		expect(pinProviderOf(undefined)).toBeUndefined();
	});
});

describe("sanitizeAccountPins", () => {
	it("keeps the pins of providers with accounts, keyed by that provider", () => {
		expect(
			sanitizeAccountPins({ gemini: "a-1", anthropic: "work", mistral: "m-2" }),
		).toEqual({ google: "a-1", claude: "work", mistral: "m-2" });
	});

	it("drops unknown providers and ids that are not short printable strings", () => {
		expect(
			sanitizeAccountPins({
				ollama: "x",
				openai: 42,
				mistral: "",
				deepseek: "has space",
				grok: "x".repeat(129),
				meta: "line\nbreak",
				__proto__: "p",
			}),
		).toBeUndefined();
	});

	it("refuses what is not an object", () => {
		expect(sanitizeAccountPins(null)).toBeUndefined();
		expect(sanitizeAccountPins("openai")).toBeUndefined();
		expect(sanitizeAccountPins(["openai"])).toBeUndefined();
	});
});

describe("mergeAccountPins", () => {
	it("takes the project's pins and replaces each with the card's own", () => {
		expect(
			mergeAccountPins({ openai: "card" }, { openai: "project", claude: "team" }),
		).toEqual({ openai: "card", claude: "team" });
	});

	it("is undefined when neither pins anything", () => {
		expect(mergeAccountPins(undefined, { ollama: "x" })).toBeUndefined();
	});
});

describe("pinnedAccountOf", () => {
	it("reads the pin of a provider through its alias", () => {
		expect(pinnedAccountOf({ google: "g" }, "gemini")).toBe("g");
		expect(pinnedAccountOf({ claude: "work" }, "anthropic")).toBe("work");
		expect(pinnedAccountOf({ google: "g" }, "ollama")).toBeUndefined();
		expect(pinnedAccountOf(undefined, "openai")).toBeUndefined();
	});
});

describe("withAccountPin", () => {
	it("sets, replaces and removes one pin, and is undefined once none is left", () => {
		const one = withAccountPin(undefined, "gemini", "g");
		expect(one).toEqual({ google: "g" });
		expect(withAccountPin(one, "anthropic", "work")).toEqual({ google: "g", claude: "work" });
		expect(withAccountPin(one, "google", null)).toBeUndefined();
	});

	it("leaves the pins alone for a provider without accounts", () => {
		const pins = { openai: "o" };
		expect(withAccountPin(pins, "ollama", "x")).toBe(pins);
	});
});

describe("pinsForProviders", () => {
	it("keeps only the pins of the providers the card uses", () => {
		expect(
			pinsForProviders({ openai: "o", claude: "c", google: "g" }, ["anthropic", "gemini", "ollama"]),
		).toEqual({ claude: "c", google: "g" });
		expect(pinsForProviders({ openai: "o" }, ["mistral"])).toBeUndefined();
		expect(pinsForProviders(undefined, ["openai"])).toBeUndefined();
	});
});

describe("CLI sign-in pins", () => {
	it("survive sanitizing under their CLI's own key", () => {
		expect(sanitizeAccountPins({ codex: "c1", copilot: "g1", "gemini-cli": "x1", cursor: "no" })).toEqual({
			codex: "c1",
			copilot: "g1",
			"gemini-cli": "x1",
		});
	});

	it("are read for the provider a card runs, after its API-key pin", () => {
		expect(pinKeysOf("openai")).toEqual(["openai", "codex"]);
		expect(pinKeysOf("copilot")).toEqual(["copilot"]);
		expect(pinKeysOf("anthropic")).toEqual(["claude"]);
		expect(pinKeysOf("ollama")).toEqual([]);
		expect(pinnedLoginAccountOf({ codex: "c1" }, "openai")).toBe("c1");
		expect(pinnedLoginAccountOf({ codex: "c1" }, "mistral")).toBeUndefined();
		expect(pinnedLoginAccountOf(undefined, "copilot")).toBeUndefined();
		expect(pinsForProviders({ codex: "c1", copilot: "g1" }, ["openai"])).toEqual({ codex: "c1" });
	});

	it("replace the project's pin of the same engine under the other key", () => {
		expect(siblingPinKeys("codex")).toEqual(["openai"]);
		expect(siblingPinKeys("openai")).toEqual(["codex"]);
		expect(siblingPinKeys("copilot")).toEqual([]);
		expect(mergeAccountPins({ codex: "c1" }, { openai: "o1", google: "g" })).toEqual({ codex: "c1", google: "g" });
		expect(mergeAccountPins({ openai: "o2" }, { codex: "c1" })).toEqual({ openai: "o2" });
	});
});
