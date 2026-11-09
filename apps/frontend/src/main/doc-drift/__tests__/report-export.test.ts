/**
 * The drift report export (#354): JSON keeps only the report's known fields,
 * HTML escapes every string the renderer sent and allows no script.
 */
import { describe, expect, it } from "vitest";
import { readFormat, toHtml, toJson } from "../report-export";

describe("doc drift export", () => {
	it("keeps the machine fields of the report in JSON, nothing else", () => {
		const data = JSON.parse(
			toJson({
				docsScanned: 2,
				averageFreshness: 80,
				issues: [{ driftType: "stale_doc", severity: "low", docFile: "README.md", docLine: 1, extra: "x" }],
				freshness: [{ docFile: "README.md", score: 80, locale: "fr" }],
				secret: "token",
			}),
		);
		expect(data.issues).toEqual([
			{ driftType: "stale_doc", severity: "low", file: "README.md", line: 1, symbol: "", message: "" },
		]);
		expect(data.freshness[0]).toMatchObject({ file: "README.md", score: 80, locale: "fr" });
		expect(JSON.stringify(data)).not.toContain("token");
	});

	it("escapes the HTML page and forbids scripts", () => {
		const html = toHtml({
			title: "Dérive <b>",
			summary: "ok",
			tables: [{ title: "Écarts", columns: ["Où"], rows: [["<img src=x onerror=alert(1)>"]] }],
		});
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img");
		expect(html).toContain("<title>Dérive &lt;b&gt;</title>");
	});

	it("knows only JSON and HTML", () => {
		expect(readFormat("json")).toBe("json");
		expect(readFormat("html")).toBe("html");
		expect(readFormat("pdf")).toBeNull();
	});
});
