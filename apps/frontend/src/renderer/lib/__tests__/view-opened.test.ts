/**
 * A view opened is counted on this machine and passed to the main for the
 * server's page activity; leaving every view passes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const recordViewVisit = vi.hoisted(() => vi.fn());
vi.mock("@/stores/view-usage-store", () => ({ recordViewVisit }));

import { noteViewOpened } from "../view-opened";

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("noteViewOpened", () => {
	it("counts here and tells the main", () => {
		const notePageVisit = vi.fn();
		(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage: { notePageVisit } };
		noteViewOpened("kanban");
		noteViewOpened(null);
		expect(recordViewVisit.mock.calls).toEqual([["kanban"], [null]]);
		expect(notePageVisit.mock.calls).toEqual([["kanban"]]);
	});

	it("works without the bridge", () => {
		expect(() => noteViewOpened("roadmap")).not.toThrow();
	});
});
