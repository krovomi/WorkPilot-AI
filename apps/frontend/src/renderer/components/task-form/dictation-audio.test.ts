import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureDictation } from "./dictation-audio";

describe("microphone capture", () => {
	const track = {
		stop: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	const source = { connect: vi.fn(), disconnect: vi.fn() };
	const processor = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		onaudioprocess: null as null | ((event: unknown) => void),
	};
	const close = vi.fn();
	const resume = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		close.mockResolvedValue(undefined);
		resume.mockResolvedValue(undefined);
		vi.stubGlobal(
			"AudioContext",
			class {
				sampleRate = 16000;
				destination = {};
				resume = resume;
				close = close;
				createMediaStreamSource = () => source;
				createScriptProcessor = () => processor;
			},
		);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn().mockResolvedValue({
					getTracks: () => [track],
					getAudioTracks: () => [track],
				}),
			},
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	it("flushes the final PCM as a valid mono WAV and releases the device once", async () => {
		const chunk = vi.fn();
		const stop = await captureDictation(chunk, vi.fn(), vi.fn());
		processor.onaudioprocess?.({
			inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5, 0]) },
		});
		stop();
		stop();
		const wav = new DataView(chunk.mock.calls[0][0]);
		expect(wav.getUint32(24, true)).toBe(16000);
		expect(wav.getUint32(40, true)).toBe(6);
		expect(wav.getInt16(44, true)).toBe(16383);
		expect(track.stop).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(processor.onaudioprocess).toBeNull();
	});
	it("discards audio on cancel without invoking transcription", async () => {
		const chunk = vi.fn();
		const stop = await captureDictation(chunk, vi.fn(), vi.fn());
		processor.onaudioprocess?.({
			inputBuffer: { getChannelData: () => new Float32Array([0.5]) },
		});
		stop(true);
		expect(chunk).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalledOnce();
	});
	it("releases the microphone if audio initialization fails", async () => {
		resume.mockRejectedValueOnce(new Error("device lost"));
		await expect(captureDictation(vi.fn(), vi.fn(), vi.fn())).rejects.toThrow(
			"device lost",
		);
		expect(track.stop).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});
	it("sends the audio so far on flush and keeps listening", async () => {
		const chunk = vi.fn();
		const stop = await captureDictation(chunk, vi.fn(), vi.fn());
		const frame = { inputBuffer: { getChannelData: () => new Float32Array([0.5]) } };
		processor.onaudioprocess?.(frame);
		stop.flush();
		expect(chunk).toHaveBeenCalledOnce();
		processor.onaudioprocess?.(frame);
		stop();
		expect(chunk).toHaveBeenCalledTimes(2);
		stop.flush();
		expect(chunk).toHaveBeenCalledTimes(2);
	});
	it("asks the caller's detector which frames are voice, and never sends the room alone", async () => {
		const chunk = vi.fn();
		const level = vi.fn();
		const isVoice = vi.fn((rms: number) => rms > 0.4);
		const stop = await captureDictation(chunk, level, vi.fn(), isVoice);
		processor.onaudioprocess?.({
			inputBuffer: { getChannelData: () => new Float32Array([0.2, -0.2]) },
		});
		expect(level).toHaveBeenLastCalledWith(1, false);
		stop.flush();
		expect(chunk).not.toHaveBeenCalled();
		processor.onaudioprocess?.({
			inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) },
		});
		expect(level).toHaveBeenLastCalledWith(1, true);
		stop();
		expect(chunk).toHaveBeenCalledOnce();
		expect(isVoice).toHaveBeenCalledWith(0.5);
	});
});
