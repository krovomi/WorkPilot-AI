/** @vitest-environment jsdom */
/**
 * Generational tests: a generation comes from a run of the project's own
 * suite (any stack) or from a report of any format, imported or pasted.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useGenTestsStore } from "../../../stores/phase35-stores";
import { defaultLabel, describeGenError, GenTestsPanel } from "../GenTestsPanel";

const GENERATION = {
	label: "release-1",
	captured_at: 1_763_000_000,
	source: "run:dotnet test Shop.sln",
	total: 12,
	passed: 10,
	failed: 1,
	error: 0,
	skipped: 1,
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	api = {
		listGenerations: vi.fn().mockResolvedValue({ success: true, generations: ["release-1"], details: [GENERATION] }),
		detectGenTestCommands: vi.fn().mockResolvedValue({
			success: true,
			commands: [{ id: "dotnet", label: "C# / .NET", command: "dotnet test Shop.sln" }],
		}),
		runGenTests: vi.fn().mockResolvedValue({ success: true, command: "dotnet test Shop.sln", label: "x" }),
		captureGeneration: vi.fn().mockResolvedValue({ success: true, format: "trx", label: "x" }),
		compareGeneration: vi.fn(),
		importGenTestsReport: vi.fn().mockResolvedValue({ success: true, name: "results.trx", content: "<TestRun/>" }),
		cancelGenTests: vi.fn().mockResolvedValue(true),
		deleteGeneration: vi.fn().mockResolvedValue({ success: true, deleted: true }),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
	cleanup();
	useGenTestsStore.getState().reset();
});

describe("GenTestsPanel", () => {
	it("runs the detected command of the project and captures it", async () => {
		render(<GenTestsPanel projectPath="/p" />);
		expect(await screen.findByText("dotnet test Shop.sln")).toBeInTheDocument();
		const row = within(screen.getByRole("listitem"));
		expect(row.getByText("release-1")).toBeInTheDocument();
		expect(row.getByText("10 réussis")).toBeInTheDocument();
		expect(row.getByText("1 en échec")).toBeInTheDocument();
		expect(row.getByText("exécution de dotnet test Shop.sln")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Nom de la génération"), { target: { value: "avant-refacto" } });
		fireEvent.click(screen.getByRole("button", { name: "Lancer et capturer" }));
		await waitFor(() => expect(api.runGenTests).toHaveBeenCalledWith("/p", "capture", "avant-refacto", "auto"));
	});

	it("imports a report file and captures it, whatever its format", async () => {
		render(<GenTestsPanel projectPath="/p" />);
		fireEvent.click(await screen.findByRole("tab", { name: "Importer ou coller un rapport" }));
		fireEvent.click(screen.getByRole("button", { name: "Importer un fichier…" }));
		expect(await screen.findByText("results.trx")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Capturer ce rapport" }));
		await waitFor(() => expect(api.captureGeneration).toHaveBeenCalledWith("/p", expect.any(String), "<TestRun/>"));
		expect(await screen.findByText("Dernier rapport lu : TRX (.NET)")).toBeInTheDocument();
	});

	it("offers a report when the project has no test command", async () => {
		api.detectGenTestCommands.mockResolvedValue({ success: true, commands: [] });
		render(<GenTestsPanel projectPath="/p" />);
		expect(await screen.findByText(/Aucune commande de test n'a été détectée/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Lancer et capturer" })).toBeDisabled();
	});

	it("refuses a label the archive would refuse", async () => {
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("dotnet test Shop.sln");
		fireEvent.change(screen.getByLabelText("Nom de la génération"), { target: { value: "../x" } });
		expect(screen.getByRole("button", { name: "Lancer et capturer" })).toBeDisabled();
	});

	it("shows a comparison's regressions in French", async () => {
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("dotnet test Shop.sln");
		useGenTestsStore.setState({
			phase: "ok",
			regression: {
				baseline_label: "release-1",
				current_captured_at: 0,
				regression_count: 1,
				summary: { regressed: 1, vanished: 0, slowed_down: 0, new_failure: 0, added: 0 },
				items: [
					{
						test_id: "Shop.Tests.CartTests::Adds",
						kind: "regressed",
						baseline_status: "passed",
						current_status: "failed",
						baseline_duration: 0.01,
						current_duration: 0.02,
						detail: "Expected 1 but was 2",
					},
				],
			},
		});
		expect(await screen.findByText("Comparaison avec release-1")).toBeInTheDocument();
		expect(screen.getByText("régressé")).toBeInTheDocument();
		expect(screen.getByText("Expected 1 but was 2")).toBeInTheDocument();
	});
});

describe("describeGenError", () => {
	const t = i18n.getFixedT("fr", "phase35");

	it("translates a report code and a run code, keeping the run's output", () => {
		expect(describeGenError("report.unknown_format", t).message).toMatch(/format reconnu/);
		const run = describeGenError("no_results: dotnet test Shop.sln (exit code 1)\nerror CS1002", t);
		expect(run.message).toMatch(/aucun résultat de test/);
		expect(run.detail).toContain("error CS1002");
	});
});

describe("defaultLabel", () => {
	it("is a valid label made of the date", () => {
		expect(defaultLabel(new Date(2026, 10, 14, 9, 5))).toBe("gen-20261114-0905");
	});
});
