/**
 * The listener bootstrap, and the invariant that keeps it true.
 *
 * A page used to register its own IPC listeners on mount and drop them on
 * unmount, which meant navigating away from a running job silently stopped the
 * UI from hearing about it. The fix is only a fix for as long as no page takes
 * the subscription back, so that rule is pinned here rather than left to code
 * review.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	resetGlobalListenersForTests,
	setupGlobalListeners,
} from "../global-listeners";

const RENDERER_DIR = join(__dirname, "..", "..");
const SETUP_CALL = /setup[A-Za-z]*Listeners\s*\(/;

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...walk(full));
		} else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
			found.push(full);
		}
	}
	return found;
}

describe("global listener bootstrap", () => {
	afterEach(() => {
		resetGlobalListenersForTests();
		vi.restoreAllMocks();
	});

	it("registers once, so an event is never handled twice", () => {
		const first = setupGlobalListeners();
		const second = setupGlobalListeners();

		// React 18 remounts effects in development; a second registration would
		// duplicate every appended idea, log line and finding.
		expect(second).toBe(first);
	});

	it("hands back a teardown that allows a later re-registration", () => {
		const teardown = setupGlobalListeners();
		teardown();

		expect(setupGlobalListeners()).not.toBe(teardown);
	});

	it("no page component registers IPC listeners of its own", () => {
		const offenders = walk(join(RENDERER_DIR, "components"))
			.filter((file) => SETUP_CALL.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(RENDERER_DIR.length + 1));

		// A page is a view onto work, not its owner: the subscription belongs to
		// stores/global-listeners.ts for the life of the window.
		expect(offenders).toEqual([]);
	});
});
