import { periodOf } from "../usage/period";

describe("periodOf", () => {
	it("covers the last days, today included, in UTC", () => {
		expect(periodOf(30, new Date("2026-11-27T23:30:00Z"))).toEqual({ start: "2026-10-29", end: "2026-11-27" });
		expect(periodOf(1).start).toBe(periodOf(1).end);
	});
});
