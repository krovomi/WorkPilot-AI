/**
 * The part of jsdom the visual proof world uses (the package ships no types,
 * and this is not worth a dependency).
 */
declare module "jsdom" {
	export class JSDOM {
		constructor(html?: string, options?: { url?: string; runScripts?: "dangerously" | "outside-only" });
		readonly window: Window & typeof globalThis;
	}
}
