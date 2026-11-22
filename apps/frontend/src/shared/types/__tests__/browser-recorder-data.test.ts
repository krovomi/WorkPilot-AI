/**
 * The data part of the exporter's answer (#387): keys and kinds in closed
 * lists, a data file only as a `.json` path with its text.
 */
import { describe, expect, it } from "vitest";
import { DATA_KINDS, readTestData } from "../browser-recorder-data";

describe("readTestData", () => {
	it("keeps the keys and kinds of the closed lists", () => {
		const dataValues = DATA_KINDS.map((kind, i) => ({ name: `k${i}`, kind }));
		expect(readTestData({ dataValues }).dataValues).toEqual(dataValues);
		const bad = [null, "email", { name: "1a", kind: "email" }, { name: "a-b", kind: "date" }, { name: "a", kind: "id" }];
		expect(readTestData({ dataValues: bad })).toEqual({ dataValues: [] });
		const many = Array.from({ length: 400 }, (_, i) => ({ name: `k${i}`, kind: "text" }));
		expect(readTestData({ dataValues: many }).dataValues).toHaveLength(300);
	});

	it("keeps a data file only as a bounded .json path with its text", () => {
		const fixture = { path: "e2e/a.data.json", code: "{}\n" };
		expect(readTestData({ fixture })).toEqual({ fixture, dataValues: [] });
		for (const bad of [
			{ path: `${"a/".repeat(600)}x.json`, code: "{}" },
			{ path: "a.json", code: 1 },
			{ path: 1, code: "{}" },
			{ path: "a.js", code: "{}" },
			null,
		]) {
			expect(readTestData({ fixture: bad }).fixture).toBeUndefined();
		}
	});
});
