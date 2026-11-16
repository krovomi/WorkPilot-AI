/**
 * A recording 2D context for jsdom, which has none.
 *
 * Every method call is kept with the drawing state at that moment, so a test
 * can ask what was drawn ("which names were written, in which colour") rather
 * than how many times a method ran.
 */
import { vi } from "vitest";

export interface CanvasCall {
	readonly name: string;
	readonly args: readonly unknown[];
	readonly fillStyle: unknown;
	readonly strokeStyle: unknown;
	readonly globalAlpha: number;
	readonly font: string;
}

export interface FakeContext {
	readonly ctx: CanvasRenderingContext2D;
	readonly calls: CanvasCall[];
}

/** Text is 4 px per character, so wrapping is easy to predict. */
export const CHAR_WIDTH = 4;

function fakeContext(canvas: HTMLCanvasElement): FakeContext {
	const calls: CanvasCall[] = [];
	const state: Record<string | symbol, unknown> = {
		canvas,
		globalAlpha: 1,
		fillStyle: "#000000",
		strokeStyle: "#000000",
		font: "10px sans-serif",
	};
	const saved: Record<string | symbol, unknown>[] = [];
	const results: Record<string, (...args: unknown[]) => unknown> = {
		measureText: (text) => ({ width: String(text).length * CHAR_WIDTH }),
		createRadialGradient: () => ({ addColorStop: () => undefined }),
		save: () => saved.push({ ...state }),
		restore: () => Object.assign(state, saved.pop()),
	};
	const ctx = new Proxy(state, {
		get(target, prop) {
			if (prop in target) return target[prop];
			return (...args: unknown[]) => {
				calls.push({
					name: String(prop),
					args,
					fillStyle: target.fillStyle,
					strokeStyle: target.strokeStyle,
					globalAlpha: target.globalAlpha as number,
					font: target.font as string,
				});
				return results[String(prop)]?.(...args);
			};
		},
		set(target, prop, value) {
			target[prop] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, calls };
}

/**
 * Give every canvas a recording context (the same one on each call, as a
 * browser does). Returns the context of a given canvas.
 */
export function installFakeCanvas(): (canvas: HTMLCanvasElement) => FakeContext {
	const contexts = new WeakMap<HTMLCanvasElement, FakeContext>();
	const contextOf = (canvas: HTMLCanvasElement) => {
		let fake = contexts.get(canvas);
		if (!fake) {
			fake = fakeContext(canvas);
			contexts.set(canvas, fake);
		}
		return fake;
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		function (this: HTMLCanvasElement) {
			return contextOf(this).ctx;
		} as unknown as HTMLCanvasElement["getContext"],
	);
	return contextOf;
}

/** A canvas with no 2D context at all, which is what jsdom really has. */
export function removeCanvasContext(): void {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}
