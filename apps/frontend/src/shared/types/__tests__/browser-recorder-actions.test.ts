/**
 * Hovers, scrolls, drags, multiple lists and dialogs are read against their
 * bounds too; a dialog answer from the renderer is read again in the main (#387).
 */
import { describe, expect, it } from "vitest";
import { parsePendingDialog, parseRecordedStep, readDialogAnswer } from "../browser-recorder";

const css = [{ strategy: "css", value: "#a" }];
const keptCss = [{ strategy: "css", value: "#a" }];

describe("parseRecordedStep: new kinds", () => {
	it("keeps a hover, a window scroll and a box scroll", () => {
		expect(parseRecordedStep({ id: "s1", kind: "hover", selectors: css })).toEqual({
			id: "s1",
			kind: "hover",
			selectors: keptCss,
		});
		expect(parseRecordedStep({ id: "s2", kind: "scroll", selectors: [], scrollX: 0, scrollY: 900 })).toEqual({
			id: "s2",
			kind: "scroll",
			selectors: [],
			scrollX: 0,
			scrollY: 900,
		});
		expect(parseRecordedStep({ id: "s3", kind: "scroll", selectors: css, scrollX: 5, scrollY: 40 })?.scrollY).toBe(
			40,
		);
	});

	it("refuses a scroll without a place to scroll to, or with a bad position", () => {
		for (const bad of [
			{ scrollX: 0 },
			{ scrollX: "0", scrollY: 0 },
			{ scrollX: -1, scrollY: 0 },
			{ scrollX: 1.5, scrollY: 0 },
			{ scrollX: 0, scrollY: 10_000_001 },
			{ scrollX: 0, scrollY: 0, frames: ["#f"] },
			{ scrollX: 0, scrollY: 0, shadow: ["x-a"] },
		]) {
			expect(parseRecordedStep({ id: "s1", kind: "scroll", selectors: [], ...bad })).toBeNull();
		}
		expect(parseRecordedStep({ id: "s1", kind: "hover", selectors: [] })).toBeNull();
	});

	it("keeps a drag with its drop and mode, refuses one without", () => {
		const drag = { id: "s1", kind: "drag", selectors: css, drop: [{ strategy: "css", value: "#b" }] };
		expect(parseRecordedStep({ ...drag, dragMode: "html5" })).toMatchObject({
			drop: [{ strategy: "css", value: "#b" }],
			dragMode: "html5",
		});
		expect(parseRecordedStep({ ...drag, dragMode: "touch" })).toBeNull();
		expect(parseRecordedStep({ ...drag, drop: [], dragMode: "pointer" })).toBeNull();
		// A drop is only a drag's.
		expect(parseRecordedStep({ ...drag, kind: "click", dragMode: "pointer" })).not.toHaveProperty("drop");
	});

	it("keeps the options of a multiple list, from two to twenty", () => {
		const select = { id: "s1", kind: "select", selectors: css, value: "a" };
		expect(parseRecordedStep({ ...select, values: ["a", 2] })?.values).toEqual(["a", ""]);
		expect(parseRecordedStep({ ...select, values: ["a"] })).not.toHaveProperty("values");
		expect(parseRecordedStep({ ...select, values: Array(21).fill("a") })).not.toHaveProperty("values");
		expect(parseRecordedStep({ ...select, values: "a,b" })).not.toHaveProperty("values");
		expect(parseRecordedStep({ ...select, kind: "fill", values: ["a", "b"] })).not.toHaveProperty("values");
	});

	it("keeps a dialog's answer, the prompt text only when accepted", () => {
		const click = { id: "s1", kind: "click", selectors: css };
		expect(
			parseRecordedStep({ ...click, dialog: { type: "prompt", accept: true, text: "Neo", message: "Name?" } })
				?.dialog,
		).toEqual({ type: "prompt", accept: true, text: "Neo", message: "Name?" });
		expect(parseRecordedStep({ ...click, dialog: { type: "prompt", accept: false, text: "Neo" } })?.dialog).toEqual({
			type: "prompt",
			accept: false,
		});
		expect(parseRecordedStep({ ...click, dialog: { type: "confirm", accept: true, text: "x" } })?.dialog).toEqual({
			type: "confirm",
			accept: true,
		});
		for (const dialog of [null, "ok", { type: "evil", accept: true }, { type: "alert", accept: "yes" }]) {
			expect(parseRecordedStep({ ...click, dialog })).not.toHaveProperty("dialog");
		}
	});

	it("keeps the shadow hosts above each frame, one list per frame", () => {
		const click = { id: "s1", kind: "click", selectors: css, frames: ["#f", "#g"] };
		expect(parseRecordedStep({ ...click, frameShadow: [["x-panel"], []] })?.frameShadow).toEqual([["x-panel"], []]);
		expect(parseRecordedStep({ ...click, frameShadow: [[], []] })).not.toHaveProperty("frameShadow");
		for (const frameShadow of ["x", [["x-panel"]], [[""], []], [["a"], "b"]]) {
			expect(parseRecordedStep({ ...click, frameShadow })).toBeNull();
		}
	});
});

describe("dialogs", () => {
	it("reads a pending dialog from the runner", () => {
		expect(parsePendingDialog({ id: 2, type: "prompt", message: "Name?", defaultValue: "x".repeat(300) })).toEqual({
			id: 2,
			type: "prompt",
			message: "Name?",
			defaultValue: "x".repeat(200),
		});
		expect(parsePendingDialog({ id: 1, type: "alert" })).toEqual({
			id: 1,
			type: "alert",
			message: "",
			defaultValue: "",
		});
		for (const raw of [null, "x", { id: 0, type: "alert" }, { id: 1.5, type: "alert" }, { id: 1, type: "evil" }]) {
			expect(parsePendingDialog(raw)).toBeNull();
		}
	});

	it("reads the renderer's answer again (S6)", () => {
		expect(readDialogAnswer({ id: 1, accept: true, text: "Neo" })).toEqual({ id: 1, accept: true, text: "Neo" });
		expect(readDialogAnswer({ id: 3, accept: false })).toEqual({ id: 3, accept: false, text: "" });
		expect(readDialogAnswer({ id: 1, accept: true, text: "a".repeat(2000) })?.text).toHaveLength(1000);
		for (const raw of [
			null,
			7,
			{ id: "1", accept: true },
			{ id: -1, accept: true },
			{ id: 1, accept: "yes" },
			{ id: 1, accept: true, text: 3 },
		]) {
			expect(readDialogAnswer(raw)).toBeNull();
		}
	});
});
