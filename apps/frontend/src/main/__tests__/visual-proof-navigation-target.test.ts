/**
 * A web navigation step of the visual proof stays on the application it proves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnings = vi.hoisted(() => [] as string[]);
vi.mock("../app-logger", () => ({
	logger: { warn: (message: string) => warnings.push(message) },
}));

import { navigationTargetOnOrigin } from "../visual-proof-navigation-target";

const APP = "http://localhost:5173/";

beforeEach(() => {
	warnings.length = 0;
});

describe("where a navigation step may lead", () => {
	it("opens a route of the application, or an address on it", () => {
		expect(navigationTargetOnOrigin("/invoices/new", APP)).toBe(
			"http://localhost:5173/invoices/new",
		);
		expect(navigationTargetOnOrigin("settings?tab=2#top", "http://localhost:5173/app/")).toBe(
			"http://localhost:5173/app/settings?tab=2#top",
		);
		expect(navigationTargetOnOrigin("http://localhost:5173/admin", APP)).toBe(
			"http://localhost:5173/admin",
		);
		expect(warnings).toEqual([]);
	});

	it("skips an address outside the application", () => {
		for (const outside of [
			"http://localhost:8080/",
			"https://localhost:5173/",
			"http://127.0.0.1:5173/",
			"//example.com/page",
			"https://example.com/",
			"file:///etc/hosts",
			"data:text/html,<h1>x</h1>",
			"javascript:alert(1)",
		]) {
			expect(navigationTargetOnOrigin(outside, APP)).toBeNull();
		}
		expect(warnings).toHaveLength(8);
		expect(warnings[0]).toContain("outside the application");
	});

	it("skips a step that is not an address", () => {
		expect(navigationTargetOnOrigin("http://[", APP)).toBeNull();
		expect(warnings).toEqual(["[VisualProof] Navigation step ignored, not an address: http://["]);
	});
});
