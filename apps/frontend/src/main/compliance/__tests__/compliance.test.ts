/**
 * The compliance exports, the monthly run and the config check of #357.
 *
 * The CSV defuses formulas and the HTML escapes every string the renderer
 * worded; the monthly run makes last month's report once, announces only the
 * controls alerted, and never reads a config through a link.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), ipcMain: { handle: vi.fn() }, app: {} }));

import { alertText, checkMonthly, readConfig, monthlyDue, previousMonth, readMonthlyConfig } from "../monthly";
import { readDocument, readFormat, toCsv, toHtml } from "../report-export";

const DOC = {
	title: "Rapport <SOC 2>",
	summary: ["1 contrôle couvert", 3],
	tables: [
		{ title: "Preuves", columns: ["Quoi", "Source"], rows: [["=HYPERLINK(\"x\")", "<img src=x onerror=alert(1)>", "extra"]] },
	],
};

describe("report-export", () => {
	it("reads only the known formats and fields", () => {
		expect(["json", "csv", "html", "pdf", "exe"].map(readFormat)).toEqual(["json", "csv", "html", "pdf", null]);
		const doc = readDocument(DOC);
		expect(doc.summary).toEqual(["1 contrôle couvert", "3"]);
		expect(doc.tables[0].rows[0]).toHaveLength(2);
		expect(readDocument(null).title).toBe("Compliance report");
	});

	it("defuses spreadsheet formulas in the CSV", () => {
		const csv = toCsv(DOC);
		expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
		expect(csv.split("\r\n")[1]).toBe('"Quoi","Source"');
	});

	it("escapes the HTML and allows no script", () => {
		const html = toHtml(DOC, "fr");
		expect(html).toContain('<html lang="fr">');
		expect(html).toContain("Rapport &lt;SOC 2&gt;");
		expect(html).not.toContain("<img");
		expect(html).toContain("default-src 'none'");
		expect(toHtml(DOC, '"><script>')).toContain('<html lang="en">');
	});
});

describe("monthly", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "compliance-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const config = (data: unknown) => {
		mkdirSync(path.join(root, ".workpilot", "compliance", "reports"), { recursive: true });
		writeFileSync(path.join(root, ".workpilot", "compliance", "config.json"), JSON.stringify(data));
	};

	it("names the month just ended, across a year", () => {
		expect(previousMonth(new Date(Date.UTC(2026, 11, 1, 6)))).toBe("2026-11");
		expect(previousMonth(new Date(Date.UTC(2027, 0, 1, 6)))).toBe("2026-12");
	});

	it("is due until every chosen framework has last month's report", () => {
		const now = new Date(Date.UTC(2026, 11, 1));
		expect(monthlyDue(root, now)).toBe(false);
		config({ frameworks: ["soc2", "../x", 3], monthly: true });
		expect(readMonthlyConfig(root)).toEqual({ frameworks: ["soc2"], monthly: true });
		expect(monthlyDue(root, now)).toBe(true);
		writeFileSync(path.join(root, ".workpilot", "compliance", "reports", "soc2-2026-11.json"), "{}");
		expect(monthlyDue(root, now)).toBe(false);
	});

	it("never reads a config bigger than its cap", () => {
		config({ frameworks: ["soc2"], monthly: true, pad: "x".repeat(17 * 1024) });
		expect(readMonthlyConfig(root)).toBeNull();
	});

	it("never reads a linked compliance folder", () => {
		const elsewhere = mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
		writeFileSync(path.join(elsewhere, "config.json"), JSON.stringify({ frameworks: ["soc2"], monthly: true }));
		mkdirSync(path.join(root, ".workpilot"));
		symlinkSync(elsewhere, path.join(root, ".workpilot", "compliance"));
		expect(readMonthlyConfig(root)).toBeNull();
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("runs the due projects and announces only the alerted controls", async () => {
		config({ frameworks: ["soc2", "iso27001"], monthly: true });
		const announce = vi.fn();
		const run = vi.fn().mockResolvedValue({
			made: [
				{ name: "soc2-2026-11.json", framework: { id: "soc2", name: "SOC 2" }, period: "2026-11", coveragePercent: 60, alerts: [{ controlId: "CC7.4" }] },
				{ name: "iso27001-2026-11.json", framework: { id: "iso27001", name: "ISO" }, period: "2026-11", coveragePercent: 100, alerts: [] },
			],
		});
		const made = await checkMonthly({
			projects: () => [
				{ id: "p1", name: "Shop", path: root },
				{ id: "p2", name: "Unknown", path: "/nowhere" },
			],
			resolve: (p) => (p === root ? root : null),
			run,
			announce,
			language: () => "fr",
			now: () => new Date(Date.UTC(2026, 11, 1)),
		});
		expect(made).toBe(2);
		expect(run).toHaveBeenCalledTimes(1);
		expect(announce).toHaveBeenCalledTimes(1);
		expect(announce.mock.calls[0][1]).toEqual({
			title: "Conformité : Shop",
			body: "SOC 2 2026-11 : 60 % des contrôles couverts, 1 sans preuve depuis plus de 30 jours (CC7.4).",
		});
		expect(alertText("en", "Shop", { name: "", framework: { id: "x", name: "X" }, period: "p", coveragePercent: 1, alerts: [] }).title).toBe(
			"Compliance: Shop",
		);
	});
});

describe("readConfig", () => {
	it("keeps only a config of the known shape", () => {
		expect(readConfig({ frameworks: ["soc2"], monthly: true })).toEqual({ frameworks: ["soc2"], monthly: true });
		expect(readConfig({ frameworks: ["soc2"], monthly: "yes" })).toEqual({ frameworks: ["soc2"], monthly: false });
		expect(readConfig({ frameworks: ["--load"] })).toBeNull();
		expect(readConfig({ frameworks: "soc2" })).toBeNull();
		expect(readConfig(null)).toBeNull();
	});
});
