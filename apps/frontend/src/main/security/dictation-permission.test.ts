import { describe, expect, it } from "vitest";
import { canUseDictationMicrophone } from "./dictation-permission";

describe("dictation microphone permissions", () => {
	it("allows only main-frame audio", () => {
		expect(canUseDictationMicrophone("media", true, true, ["audio"])).toBe(
			true,
		);
		expect(canUseDictationMicrophone("media", false, true, ["audio"])).toBe(
			false,
		);
		expect(canUseDictationMicrophone("media", true, false, ["audio"])).toBe(
			false,
		);
		expect(canUseDictationMicrophone("media", true, true, ["video"])).toBe(
			false,
		);
		expect(
			canUseDictationMicrophone("media", true, true, ["audio", "video"]),
		).toBe(false);
		expect(canUseDictationMicrophone("media", true, true, undefined)).toBe(
			false,
		);
	});
});
