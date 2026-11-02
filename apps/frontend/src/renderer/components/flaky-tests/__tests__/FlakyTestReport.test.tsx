/** @vitest-environment jsdom */
/**
 * The Flaky Test Detective page: it offers to run the project's own test
 * command several times (the page used to only read reports already on the
 * disk and showed "0 flaky out of 0 tests" with an English hint), words the
 * runner's progress and errors itself, and explains an empty result.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { FlakyReport } from "../../../../shared/types/flaky-tests";
import { useFlakyTestsStore } from "../../../stores/flaky-tests-store";
import { FlakyTestReport, activityText, parseRunnerError } from "../FlakyTestReport";

const DOTNET = { id: "dotnet", label: "C# / .NET", command: "dotnet test App.sln" };

const api = {
	runFlakyTestsScan: vi.fn(),
	detectFlakyTestCommands: vi.fn(),
	cancelFlakyTestsScan: vi.fn(),
	getSharedAnalysisReport: vi.fn(),
};

const INITIAL = useFlakyTestsStore.getState();

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.detectFlakyTestCommands.mockResolvedValue({ commands: [DOTNET], remote: false });
	api.getSharedAnalysisReport.mockResolvedValue(null);
	api.cancelFlakyTestsScan.mockResolvedValue(true);
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useFlakyTestsStore.setState(INITIAL, true);
	await i18n.changeLanguage("fr");
});

afterEach(async () => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	await i18n.changeLanguage("en");
});

describe("FlakyTestReport", () => {
	it("detects the project's command and runs it the chosen number of times", async () => {
		const report: FlakyReport = {
			mode: "run",
			runCount: 3,
			command: "dotnet test App.sln",
			totalTests: 12,
			flakyCount: 1,
			summary: "1 flaky tests: 1 timing",
			summaryCode: "flaky",
			minRuns: 2,
			alwaysFailing: ["Ns.T.Broken"],
			flakyTests: [
				{
					testName: "Ns.T.Flaky",
					totalRuns: 3,
					failures: 1,
					flakinessRate: 1 / 3,
					probableCause: "timing",
					confidence: "medium",
					errorPatterns: ["Timeout after 5s"],
					suggestedFix: "Replace sleep/timeout with explicit waits",
				},
			],
		};
		api.runFlakyTestsScan.mockResolvedValue(report);
		render(<FlakyTestReport projectPath="/p" />);

		await screen.findByText("dotnet test App.sln");
		fireEvent.change(screen.getByLabelText("Nombre d'exécutions"), {
			target: { value: "3" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Exécuter 3 fois" }));

		await waitFor(() =>
			expect(api.runFlakyTestsScan).toHaveBeenCalledWith({
				projectPath: "/p",
				mode: "run",
				runs: 3,
				commandId: "dotnet",
			}),
		);
		expect(
			await screen.findByText(
				"1 instables sur 12 tests, sur 3 exécutions de dotnet test App.sln",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Ns.T.Flaky")).toBeInTheDocument();
		expect(screen.getByText("Confiance moyenne")).toBeInTheDocument();
		expect(screen.getByText(/en échec 1 fois sur 3 exécutions/)).toBeInTheDocument();
		expect(screen.getByText(/Cause : délais/)).toBeInTheDocument();
		expect(screen.getByText("1 test(s) en échec à chaque exécution")).toBeInTheDocument();
	});

	it("explains an empty scan in the user's language, with the command to run", async () => {
		api.runFlakyTestsScan.mockResolvedValue({
			mode: "scan",
			reportCount: 0,
			runCount: 0,
			totalTests: 0,
			flakyCount: 0,
			flakyTests: [],
			summary: "No test reports found. Emit JUnit XML or TRX reports and re-scan.",
			summaryCode: "no_reports",
			detectedCommands: [DOTNET],
		});
		render(<FlakyTestReport projectPath="/p" />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Analyser les rapports existants" }),
		);

		expect(
			await screen.findByText("Aucun rapport de tests trouvé dans ce projet."),
		).toBeInTheDocument();
		expect(screen.getByText(/le détective lancera dotnet test App.sln/)).toBeInTheDocument();
		expect(screen.queryByText(/Emit JUnit XML/)).not.toBeInTheDocument();
	});

	it("says when no test command is supported and keeps the run button off", async () => {
		api.detectFlakyTestCommands.mockResolvedValue({ commands: [], remote: false });
		render(<FlakyTestReport projectPath="/p" />);
		expect(
			await screen.findByText(/Aucune commande de test prise en charge/),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Exécuter 5 fois" })).toBeDisabled();
	});

	it("shows the build output when the command wrote no report", async () => {
		api.runFlakyTestsScan.mockRejectedValue(
			new Error(
				"Error invoking remote method 'flakyTests:run': Error: no_results: the test command produced no test report.\nerror CS1002: ; expected",
			),
		);
		render(<FlakyTestReport projectPath="/p" />);
		fireEvent.click(await screen.findByRole("button", { name: "Exécuter 5 fois" }));
		expect(
			await screen.findByText(/La commande de test n'a écrit aucun rapport/),
		).toBeInTheDocument();
		expect(screen.getByText("error CS1002: ; expected")).toBeInTheDocument();
	});
});

describe("parseRunnerError", () => {
	it("finds the code inside the IPC wrapping", () => {
		expect(parseRunnerError("Error: start_failed: the command could not start")).toEqual({
			code: "start_failed",
			detail: "the command could not start",
		});
		expect(parseRunnerError("boom")).toEqual({ code: null, detail: "boom" });
	});
});

describe("activityText", () => {
	const t = i18n.getFixedT("en", "flakyTests") as unknown as (
		key: string,
		opts?: Record<string, unknown>,
	) => string;
	const base = {
		mode: "run" as const,
		code: "",
		command: "dotnet test",
		run: 2,
		runs: 5,
		reports: 4,
		finished: [],
	};

	it("words each step", () => {
		expect(activityText({ ...base, code: "run_started" }, "", t)).toBe(
			"Run 2 of 5: dotnet test",
		);
		expect(activityText({ ...base, code: "parsing" }, "", t)).toBe(
			"Reading 4 test reports…",
		);
		expect(activityText({ ...base, code: "analysing" }, "", t)).toBe(
			"Analysing the results…",
		);
		// An older runner sends only an English status.
		expect(activityText(base, "Parsing 3 test reports...", t)).toBe(
			"Parsing 3 test reports...",
		);
	});
});
