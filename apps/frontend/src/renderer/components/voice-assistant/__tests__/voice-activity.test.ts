import { describe, expect, it } from "vitest";
import {
	CALIBRATION_FRAMES,
	createVoiceActivityDetector,
	DEFAULT_VOICE_SENSITIVITY,
	voiceSensitivity,
} from "../voice-activity";

function feed(detector: ReturnType<typeof createVoiceActivityDetector>, levels: number[]) {
	return levels.map((rms) => detector.isVoice(rms));
}

describe("voice activity detection", () => {
	it("calibrates on the first frames, keeping the quietest", () => {
		const detector = createVoiceActivityDetector("medium");
		expect(detector.calibrated()).toBe(false);
		feed(detector, [0.02, 0.01, 0.03, 0.012]);
		expect(detector.calibrated()).toBe(true);
		expect(CALIBRATION_FRAMES).toBe(4);
		// Floor 0.01 × 2.5.
		expect(detector.threshold()).toBeCloseTo(0.025);
		expect(feed(detector, [0.2, 0.02])).toEqual([true, false]);
	});

	it("speech heard during calibration still counts once the room is quieter", () => {
		const detector = createVoiceActivityDetector("medium");
		// The person speaks at once: the first floor is their voice…
		expect(feed(detector, [0.2, 0.2])).toEqual([false, false]);
		// …until a pause drops it to the room.
		expect(feed(detector, [0.004, 0.2])).toEqual([false, true]);
	});

	it("follows a room that gets noisier, slowly, and a quieter one at once", () => {
		const detector = createVoiceActivityDetector("medium");
		feed(detector, [0.004, 0.004, 0.004, 0.004]);
		expect(detector.threshold()).toBe(0.01);
		// A fan: 0.009 is not speech, and the floor rises towards it.
		const fan = Array.from({ length: 200 }, () => 0.009);
		expect(feed(detector, fan).every((voice) => !voice)).toBe(true);
		expect(detector.threshold()).toBeGreaterThan(0.02);
		expect(detector.isVoice(0.015)).toBe(false);
		// The fan stops: the next quiet frame sets the floor back down.
		detector.isVoice(0.002);
		expect(detector.threshold()).toBe(0.008);
	});

	it("a higher sensitivity hears a softer voice", () => {
		const room = [0.006, 0.006, 0.006, 0.006];
		const low = createVoiceActivityDetector("low");
		const high = createVoiceActivityDetector("high");
		feed(low, room);
		feed(high, room);
		expect(low.isVoice(0.015)).toBe(false);
		expect(high.isVoice(0.015)).toBe(true);
		expect(createVoiceActivityDetector().threshold()).toBe(0.008);
	});

	it("reads digital silence and broken values as silence", () => {
		const detector = createVoiceActivityDetector("high");
		expect(feed(detector, [0, Number.NaN, -1, Number.POSITIVE_INFINITY])).toEqual([
			false,
			false,
			false,
			false,
		]);
		expect(detector.threshold()).toBe(0.005);
	});

	it("takes the saved sensitivity, or the default for anything else", () => {
		expect(voiceSensitivity("low")).toBe("low");
		expect(voiceSensitivity("high")).toBe("high");
		expect(voiceSensitivity("loud")).toBe(DEFAULT_VOICE_SENSITIVITY);
		expect(voiceSensitivity(undefined)).toBe("medium");
	});
});
