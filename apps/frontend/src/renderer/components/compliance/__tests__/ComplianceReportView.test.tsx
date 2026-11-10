/** @vitest-environment jsdom */
/**
 * The compliance page of #357, in French: the frameworks of the project, the
 * report of a month (summary, gaps with their recommendation, evidence by
 * control), the monthly switch, the saved reports and the export worded in
 * the app's language.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { ComplianceReport } from "../../../../shared/types/compliance";
import { useComplianceStore } from "../../../stores/compliance-store";
import { ComplianceReportView } from "../ComplianceReportView";

const SOC2 = { id: "soc2", name: "SOC 2", version: "TSC 2017 (2022)", controls: 2, source: "bundled" };

const REPORT: ComplianceReport = {
	version: 1,
	framework: SOC2,
	period: { label: "2026-10", start: "2026-10-01T00:00:00+00:00", end: "2026-10-31T23:59:59+00:00" },
	generatedAt: "2026-11-01T08:00:00+00:00",
	coveragePercent: 50,
	summary: {
		controls: 2, covered: 1, failing: 0, stale: 0, missing: 1, alerts: 1, evidence: 3,
		byKind: { merge: 2, tests: 1 }, specApprovals: 1, reviewsApproved: 1, reviewsRejected: 0,
		testsPassed: 1, testsFailed: 0, securityFindings: 0, tasks: 1,
	},
	risks: ["CC7.4"],
	gaps: [
		{
			controlId: "CC7.4",
			title: { en: "Security incidents are responded to", fr: "Réponse aux incidents de sécurité" },
			status: "missing",
			ageDays: null,
			alert: true,
			missingKinds: ["incident", "procedure"],
			recommendation: { en: "Write a procedure.", fr: "Écrire une procédure." },
		},
	],
	controls: [
		{
			id: "CC8.1",
			title: { en: "Changes are approved", fr: "Changements approuvés" },
			requirements: [["merge"], ["tests"]],
			maxAgeDays: 30,
			recommendation: {},
			status: "covered",
			checks: [
				{ kinds: ["merge"], status: "covered", lastEvidenceAt: "2026-10-20T10:00:00+00:00", ageDays: 11, count: 2 },
				{ kinds: ["tests"], status: "covered", lastEvidenceAt: "2026-10-21T10:00:00+00:00", ageDays: 10, count: 1 },
			],
			lastEvidenceAt: "2026-10-21T10:00:00+00:00",
			ageDays: 10,
			alert: false,
			periodCount: 3,
			failures: 0,
			evidence: [
				{ kind: "merge", at: "2026-10-20T10:00:00+00:00", title: "=HYPERLINK(x)", source: "commit abc", outcome: "pass", actor: "Ana" },
			],
		},
		{
			id: "CC7.4",
			title: { en: "Security incidents are responded to", fr: "Réponse aux incidents de sécurité" },
			requirements: [["incident", "procedure"]],
			maxAgeDays: 365,
			recommendation: { en: "Write a procedure.", fr: "Écrire une procédure." },
			status: "missing",
			checks: [{ kinds: ["incident", "procedure"], status: "missing", lastEvidenceAt: null, ageDays: null, count: 0 }],
			lastEvidenceAt: null,
			ageDays: null,
			alert: true,
			periodCount: 0,
			failures: 0,
			evidence: [],
		},
	],
	warnings: [],
};

const api = {
	runComplianceScan: vi.fn(),
	cancelComplianceScan: vi.fn(),
	getComplianceFrameworks: vi.fn(),
	listComplianceReports: vi.fn(),
	loadComplianceReport: vi.fn(),
	saveComplianceConfig: vi.fn(),
	exportComplianceReport: vi.fn(),
	onComplianceEvent: vi.fn(() => () => {}),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	api.getComplianceFrameworks.mockResolvedValue({
		frameworks: [SOC2, { ...SOC2, id: "iso27001", name: "ISO/IEC 27001", version: "2022" }],
		config: { frameworks: [], monthly: false },
		errors: ["…/frameworks/broken.yaml: unknown evidence kind: telepathy"],
	});
	api.listComplianceReports.mockResolvedValue({
		reports: [{ name: "soc2-2026-09.json", framework: "soc2", period: "2026-09", generatedAt: null, coveragePercent: 40, gaps: 3, alerts: 2 }],
	});
	useComplianceStore.setState({ framework: "soc2", period: "", catalog: null, reports: [], report: null, phase: "idle", error: null });
	await i18n.changeLanguage("fr");
});

afterEach(cleanup);

describe("ComplianceReportView", () => {
	it("lists the project's frameworks, its skipped files and its saved reports", async () => {
		render(<ComplianceReportView projectPath="/repo" />);
		expect(await screen.findByText("ISO/IEC 27001")).toBeInTheDocument();
		expect(screen.getByText(/broken\.yaml/)).toBeInTheDocument();
		expect(screen.getByText("2026-09")).toBeInTheDocument();
		expect(screen.getByText("40 % couverts · 3 écart(s)")).toBeInTheDocument();
		expect(api.getComplianceFrameworks).toHaveBeenCalledWith("/repo");
	});

	it("runs a month and shows the summary, the gaps and the evidence in French", async () => {
		api.runComplianceScan.mockResolvedValue(REPORT);
		render(<ComplianceReportView projectPath="/repo" />);
		await screen.findByText("ISO/IEC 27001");
		fireEvent.change(screen.getByLabelText("Mois"), { target: { value: "2026-10" } });
		fireEvent.click(screen.getByRole("button", { name: /Collecter les preuves/ }));
		await screen.findByText("SOC 2 · 2026-10");
		expect(api.runComplianceScan).toHaveBeenCalledWith({ projectPath: "/repo", framework: "soc2", period: "2026-10", save: false });
		expect(screen.getByText(/1 contrôles couverts sur 2 \(50 %\), 1 écart\(s\), 1 sans preuve/)).toBeInTheDocument();
		expect(screen.getByText("Risques : CC7.4.")).toBeInTheDocument();
		expect(screen.getByText("Écrire une procédure.")).toBeInTheDocument();
		expect(screen.getByText(/Aucune preuve trouvée · Il manque : Incident, Procédure/)).toBeInTheDocument();
		expect(screen.getAllByText(/Réponse aux incidents de sécurité/).length).toBeGreaterThan(0);
		expect(screen.getByText(/Fusion relue · =HYPERLINK\(x\) · Ana/)).toBeInTheDocument();
	});

	it("turns the monthly report on for the framework shown", async () => {
		api.saveComplianceConfig.mockResolvedValue({ config: { frameworks: ["soc2"], monthly: true } });
		render(<ComplianceReportView projectPath="/repo" />);
		const box = await screen.findByLabelText(/Rapport mensuel pour ce référentiel/);
		fireEvent.click(box);
		await waitFor(() => expect(box).toBeChecked());
		expect(api.saveComplianceConfig).toHaveBeenCalledWith("/repo", { frameworks: ["soc2"], monthly: true });
	});

	it("exports the report worded in French", async () => {
		api.exportComplianceReport.mockResolvedValue("/tmp/soc2-2026-10.pdf");
		useComplianceStore.setState({ report: REPORT, phase: "complete" });
		render(<ComplianceReportView projectPath="/repo" />);
		fireEvent.click(screen.getByRole("button", { name: "PDF" }));
		await screen.findByText("Enregistré dans /tmp/soc2-2026-10.pdf");
		const request = api.exportComplianceReport.mock.calls[0][0];
		expect(request.format).toBe("pdf");
		expect(request.language).toBe("fr");
		expect(request.document.title).toBe("Rapport de conformité : SOC 2, 2026-10");
		const [controls, gaps, evidence] = request.document.tables;
		expect(controls.rows[1]).toEqual(["CC7.4", "Réponse aux incidents de sécurité", "Manquant", "—", "0"]);
		expect(gaps.rows[0][3]).toBe("Écrire une procédure.");
		expect(evidence.rows[0][3]).toBe("=HYPERLINK(x)"); // defused by main, not here
	});

	it("opens a saved report", async () => {
		api.loadComplianceReport.mockResolvedValue(REPORT);
		render(<ComplianceReportView projectPath="/repo" />);
		fireEvent.click(await screen.findByText("2026-09"));
		await screen.findByText("SOC 2 · 2026-10");
		expect(api.loadComplianceReport).toHaveBeenCalledWith("/repo", "soc2-2026-09.json");
	});
});
