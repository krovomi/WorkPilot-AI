/**
 * Five preload modules were written against `window.electronAPI` — the object
 * `contextBridge.exposeInMainWorld` publishes into the *renderer's* world.
 * The app runs with `contextIsolation: true` and `sandbox: true`
 * (`main/index.ts`), so inside the preload's own context that global is
 * `undefined`, and every method those modules exposed threw as soon as the
 * renderer called it:
 *
 *     TypeError: Cannot read properties of undefined (reading 'invoke')
 *
 * Code Migration, Architecture Visualizer, Documentation Agent, Auto-Refactor
 * and Performance Profiler were unusable for that single reason — 38 call
 * sites in all. A preload module has `ipcRenderer` directly and must use
 * `ipc-utils` (`invokeIpc` / `createIpcListener`); reaching back through the
 * bridge it is itself building is always the bug.
 *
 * `ElectronAPI` carries an `[x: string]: any` index signature, so the compiler
 * had nothing to say about any of it — hence a test.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_DIR = path.resolve(import.meta.dirname, "..");

function apiSources(dir: string): { file: string; source: string }[] {
	const out: { file: string; source: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...apiSources(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push({
				file: path.relative(API_DIR, full),
				source: readFileSync(full, "utf-8"),
			});
		}
	}
	return out;
}

describe("preload bridge modules", () => {
	const sources = apiSources(API_DIR);

	it("finds the API modules", () => {
		expect(sources.length).toBeGreaterThan(50);
	});

	it("never reaches through the bridge they build", () => {
		const offenders = sources
			.filter(({ source }) =>
				/(?:window|globalThis)\s*\.\s*electronAPI\s*\./.test(source),
			)
			.map(({ file }) => file);

		expect(offenders).toEqual([]);
	});
});
