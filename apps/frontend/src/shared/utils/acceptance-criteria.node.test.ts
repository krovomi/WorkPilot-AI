/**
 * @vitest-environment node
 *
 * These helpers are imported by the Electron MAIN process — plain Node, no
 * DOM (see project-store.ts and ipc-handlers/azure-devops-handlers.ts). The
 * repo-wide vitest environment is jsdom and tsconfig ships `"lib": ["DOM"]`,
 * so a browser-only API such as `DOMParser` type-checks and passes the normal
 * suite while throwing `ReferenceError` in production. This file pins the
 * Node contract; keep it in the `node` environment.
 */

import { describe, expect, it } from "vitest";

import {
	decodeHtmlEntities,
	parseAcceptanceCriteriaText,
	stripAcceptanceCriteriaSection,
	stripHtmlTags,
} from "./acceptance-criteria";

describe("acceptance-criteria helpers under Node (no DOM)", () => {
	it("really is running without a DOM", () => {
		// Guards the guard: if the environment docblock is ever dropped, the
		// assertions below would silently start passing for the wrong reason.
		expect(typeof globalThis.DOMParser).toBe("undefined");
		expect(typeof globalThis.document).toBe("undefined");
	});

	it("strips an AC section without touching any DOM API", () => {
		const html =
			"<p>Contexte.</p><h3>Critères d’acceptation</h3><ul><li>a</li></ul>";
		expect(stripAcceptanceCriteriaSection(html)).toBe("<p>Contexte.</p>");
	});

	it("matches a heading whose text arrives HTML-encoded", () => {
		// AzDO commonly returns "Crit&egrave;res d&rsquo;acceptation".
		const html =
			"<p>Intro.</p><h2>Crit&egrave;res d&rsquo;acceptation</h2><ol><li>x</li></ol>";
		expect(stripAcceptanceCriteriaSection(html)).toBe("<p>Intro.</p>");
	});

	it("parses criteria out of encoded HTML", () => {
		const html = "<ol><li>Caf&eacute; &amp; th&eacute;</li><li>R&#233;sultat</li></ol>";
		expect(parseAcceptanceCriteriaText(html)).toEqual([
			"Café & thé",
			"Résultat",
		]);
	});
});

describe("stripHtmlTags", () => {
	it("removes ordinary tags", () => {
		expect(stripHtmlTags("<p>hello <b>world</b></p>")).toBe("hello world");
	});

	it("guarantees no tag-shaped substring survives", () => {
		// This is the actual sanitization contract, and what the fixed-point
		// loop buys over a single pass: whatever the nesting, the output can
		// never still contain something a downstream consumer reads as a tag.
		for (const nasty of [
			"<<a>script>alert(1)<</a>/script>",
			"<scri<script>pt>alert(1)</script>",
			"<<>>",
		]) {
			expect(stripHtmlTags(nasty)).not.toMatch(/<[^>]+>/);
		}
	});

	it("is idempotent", () => {
		const once = stripHtmlTags("<<a>script>x<</a>/script>");
		expect(stripHtmlTags(once)).toBe(once);
	});

	it("also eats a bare '<'…'>' span in prose (known regex limitation)", () => {
		// A regex stripper cannot tell "less than" from a tag; "< 2 and 3 >"
		// looks exactly like one. Pre-existing behaviour, kept deliberately —
		// the only alternative is a real HTML parser, which this module cannot
		// use because it runs in the Electron main process.
		expect(stripHtmlTags("1 < 2 and 3 > 2")).toBe("1  2");
	});
});

describe("decodeHtmlEntities", () => {
	it("decodes named, decimal and hex entities", () => {
		expect(decodeHtmlEntities("&eacute;&#233;&#xe9;")).toBe("ééé");
	});

	it("decodes in a single pass so &amp;lt; stays &lt;", () => {
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
	});

	it("leaves unknown entities verbatim", () => {
		expect(decodeHtmlEntities("&notarealentity; &zzz;")).toBe(
			"&notarealentity; &zzz;",
		);
	});

	it("does not throw on out-of-range code points", () => {
		expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
	});
});
