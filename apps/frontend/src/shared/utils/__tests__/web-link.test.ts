import { describe, expect, it } from "vitest";
import { webLink } from "../web-link";

describe("webLink", () => {
	it("keeps an http(s) URL, in its parsed form", () => {
		expect(webLink("https://github.com/acme/shop/pull/3")).toBe("https://github.com/acme/shop/pull/3");
		expect(webLink("http://gitlab.local/acme/shop/-/merge_requests/4")).toBe(
			"http://gitlab.local/acme/shop/-/merge_requests/4",
		);
		expect(webLink("HTTPS://GitHub.com/a")).toBe("https://github.com/a");
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,<b>x</b>",
		"file:///etc/hosts",
		"vbscript:x",
		"not a url",
		"//github.com/acme",
	])("renders %s as no link", (url) => {
		expect(webLink(url)).toBeNull();
	});

	it("has nothing to render without a URL", () => {
		expect(webLink(undefined)).toBeNull();
		expect(webLink(null)).toBeNull();
		expect(webLink("")).toBeNull();
	});
});
