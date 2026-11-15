/** A note's vault path is shown from its place in the memory, or whole. */
import { describe, expect, it } from "vitest";
import { shortPath } from "../lifecycle-labels";

describe("shortPath", () => {
	it("keeps the part after /memory/, or the whole path when there is none", () => {
		expect(shortPath("knowledge/projects/shop/memory/gotchas/x.md")).toBe("gotchas/x.md");
		expect(shortPath("inbox/x.md")).toBe("inbox/x.md");
	});
});
