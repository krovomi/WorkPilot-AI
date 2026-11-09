/**
 * The exported report escapes everything the renderer sent (#391): the HTML
 * cannot carry markup or script, the CSV cannot carry a spreadsheet formula.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: vi.fn() }));

import { readReport, renderCsv, renderHtml } from "../report-export";

const report = {
	score: 87.4,
	targetLevel: "AA",
	filesScanned: 12,
	criteria: [{ criterion: "1.1.1", name: "Non-text content", count: 1, score: 91 }],
	violations: [
		{
			severity: "critical",
			ruleId: "img-alt",
			wcagCriteria: "1.1.1",
			wcagLevel: "A",
			description: "Image without a text alternative",
			file: "src/App.tsx",
			line: 4,
			element: '<img src="x" onerror="alert(1)">',
			suggestion: "=HYPERLINK(\"http://evil\")",
		},
	],
};

describe("report export", () => {
	it("reads only the fields it prints", () => {
		const read = readReport({ ...report, extra: "<script>" });
		expect(read.score).toBe(87);
		expect(read.rows[0].location).toBe("src/App.tsx:4");
		expect(readReport("nope").rows).toEqual([]);
	});

	it("escapes the HTML and allows no script", () => {
		const html = renderHtml(report, "<b>Report</b>", "2026-11-09 20:00");
		expect(html).not.toContain('<img src="x"');
		expect(html).toContain("&lt;img src=&quot;x&quot;");
		expect(html).toContain("&lt;b&gt;Report&lt;/b&gt;");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("87");
	});

	it("quotes every CSV cell and defuses formulas", () => {
		const csv = renderCsv(report);
		const [header, row] = csv.trim().split("\r\n");
		expect(header.split(",")).toHaveLength(8);
		expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
	});
});
