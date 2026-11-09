/**
 * The exported tour (#349): the renderer's document is revalidated, and every
 * string read from the repository is written as text, never as markup.
 */
import { describe, expect, it } from "vitest";
import { exportFileName, readExportRequest, toHtml, toMarkdown } from "../export-document";

const DOC = {
	title: "Shop",
	lang: "fr",
	generatedAt: "Généré le 9 novembre 2026",
	sections: [
		{
			heading: "Son module le plus critique",
			intro: "TokenService est le fichier le plus modifié.",
			lines: ["`src/Auth/TokenService.cs` <script>alert(1)</script>", "[click](javascript:alert(1))"],
		},
	],
};

describe("readExportRequest", () => {
	it("keeps a well-formed request", () => {
		expect(readExportRequest({ format: "html", document: DOC })?.document.sections[0].lines).toHaveLength(2);
	});

	it.each([
		[null],
		[{ format: "pdf", document: DOC }],
		[{ format: "html" }],
		[{ format: "html", document: { ...DOC, title: 3 } }],
		[{ format: "html", document: { ...DOC, sections: [{ heading: "x", lines: [42] }] } }],
		[{ format: "markdown", document: { ...DOC, sections: [{ heading: "x", lines: ["a".repeat(1999)] }].concat(Array(60).fill({ heading: "y", lines: Array(400).fill("b".repeat(1999)) })) } }],
	])("refuses %#", (raw) => {
		expect(readExportRequest(raw)).toBeNull();
	});

	it("drops control characters and an unknown language", () => {
		const request = readExportRequest({
			format: "markdown",
			document: { ...DOC, lang: "../x", title: "Sh\u0000op\u001b[31m" },
		});

		expect(request?.document.title).toBe("Shop[31m");
		expect(request?.document.lang).toBe("en");
	});
});

describe("toHtml", () => {
	it("escapes every string and allows no script", () => {
		const html = toHtml(DOC);

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("<code>src/Auth/TokenService.cs</code>");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain('<html lang="fr">');
		expect(html).not.toMatch(/<a\s/);
	});
});

describe("toMarkdown", () => {
	it("writes inline HTML and links as text", () => {
		const markdown = toMarkdown(DOC);

		expect(markdown).toContain("# Shop");
		expect(markdown).toContain("## Son module le plus critique");
		expect(markdown).toContain("&lt;script&gt;");
		expect(markdown).toContain("\\[click\\](javascript");
		expect(markdown).toContain("- `src/Auth/TokenService.cs`");
	});
});

describe("exportFileName", () => {
	it("is a plain file name whatever the project is called", () => {
		expect(exportFileName("../../etc/Shop App", "html")).toBe("etc-Shop-App-onboarding.html");
		expect(exportFileName("", "markdown")).toBe("onboarding-onboarding.md");
	});
});
