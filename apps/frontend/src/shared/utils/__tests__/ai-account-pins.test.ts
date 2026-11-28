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
	pinnedLoginOf,
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

describe("pinKeysOf", () => {
	it("lists a provider's key pin, then its CLI sign-in pin", () => {
		expect(pinKeysOf("openai")).toEqual(["openai", "codex"]);
		expect(pinKeysOf("Copilot")).toEqual(["copilot"]);
		expect(pinKeysOf("gemini-cli")).toEqual(["gemini-cli"]);
		expect(pinKeysOf("gemini")).toEqual(["google"]);
		expect(pinKeysOf("ollama")).toEqual([]);
	});
});

describe("sanitizeAccountPins", () => {
	it("keeps the pins of the coding-agent CLIs' sign-ins", () => {
		expect(sanitizeAccountPins({ codex: "c", copilot: "g", "gemini-cli": "x" })).toEqual({
			codex: "c",
			copilot: "g",
			"gemini-cli": "x",
		});
	});

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

	it("lets a card's Codex sign-in replace the project's OpenAI key, and the reverse", () => {
		expect(mergeAccountPins({ codex: "plan" }, { openai: "key", copilot: "gh" })).toEqual({
			codex: "plan",
			copilot: "gh",
		});
		expect(mergeAccountPins({ openai: "key" }, { codex: "plan" })).toEqual({ openai: "key" });
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

describe("pinnedLoginOf", () => {
	it("reads OpenAI's Codex sign-in and a CLI's own", () => {
		expect(pinnedLoginOf({ codex: "c", openai: "o" }, "openai")).toBe("c");
		expect(pinnedLoginOf({ copilot: "g" }, "copilot")).toBe("g");
		expect(pinnedLoginOf({ google: "g" }, "google")).toBeUndefined();
		expect(pinnedLoginOf(undefined, "copilot")).toBeUndefined();
	});
});

describe("withAccountPin", () => {
	it("keeps OpenAI on its key or on its Codex sign-in, never both", () => {
		const key = withAccountPin({ codex: "plan", google: "g" }, "openai", "k");
		expect(key).toEqual({ google: "g", openai: "k" });
		expect(withAccountPin(key, "openai", "plan", "login")).toEqual({ google: "g", codex: "plan" });
		expect(withAccountPin({ openai: "k" }, "codex", "plan", "login")).toEqual({ codex: "plan" });
		expect(withAccountPin({ codex: "plan" }, "openai", null)).toBeUndefined();
	});

	it("pins a CLI provider's sign-in whatever the kind says", () => {
		expect(withAccountPin(undefined, "copilot", "gh")).toEqual({ copilot: "gh" });
		expect(withAccountPin({ google: "g" }, "google", "x", "login")).toBeUndefined();
	});

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
		expect(pinsForProviders({ codex: "c", copilot: "g" }, ["openai"])).toEqual({ codex: "c" });
		expect(pinsForProviders(undefined, ["openai"])).toBeUndefined();
	});
});

describe("siblingPinKeys", () => {
	it("names the other key of the same engine, none for a provider alone", () => {
		expect(siblingPinKeys("codex")).toEqual(["openai"]);
		expect(siblingPinKeys("openai")).toEqual(["codex"]);
		expect(siblingPinKeys("copilot")).toEqual([]);
		expect(siblingPinKeys("claude")).toEqual([]);
	});
});
