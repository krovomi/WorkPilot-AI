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

	const frame = (value: number, length = 1600) => ({
		inputBuffer: { getChannelData: () => new Float32Array(length).fill(value) },
	});

	it("cuts a phrase at a pause after two seconds, and reports the level", async () => {
		const chunk = vi.fn();
		const level = vi.fn();
		const stop = await captureDictation(chunk, level, vi.fn());
		// 2 s of speech (20 frames of 0.1 s at 16 kHz), then a pause.
		for (let i = 0; i < 20; i++) processor.onaudioprocess?.(frame(0.05));
		expect(level.mock.lastCall?.[0]).toBeCloseTo(0.4, 5);
		for (let i = 0; i < 6; i++) processor.onaudioprocess?.(frame(0));
		expect(chunk).not.toHaveBeenCalled();
		processor.onaudioprocess?.(frame(0));
		expect(chunk).toHaveBeenCalledOnce();
		expect(new DataView(chunk.mock.calls[0][0]).getUint32(40, true)).toBe(27 * 1600 * 2);
		processor.onaudioprocess?.(frame(1));
		expect(level).toHaveBeenLastCalledWith(1);
		stop();
		expect(chunk).toHaveBeenCalledTimes(2);
	});

	it("cuts a long phrase at twenty seconds", async () => {
		const chunk = vi.fn();
		await captureDictation(chunk, vi.fn(), vi.fn());
		for (let i = 0; i < 199; i++) processor.onaudioprocess?.(frame(0.2));
		expect(chunk).not.toHaveBeenCalled();
		processor.onaudioprocess?.(frame(0.2));
		expect(chunk).toHaveBeenCalledOnce();
	});

	it("sends nothing for silence alone", async () => {
		const chunk = vi.fn();
		const stop = await captureDictation(chunk, vi.fn(), vi.fn());
		for (let i = 0; i < 30; i++) processor.onaudioprocess?.(frame(0.001));
		stop();
		expect(chunk).not.toHaveBeenCalled();
	});

	it("tells when the microphone goes away, and stops listening for it", async () => {
		const ended = vi.fn();
		const stop = await captureDictation(vi.fn(), vi.fn(), ended);
		expect(track.addEventListener).toHaveBeenCalledWith("ended", ended);
		stop();
		expect(track.removeEventListener).toHaveBeenCalledWith("ended", ended);
	});

	it("survives a context the browser already closed", async () => {
		close.mockRejectedValue(new Error("closed"));
		const stop = await captureDictation(vi.fn(), vi.fn(), vi.fn());
		stop();
		await Promise.resolve();
		resume.mockRejectedValueOnce(new Error("device lost"));
		await expect(captureDictation(vi.fn(), vi.fn(), vi.fn())).rejects.toThrow("device lost");
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("releases the microphone when no audio context can be made", async () => {
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					throw new Error("no audio");
				}
			},
		);
		await expect(captureDictation(vi.fn(), vi.fn(), vi.fn())).rejects.toThrow("no audio");
		expect(track.stop).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
	});
});
