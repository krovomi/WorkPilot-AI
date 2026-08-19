import { describe, expect, it, vi } from "vitest";
import { extractTextFromHtml } from "./utils";

describe("extractTextFromHtml", () => {
	it("returns an empty string for empty input", () => {
		expect(extractTextFromHtml("")).toBe("");
	});

	it("strips tags and keeps the text", () => {
		expect(extractTextFromHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
	});

	it("decodes HTML entities", () => {
		expect(extractTextFromHtml("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
	});

	it("collapses whitespace and trims", () => {
		expect(extractTextFromHtml("<p>  a\n\n   b  </p>")).toBe("a b");
	});

	it("handles plain text without markup", () => {
		expect(extractTextFromHtml("just text")).toBe("just text");
	});

	// Task titles/descriptions arrive from Jira, Linear and GitHub. Parsing them
	// by assigning `div.innerHTML` builds nodes in the LIVE document, which
	// starts real network fetches for `<img src>` even on a detached element.
	// DOMParser documents are inert.
	it("does not load resources or run handlers while parsing", () => {
		const imageSrcs: string[] = [];
		const descriptor = Object.getOwnPropertyDescriptor(
			HTMLImageElement.prototype,
			"src",
		);
		Object.defineProperty(HTMLImageElement.prototype, "src", {
			configurable: true,
			set(value: string) {
				imageSrcs.push(value);
			},
			get() {
				return "";
			},
		});
		const onError = vi.fn();
		(globalThis as unknown as { __xss: () => void }).__xss = onError;

		try {
			const text = extractTextFromHtml(
				'<img src="http://attacker.example/x.png" onerror="__xss()">caption',
			);
			expect(text).toBe("caption");
			expect(imageSrcs).toEqual([]);
			expect(onError).not.toHaveBeenCalled();
		} finally {
			if (descriptor) {
				Object.defineProperty(HTMLImageElement.prototype, "src", descriptor);
			}
		}
	});

	it("is memoized across repeated calls with the same input", () => {
		// The Kanban search filter calls this once per task on every keystroke.
		const html = `<p>${"word ".repeat(200)}</p>`;
		const first = extractTextFromHtml(html);
		const second = extractTextFromHtml(html);
		expect(second).toBe(first);
	});

	it("stays correct past the cache eviction limit", () => {
		for (let i = 0; i < 600; i++) {
			expect(extractTextFromHtml(`<p>item ${i}</p>`)).toBe(`item ${i}`);
		}
		// An early entry has been evicted by now; recomputing must still work.
		expect(extractTextFromHtml("<p>item 0</p>")).toBe("item 0");
	});
});
