/**
 * Recorded steps and export requests are read against closed lists: what
 * the page or the renderer sends beyond them is dropped (#387).
 */
import { describe, expect, it } from "vitest";
import { MAX_RECORDED_STEPS, parseRecordedStep, readExportRequest } from "../browser-recorder";

const button = { strategy: "role", role: "button", value: "Save" };

describe("parseRecordedStep", () => {
	it("keeps each field of a well-formed step", () => {
		expect(
			parseRecordedStep({
				id: "s2",
				kind: "fill",
				selectors: [button, { strategy: "css", value: "#a", role: "x" }],
				value: "Ada",
				secretEnv: "E2E_PASSWORD",
				key: "Enter",
				text: "Hi",
				url: "http://localhost/",
			}),
		).toEqual({
			id: "s2",
			kind: "fill",
			selectors: [
				{ strategy: "role", role: "button", value: "Save" },
				{ strategy: "css", value: "#a" },
			],
			url: "http://localhost/",
			value: "Ada",
			secretEnv: "E2E_PASSWORD",
			key: "Enter",
			text: "Hi",
		});
	});

	it("drops unknown selectors and fields that break the pattern", () => {
		const step = parseRecordedStep({
			id: "s1",
			kind: "click",
			selectors: [{ strategy: "xpath", value: "//a" }, { strategy: "css", value: "" }, null, button],
			secretEnv: "rm -rf",
			value: 4,
		});
		expect(step).toEqual({ id: "s1", kind: "click", selectors: [{ strategy: "role", role: "button", value: "Save" }] });
	});

	it("refuses what is not a step", () => {
		expect(parseRecordedStep(null)).toBeNull();
		expect(parseRecordedStep({ id: "../x", kind: "click", selectors: [button] })).toBeNull();
		expect(parseRecordedStep({ id: "s1", kind: "eval", selectors: [button] })).toBeNull();
		expect(parseRecordedStep({ id: "s1", kind: "click", selectors: "button" })).toBeNull();
		expect(parseRecordedStep({ id: "s1", kind: "navigate" })).toBeNull();
		expect(parseRecordedStep({ id: "s1", kind: "navigate", url: "http://a/" })).toEqual({
			id: "s1",
			kind: "navigate",
			selectors: [],
			url: "http://a/",
		});
	});
});

describe("parseRecordedStep: where the element lives, what its action caused", () => {
	const click = { id: "s3", kind: "click", selectors: [button] };

	it("keeps the frames, shadow hosts and waits of a step", () => {
		const step = {
			...click,
			frames: ['iframe[name="pay"]'],
			shadow: ["x-card", "x-button"],
			waitVisible: true,
			waitUrl: "http://localhost/done",
			waitRequest: { method: "POST", path: "/api/pay" },
		};
		expect(parseRecordedStep(step)).toEqual({
			...step,
			selectors: [{ strategy: "role", role: "button", value: "Save" }],
		});
	});

	it("refuses a step whose place is malformed, drops a malformed wait", () => {
		for (const chain of ["x", ["a", "b", "c", "d", "e"], [""], [3], ["a".repeat(301)]]) {
			expect(parseRecordedStep({ ...click, frames: chain })).toBeNull();
			expect(parseRecordedStep({ ...click, shadow: chain })).toBeNull();
		}
		expect(
			parseRecordedStep({
				...click,
				frames: [],
				waitVisible: "yes",
				waitUrl: "javascript:alert(1)",
				waitRequest: { method: "TRACE", path: "/a" },
			}),
		).toEqual({ id: "s3", kind: "click", selectors: [{ strategy: "role", role: "button", value: "Save" }] });
		for (const waitRequest of [null, "POST /a", { method: "GET", path: "a" }, { method: "GET", path: "/a?b" }, { method: "GET" }]) {
			expect(parseRecordedStep({ ...click, waitRequest })?.waitRequest).toBeUndefined();
		}
		expect(parseRecordedStep({ ...click, waitUrl: "http://a/b?c=1" })?.waitUrl).toBeUndefined();
	});
});

describe("readExportRequest", () => {
	it("accepts each format of the closed list", () => {
		for (const format of ["selenium-python", "selenium-java", "webdriverio"]) {
			expect(readExportRequest({ format, destination: "preview", stepIds: [] })?.format).toBe(format);
		}
		expect(readExportRequest({ format: "selenium-ruby", destination: "preview", stepIds: [] })).toBeNull();
	});

	it("keeps the step ids once, in order", () => {
		expect(
			readExportRequest({
				format: "cypress",
				destination: "review",
				name: "n".repeat(100),
				stepIds: ["s2", "s1", "s2", "x", 3],
			}),
		).toEqual({ format: "cypress", destination: "review", name: "n".repeat(80), stepIds: ["s2", "s1"] });
		const many = Array.from({ length: MAX_RECORDED_STEPS + 5 }, (_, i) => `s${i}`);
		expect(readExportRequest({ format: "cypress", destination: "file", stepIds: many })?.stepIds).toHaveLength(
			MAX_RECORDED_STEPS,
		);
	});

	it("refuses a format, a destination or ids outside the lists", () => {
		expect(readExportRequest(null)).toBeNull();
		expect(readExportRequest({ format: "selenium", destination: "file", stepIds: [] })).toBeNull();
		expect(readExportRequest({ format: "cypress", destination: "/etc", stepIds: [] })).toBeNull();
		expect(readExportRequest({ format: "cypress", destination: "file", stepIds: "s1" })).toBeNull();
		expect(readExportRequest({ format: "cypress", destination: "file", stepIds: [] })?.name).toBe("");
	});
});
