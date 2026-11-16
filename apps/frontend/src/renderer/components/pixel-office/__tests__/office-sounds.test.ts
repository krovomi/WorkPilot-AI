/**
 * Chimes: two synthesised notes, at most one chime per throttle window, and
 * silence (never an error) when there is no audio device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeChimes, playChime } from "../office-sounds";

interface FakeNode {
	readonly kind: "oscillator" | "gain";
	readonly frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
	readonly gain: {
		setValueAtTime: ReturnType<typeof vi.fn>;
		linearRampToValueAtTime: ReturnType<typeof vi.fn>;
		exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
	};
	type?: string;
	connect: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

let created: FakeAudioContext[];

class FakeAudioContext {
	state: "running" | "suspended" = "running";
	currentTime = 5;
	destination = { name: "speakers" };
	nodes: FakeNode[] = [];
	resume = vi.fn(async () => undefined);
	close = vi.fn(async () => undefined);

	constructor() {
		created.push(this);
	}

	private node(kind: FakeNode["kind"]): FakeNode {
		const node: FakeNode = {
			kind,
			frequency: { setValueAtTime: vi.fn() },
			gain: {
				setValueAtTime: vi.fn(),
				linearRampToValueAtTime: vi.fn(),
				exponentialRampToValueAtTime: vi.fn(),
			},
			connect: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		};
		this.nodes.push(node);
		return node;
	}

	createOscillator() {
		return this.node("oscillator");
	}

	createGain() {
		return this.node("gain");
	}

	frequencies(): number[] {
		return this.nodes
			.filter((n) => n.kind === "oscillator")
			.map((n) => n.frequency.setValueAtTime.mock.calls[0][0] as number);
	}
}

beforeEach(() => {
	created = [];
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
	vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
	closeChimes();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("playChime", () => {
	it("plays the two notes of each chime, ramped to avoid a click", () => {
		playChime("needs-input");
		const ctx = created[0];
		expect(ctx.frequencies()).toEqual([660, 880]);
		const [osc, gain] = ctx.nodes;
		expect(osc.type).toBe("triangle");
		expect(osc.connect).toHaveBeenCalledWith(gain);
		expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
		expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 5.01);
		expect(osc.start).toHaveBeenCalledWith(5.01);
		expect(osc.stop.mock.calls[0][0]).toBeCloseTo(5.15);

		vi.advanceTimersByTime(1000);
		playChime("turn-done");
		vi.advanceTimersByTime(1000);
		playChime("failed");
		expect(created).toHaveLength(1);
		expect(ctx.frequencies()).toEqual([660, 880, 523.25, 784, 415.3, 311.1]);
	});

	it("announces a burst of signals once", () => {
		playChime("turn-done");
		vi.advanceTimersByTime(300);
		playChime("turn-done");
		playChime("failed");
		expect(created[0].frequencies()).toEqual([523.25, 784]);

		vi.advanceTimersByTime(400);
		playChime("failed");
		expect(created[0].frequencies()).toHaveLength(4);
	});

	it("wakes a context suspended by the autoplay policy, and stays quiet if it cannot", async () => {
		class Suspended extends FakeAudioContext {
			state = "suspended" as const;
			resume = vi.fn(async () => {
				throw new Error("autoplay blocked");
			});
		}
		vi.stubGlobal("AudioContext", Suspended);
		playChime("needs-input");
		await Promise.resolve();
		expect(created[0].resume).toHaveBeenCalledOnce();
		expect(created[0].frequencies()).toEqual([660, 880]);
	});

	it("is silent without audio support", () => {
		vi.stubGlobal("AudioContext", undefined);
		expect(() => playChime("needs-input")).not.toThrow();
	});

	it("is silent when no audio device can be opened, and tries again next time", () => {
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					throw new Error("no device");
				}
			},
		);
		expect(() => playChime("failed")).not.toThrow();

		vi.stubGlobal("AudioContext", FakeAudioContext);
		playChime("failed");
		expect(created[0].frequencies()).toEqual([415.3, 311.1]);
	});
});

describe("closeChimes", () => {
	it("releases the device and lets the next chime play at once", () => {
		playChime("turn-done");
		const first = created[0];
		closeChimes();
		expect(first.close).toHaveBeenCalledOnce();

		playChime("turn-done");
		expect(created).toHaveLength(2);
		expect(created[1].frequencies()).toEqual([523.25, 784]);
	});

	it("does nothing when nothing was opened, or the device is already gone", async () => {
		expect(() => closeChimes()).not.toThrow();

		playChime("turn-done");
		created[0].close.mockRejectedValueOnce(new Error("already closed"));
		closeChimes();
		await Promise.resolve();
		expect(created[0].close).toHaveBeenCalledOnce();
	});
});
