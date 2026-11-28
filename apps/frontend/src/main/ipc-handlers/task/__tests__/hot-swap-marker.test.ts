import { describe, expect, it } from "vitest";
import { hotSwapMarkerBody } from "../hot-swap-marker";

const now = new Date("2026-11-28T17:42:51.691Z");
const body = (phase: string, change: Record<string, string>, pending: string | null) =>
	JSON.parse(hotSwapMarkerBody(phase, change, pending, now));

describe("hotSwapMarkerBody", () => {
	it("writes the change alone when nothing is pending", () => {
		expect(body("coding", { model: "m" }, null)).toEqual({
			phase: "coding",
			provider: null,
			model: "m",
			effort: null,
			requested_at: now.toISOString(),
		});
	});

	it("keeps what a pending request of the same phase set", () => {
		const pending = JSON.stringify({ phase: "spec", provider: null, model: "claude-haiku-5-5", effort: null });
		expect(body("spec", { effort: "none" }, pending)).toMatchObject({ model: "claude-haiku-5-5", effort: "none" });
	});

	it("lets the new request win on the fields it sets", () => {
		const pending = JSON.stringify({ phase: "spec", model: "a", effort: "high" });
		expect(body("spec", { model: "b" }, pending)).toMatchObject({ model: "b", effort: "high" });
	});

	it("ignores another phase, broken JSON and values that are not text", () => {
		expect(body("qa", { effort: "low" }, JSON.stringify({ phase: "spec", model: "a" })).model).toBeNull();
		expect(body("qa", { effort: "low" }, "{not json").model).toBeNull();
		expect(body("qa", { effort: "low" }, "null").model).toBeNull();
		expect(body("qa", { effort: "low" }, JSON.stringify({ phase: "qa", model: 3 })).model).toBeNull();
	});
});
