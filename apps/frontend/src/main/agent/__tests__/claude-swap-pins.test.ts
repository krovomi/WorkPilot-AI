/** A pinned task moved to another Claude profile by an auto-swap restarts on it, once. */
import { describe, expect, it } from "vitest";
import { ClaudeSwapPins } from "../claude-swap-pins";

describe("ClaudeSwapPins", () => {
	it("replaces the task's Claude pin with the swapped profile on its next start only", () => {
		const swaps = new ClaudeSwapPins();
		swaps.remember("task-1", "spare");
		expect(swaps.apply("task-1", { claude: "work", openai: "o" })).toEqual({ claude: "spare", openai: "o" });
		expect(swaps.apply("task-1", { claude: "work" })).toEqual({ claude: "work" });
	});

	it("leaves a task without a Claude pin to the active profile, and keeps the swap", () => {
		const swaps = new ClaudeSwapPins();
		swaps.remember("task-1", "spare");
		expect(swaps.apply("task-1", { openai: "o" })).toEqual({ openai: "o" });
		expect(swaps.apply("task-1", undefined)).toBeUndefined();
		expect(swaps.apply(undefined, { claude: "work" })).toEqual({ claude: "work" });
		expect(swaps.apply("task-2", { claude: "work" })).toEqual({ claude: "work" });
		expect(swaps.apply("task-1", { claude: "work" })).toEqual({ claude: "spare" });
	});
});
