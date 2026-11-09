/** @vitest-environment jsdom */
/**
 * The drift page of #354, in French: gaps grouped by family and worded from
 * their values, the freshness of each document, the fixes made on a review
 * card (never for a server project) and the export worded in the app's language.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { DriftReport } from "../../../../shared/types/doc-drift";
import { useDocDriftStore } from "../../../stores/doc-drift-store";
import { useProjectStore } from "../../../stores/project-store";
import { DocDriftReport } from "../DocDriftReport";

vi.mock("../../../hooks/useSharedAnalysisReport", () => ({ useSharedAnalysisReport: () => null }));

const RENAME = "rename:src/cart.ts:6:qty:quantity";
const REPORT: DriftReport = {
	docsScanned: 3,
	codeFilesIndexed: 10,
	issues: [
		{
			driftType: "signature_mismatch",
			severity: "high",
			docFile: "src/cart.ts",
			docLine: 6,
			referencedSymbol: "addItem",
			message: "m",
			suggestion: "s",
			params: { old: "qty", new: "quantity" },
			fixId: RENAME,
		},
		{
			driftType: "stale_doc",
			severity: "medium",
			docFile: "docs/cart.md",
			docLine: 1,
			referencedSymbol: "src/cart.ts",
			message: "m",
			suggestion: "s",
			params: { files: "src/cart.ts", count: 1, days: 60 },
			files: ["src/cart.ts"],
		},
		{
			driftType: "example_import",
			severity: "high",
			docFile: "README.md",
			docLine: 12,
			referencedSymbol: "shop.basket",
			message: "m",
			suggestion: "s",
		},
	],
	summary: "",
	freshness: [
		{ docFile: "docs/cart.md", score: 70, locale: "", issues: 1 },
		{ docFile: "docs/cart.fr.md", score: 90, locale: "fr", issues: 0 },
		{ docFile: "README.md", score: 80, locale: "", issues: 1 },
	],
	averageFreshness: 80,
	fixable: 1,
	git: true,
};

const api = {
	runDocDriftScan: vi.fn(),
	cancelDocDriftScan: vi.fn(),
	fixDocDrift: vi.fn(),
	exportDocDrift: vi.fn(),
	getSharedAnalysisReport: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useDocDriftStore.getState().reset();
	useDocDriftStore.getState().setReport(REPORT);
	useProjectStore.setState({ projects: [{ id: "p1", path: "/repo" }] as never, activeProjectId: "p1" });
	await i18n.changeLanguage("fr");
});

afterEach(async () => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	await i18n.changeLanguage("en");
});

describe("the drift page of #354", () => {
	it("groups the gaps by family and words them from their values", () => {
		render(<DocDriftReport projectPath="/repo" />);
		fireEvent.click(screen.getByRole("button", { name: "Pas à jour · 1" }));
		expect(screen.queryByText("addItem")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /src\/cart\.ts/ }));
		expect(
			screen.getByText("1 fichier que ce document décrit a changé après lui, il y a 60 jours : src/cart.ts."),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Commentaires de doc · 1" }));
		fireEvent.click(screen.getByRole("button", { name: /addItem/ }));
		expect(
			screen.getByText("Le commentaire de doc de « addItem » nomme encore « qty », renommé « quantity » dans le code."),
		).toBeInTheDocument();
	});

	it("shows the freshness of the least fresh documents", () => {
		render(<DocDriftReport projectPath="/repo" />);
		expect(screen.getByText("80/100 en moyenne")).toBeInTheDocument();
		expect(screen.getByText("docs/cart.md")).toBeInTheDocument();
		expect(screen.getByText("fr")).toBeInTheDocument();
	});

	it("makes the ticked fixes on a review card", async () => {
		api.fixDocDrift.mockResolvedValue({
			applied: [{ fixId: RENAME, kind: "rename", file: "src/cart.ts", line: 6 }],
			missing: [],
			review: { branch: "workpilot/004-docs" },
		});
		render(<DocDriftReport projectPath="/repo" />);
		fireEvent.click(screen.getByRole("button", { name: /addItem/ }));
		fireEvent.click(screen.getByLabelText("Corrigeable"));
		fireEvent.click(screen.getByRole("button", { name: "Corriger 1 sur une carte de revue" }));
		await waitFor(() => expect(api.fixDocDrift).toHaveBeenCalledWith({ projectPath: "/repo", fixIds: [RENAME] }));
		expect(
			await screen.findByText(/1 correction faite sur la branche workpilot\/004-docs/),
		).toBeInTheDocument();
	});

	it("never offers the fixes of a server project", () => {
		useProjectStore.setState({ projects: [{ id: "p1", path: "/repo", remote: true }] as never });
		render(<DocDriftReport projectPath="/repo" />);
		expect(screen.getByRole("button", { name: "Corriger 0 sur une carte de revue" })).toBeDisabled();
		expect(screen.getAllByText(/ne sont pas sur cet ordinateur/).length).toBeGreaterThan(0);
	});

	it("exports a page worded in the app's language", async () => {
		api.exportDocDrift.mockResolvedValue("/tmp/doc-drift-report.html");
		render(<DocDriftReport projectPath="/repo" />);
		fireEvent.click(screen.getByRole("button", { name: "Exporter en HTML" }));
		await waitFor(() => expect(api.exportDocDrift).toHaveBeenCalled());
		const { format, document } = api.exportDocDrift.mock.calls[0][0];
		expect(format).toBe("html");
		expect(document.title).toBe("Dérive de la documentation");
		expect(document.tables[0].rows[2]).toEqual([
			"Élevée",
			"Exemple qui importe ce qui n'existe plus",
			"README.md:12",
			"Un exemple de code importe « shop.basket », que le projet n'a plus.",
			"Importer ce que le projet propose aujourd'hui.",
		]);
		expect(await screen.findByText("Enregistré dans /tmp/doc-drift-report.html")).toBeInTheDocument();
	});
});
