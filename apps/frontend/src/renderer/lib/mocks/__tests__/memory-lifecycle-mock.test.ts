/**
 * In the browser preview (no Electron), the Lifecycle tab reads an empty
 * memory and every change is refused with a reason, never a fake success.
 */
import { describe, expect, it } from "vitest";
import { memoryLifecycleMock } from "../memory-lifecycle-mock";

describe("the memory lifecycle browser mock", () => {
	it("reads an empty lifecycle and an empty history", async () => {
		expect(await memoryLifecycleMock.getMemoryLifecycle()).toEqual({
			success: true,
			data: {
				journal: [],
				revertible: {},
				lastUndo: null,
				metrics: null,
				trash: [],
				conflicts: [],
				pinned: 0,
				pinLimit: 50,
				retentionDays: 30,
			},
		});
		expect(await memoryLifecycleMock.getMemoryHistory()).toEqual({ success: true, data: [] });
	});

	it("refuses every change", async () => {
		for (const change of [
			memoryLifecycleMock.forgetMemory,
			memoryLifecycleMock.restoreMemory,
			memoryLifecycleMock.pinMemory,
			memoryLifecycleMock.resolveMemoryConflict,
			memoryLifecycleMock.suggestMemoryResolution,
			memoryLifecycleMock.revertMemoryDecision,
		]) {
			expect(await change()).toEqual({ success: false, error: "Not available in browser mock" });
		}
	});
});
