import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PixelAgent, usePixelOfficeStore } from "../../../stores/pixel-office-store";
import { PixelOfficeCanvas } from "../PixelOfficeCanvas";

/** A 2D context that does nothing but remember where the images went. */
function fakeContext(drawn: number[][]) {
	const target: Record<string | symbol, unknown> = {
		drawImage: (...args: unknown[]) => drawn.push(args.slice(1).map(Number)),
		measureText: () => ({ width: 10 }),
		createRadialGradient: () => ({ addColorStop: () => undefined }),
	};
	return new Proxy(target, {
		get: (obj, key) => (key in obj ? obj[key] : () => undefined),
		set: (obj, key, value) => {
			obj[key] = value;
			return true;
		},
	});
}

const typing: PixelAgent = {
	id: "t1",
	type: "terminal",
	name: "agent",
	fullName: "agent",
	characterIndex: 0,
	activity: "typing",
	seatIndex: 0,
	isClaudeMode: true,
};

describe("PixelOfficeCanvas", () => {
	let frames: FrameRequestCallback[];
	let drawn: number[][];

	beforeEach(() => {
		frames = [];
		drawn = [];
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			() => fakeContext(drawn) as unknown as CanvasRenderingContext2D,
		);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		usePixelOfficeStore.setState({ agents: [typing], selectedAgentId: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	/** Draw two frames and return what each one put on the canvas. */
	function twoFrames(calm: boolean) {
		render(<PixelOfficeCanvas width={400} height={300} emptyDeskLabel="empty" calm={calm} />);
		const runs: number[][][] = [];
		for (const at of [100, 200]) {
			drawn.length = 0;
			frames[frames.length - 1](at);
			runs.push(drawn.map((args) => [...args]));
		}
		return runs;
	}

	it("animates the characters from one frame to the next", () => {
		const [first, second] = twoFrames(false);
		expect(first.length).toBeGreaterThan(0);
		expect(second).not.toEqual(first);
	});

	it("holds every character still in calm mode", () => {
		const [first, second] = twoFrames(true);
		expect(first.length).toBeGreaterThan(0);
		expect(second).toEqual(first);
	});
});
