/**
 * The generated file as it streams in: coloured for every language the
 * generator writes, revealed like typing unless motion is reduced.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveCode, lineCount, tokenize } from "../LiveCode";

const classesOf = (line: string) =>
	Object.fromEntries(tokenize(line).filter((tok) => tok.c).map((tok) => [tok.t, tok.c]));

describe("tokenize", () => {
	it.each([
		["// a comment", "tg-tok-comment"],
		["# a Python comment", "tg-tok-comment"],
	])("reads %j as a comment", (line, cls) => {
		expect(tokenize(line)).toEqual([{ t: line, c: cls }]);
	});

	it("tells keywords, types, strings, numbers, attributes and punctuation apart", () => {
		expect(classesOf(`public void Adds_2() { Assert.Equal("4", 2_0); }`)).toMatchObject({
			public: "tg-tok-keyword",
			void: "tg-tok-keyword",
			Adds_2: "tg-tok-type",
			Assert: "tg-tok-type",
			Equal: "tg-tok-type",
			'"4"': "tg-tok-string",
			"2_0": "tg-tok-number",
			"()": "tg-tok-punct",
		});
		expect(classesOf("[Fact] @Test 'x' `y` value")).toMatchObject({
			"[Fact]": "tg-tok-attr",
			"@Test": "tg-tok-attr",
			"'x'": "tg-tok-string",
			"`y`": "tg-tok-string",
			value: "tg-tok-text",
		});
	});

	it("keeps a string or an attribute that follows punctuation", () => {
		expect(classesOf(`check("ok");`)).toMatchObject({ '"ok"': "tg-tok-string", "(": "tg-tok-punct" });
		expect(classesOf("{[Fact]")).toMatchObject({ "{": "tg-tok-punct", "[Fact]": "tg-tok-attr" });
		expect(classesOf("a / b")).toMatchObject({ "/": "tg-tok-punct" });
		// An unterminated quote is still shown.
		expect(tokenize(`x = "open`).map((tok) => tok.t).join("")).toBe(`x = "open`);
	});

	it("colours a Rust attribute as an attribute, not as a comment", () => {
		expect(tokenize("#[test]")).toEqual([{ t: "#[test]", c: "tg-tok-attr" }]);
	});

	it("keeps a decrement as code", () => {
		expect(classesOf("for (i = n; i > 0; i--) { total += i; }")).toMatchObject({
			for: "tg-tok-keyword",
			total: "tg-tok-text",
		});
	});

	it("leaves a very long line uncoloured", () => {
		const line = "x".repeat(2001);
		expect(tokenize(line)).toEqual([{ t: line, c: "tg-tok-text" }]);
	});
});

describe("lineCount", () => {
	it("counts the lines shown", () => {
		expect(lineCount("")).toBe(0);
		expect(lineCount("a\nb\nc")).toBe(3);
	});
});

describe("LiveCode", () => {
	let frames: FrameRequestCallback[];

	beforeEach(() => {
		frames = [];
		vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const tick = () =>
		act(() => {
			const pending = frames;
			frames = [];
			for (const cb of pending) cb(0);
		});

	it("shows the placeholder while nothing has arrived", () => {
		render(<LiveCode code="" streaming={false} placeholder={<span>waiting</span>} />);
		expect(screen.getByText("waiting")).toBeInTheDocument();
	});

	it("shows a finished file at once, numbered, without a caret", () => {
		render(<LiveCode code={"def test_a():\n    assert 1"} streaming={false} placeholder={null} />);
		const code = screen.getByTestId("test-studio-code");
		expect(code).toHaveTextContent("1def test_a():2 assert 1");
		expect(code.querySelector(".tg-caret")).toBeNull();
	});

	it("types a streaming file in and follows it", () => {
		const code = "x".repeat(60);
		render(<LiveCode code={code} streaming placeholder={<span>waiting</span>} />);
		expect(screen.getByText("waiting")).toBeInTheDocument();

		tick();
		const shown = () => screen.getByTestId("test-studio-code").querySelector(".tg-code-text")?.textContent ?? "";
		expect(shown().length).toBe(10);
		expect(screen.getByTestId("test-studio-code").querySelector(".tg-caret")).not.toBeNull();

		for (let i = 0; i < 20; i++) tick();
		expect(shown()).toBe(code);
	});

	it("shows everything at once when motion is reduced", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		render(<LiveCode code="let a = 1" streaming placeholder={null} />);
		expect(screen.getByTestId("test-studio-code")).toHaveTextContent("let a = 1");
	});

	it("shows the whole file once the stream ends", () => {
		const { rerender } = render(<LiveCode code={"y".repeat(40)} streaming placeholder={null} />);
		tick();
		rerender(<LiveCode code={"y".repeat(40)} streaming={false} placeholder={null} />);
		expect(screen.getByTestId("test-studio-code")).toHaveTextContent("y".repeat(40));
	});
});
