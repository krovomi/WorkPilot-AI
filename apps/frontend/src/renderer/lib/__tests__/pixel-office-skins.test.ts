import { describe, expect, it } from "vitest";
import { DECOR_IDS } from "../pixel-office-seasons";
import {
	agentShirt,
	NEON_SHIRT,
	savedHiddenDecor,
	savedSkin,
	shownDecor,
	skinUnlocked,
	wornSkin,
} from "../pixel-office-skins";

describe("pixel office skins", () => {
	it("unlocks neon only once every piece of decor is earned", () => {
		expect(skinUnlocked("provider", [])).toBe(true);
		expect(skinUnlocked("classic", [])).toBe(true);
		expect(skinUnlocked("neon", DECOR_IDS.slice(1))).toBe(false);
		expect(skinUnlocked("neon", [...DECOR_IDS])).toBe(true);
		expect(wornSkin("neon", ["plants"])).toBe("provider");
		expect(wornSkin("neon", [...DECOR_IDS])).toBe("neon");
		expect(wornSkin("classic", [])).toBe("classic");
	});

	it("dresses a character by its skin", () => {
		expect(agentShirt("openai", "provider")).toBe("#10A37F");
		expect(agentShirt(undefined, "provider")).toBeUndefined();
		expect(agentShirt("openai", "classic")).toBeUndefined();
		expect(agentShirt(undefined, "neon")).toBe(NEON_SHIRT);
	});

	it("shows the earned decor the person did not hide", () => {
		expect(shownDecor(["plants", "arcade"], ["arcade"])).toEqual(["plants"]);
		expect(shownDecor([], ["arcade"])).toEqual([]);
	});

	it("reads saved choices back from closed lists", () => {
		expect(savedSkin("classic")).toBe("classic");
		expect(savedSkin("gold")).toBe("provider");
		expect(savedSkin(undefined)).toBe("provider");
		expect(savedHiddenDecor(["arcade", "plants", "x"])).toEqual(["plants", "arcade"]);
		expect(savedHiddenDecor("plants")).toEqual([]);
	});
});
