import { MAX_DAYS, lendingEnd, parseDays } from "../card/delegations";

describe("lending one's approval", () => {
	it("takes a whole number of days between 1 and the server's longest", () => {
		expect(parseDays(" 7 ")).toBe(7);
		expect(parseDays("1")).toBe(1);
		expect(parseDays(String(MAX_DAYS))).toBe(MAX_DAYS);
		for (const raw of ["", "0", "91", "1.5", "-3", "7d", "1000"]) expect(parseDays(raw)).toBeNull();
	});

	it("ends that many days from now, in UTC", () => {
		expect(lendingEnd(2, new Date("2026-11-21T10:00:00Z"))).toBe("2026-11-23T10:00:00.000Z");
		expect(Date.parse(lendingEnd(1)) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
	});
});
