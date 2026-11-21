/**
 * The device matrix throttling profiles (#383): a closed list, named in both
 * languages, found by id only, with a bounded load time.
 */
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/appEmulator.json";
import fr from "../../i18n/locales/fr/appEmulator.json";
import {
	BASE_LOAD_TIMEOUT_MS,
	CPU_PROFILES,
	DEFAULT_CPU_PROFILE_ID,
	DEFAULT_NETWORK_PROFILE_ID,
	MAX_LOAD_TIMEOUT_MS,
	NETWORK_PROFILES,
	findCpuProfile,
	findNetworkProfile,
	loadTimeoutFor,
} from "../emulation-throttling";

describe("throttling profiles", () => {
	it("offers no throttling, 4G, Fast 3G and Slow 3G, and 1x to 6x, each named in en and fr", () => {
		expect(NETWORK_PROFILES.map((profile) => profile.id)).toEqual(["none", "4g", "fast-3g", "slow-3g"]);
		expect(CPU_PROFILES.map((profile) => [profile.id, profile.rate])).toEqual([
			["1x", 1],
			["2x", 2],
			["4x", 4],
			["6x", 6],
		]);
		for (const texts of [en, fr]) {
			for (const profile of NETWORK_PROFILES) expect(texts.matrix.network[profile.id]).toBeTruthy();
			for (const profile of CPU_PROFILES) expect(texts.matrix.cpu[profile.id]).toBeTruthy();
		}
	});

	it("defaults to nothing throttled, and gets slower down the list", () => {
		expect(findNetworkProfile(DEFAULT_NETWORK_PROFILE_ID)?.conditions).toBeNull();
		expect(findCpuProfile(DEFAULT_CPU_PROFILE_ID)?.rate).toBe(1);
		const throttled = NETWORK_PROFILES.flatMap((profile) => (profile.conditions ? [profile.conditions] : []));
		for (let index = 1; index < throttled.length; index += 1) {
			expect(throttled[index].latencyMs).toBeGreaterThan(throttled[index - 1].latencyMs);
			expect(throttled[index].downloadBytesPerSecond).toBeLessThan(throttled[index - 1].downloadBytesPerSecond);
		}
	});

	it("finds a profile by id and nothing else", () => {
		expect(findNetworkProfile("slow-3g")?.conditions?.latencyMs).toBe(2000);
		expect(findNetworkProfile("slow-2g")).toBeUndefined();
		expect(findNetworkProfile({ id: "slow-3g" })).toBeUndefined();
		expect(findCpuProfile("4x")?.rate).toBe(4);
		expect(findCpuProfile("20x")).toBeUndefined();
		expect(findCpuProfile(4)).toBeUndefined();
	});

	it("gives a slow network and a slow CPU more time to load, within a ceiling", () => {
		const none = findNetworkProfile("none");
		const slow = findNetworkProfile("slow-3g");
		const full = findCpuProfile("1x");
		const sixth = findCpuProfile("6x");
		if (!none || !slow || !full || !sixth) throw new Error("profiles missing");
		expect(loadTimeoutFor(none, full)).toBe(BASE_LOAD_TIMEOUT_MS);
		expect(loadTimeoutFor(slow, full)).toBe(120_000);
		expect(loadTimeoutFor(none, sixth)).toBe(MAX_LOAD_TIMEOUT_MS);
		expect(loadTimeoutFor(slow, sixth)).toBe(MAX_LOAD_TIMEOUT_MS);
	});
});
