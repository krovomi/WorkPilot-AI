/**
 * Voice activity detection for the assistant's microphone: is this audio frame
 * someone speaking, or the room? Energy-based (the RMS of each frame that
 * `captureDictation` already measures), with no model and no dependency.
 *
 * The first frames calibrate the noise floor; afterwards it follows the room.
 * It falls at once to a quieter frame and rises slowly while nobody speaks,
 * so a fan turned on does not count as speech for long. A frame is speech when
 * it is loud enough above that floor. The person chooses how much above it
 * (Settings → Voice assistant → Sensitivity).
 */

export const VOICE_SENSITIVITIES = ["low", "medium", "high"] as const;
export type VoiceSensitivity = (typeof VOICE_SENSITIVITIES)[number];
export const DEFAULT_VOICE_SENSITIVITY: VoiceSensitivity = "medium";

/** How many times the noise floor a frame must reach to count as speech. */
const FACTOR: Record<VoiceSensitivity, number> = { low: 4, medium: 2.5, high: 1.6 };
/** The quietest a voice can be, whatever the floor (digital silence included). */
const MIN_THRESHOLD: Record<VoiceSensitivity, number> = {
	low: 0.012,
	medium: 0.008,
	high: 0.005,
};
/** Frames (4096 samples each, about 0.1 s) that set the first floor. */
export const CALIBRATION_FRAMES = 4;
/** How fast the floor rises towards the room's level while nobody speaks. */
const RISE = 0.02;

export interface VoiceActivityDetector {
	/** Feed one frame's RMS; true when it is speech. */
	isVoice: (rms: number) => boolean;
	/** The level a frame must pass right now. */
	threshold: () => number;
	/** The first frames have set the floor. */
	calibrated: () => boolean;
}

/** A setting read from disk: anything but a known value is the default. */
export function voiceSensitivity(value: unknown): VoiceSensitivity {
	return (VOICE_SENSITIVITIES as readonly unknown[]).includes(value)
		? (value as VoiceSensitivity)
		: DEFAULT_VOICE_SENSITIVITY;
}

export function createVoiceActivityDetector(
	sensitivity: VoiceSensitivity = DEFAULT_VOICE_SENSITIVITY,
): VoiceActivityDetector {
	let floor = Number.POSITIVE_INFINITY;
	let frames = 0;
	const threshold = () =>
		Math.max(MIN_THRESHOLD[sensitivity], (Number.isFinite(floor) ? floor : 0) * FACTOR[sensitivity]);
	return {
		isVoice: (rms) => {
			const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
			frames += 1;
			if (level < floor || frames <= CALIBRATION_FRAMES) {
				// Calibration keeps the quietest frame; later, a quieter frame wins at once.
				floor = Math.min(floor, level);
				return level > threshold();
			}
			const voice = level > threshold();
			if (!voice) floor += (level - floor) * RISE;
			return voice;
		},
		threshold,
		calibrated: () => frames >= CALIBRATION_FRAMES,
	};
}
