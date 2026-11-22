/** @vitest-environment jsdom */
/**
 * Run and check (#387), in French: the test runs on its review card only,
 * its result and output are shown as text, and a reshoot's new selectors
 * change a step only when the person applies them.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { RecordedStep } from "../../../../shared/types/browser-recorder";
import { useBrowserRecorderStore } from "../../../stores/browser-recorder-store";
import { RecorderRun } from "../RecorderRun";

const initial = useBrowserRecorderStore.getState();
const steps: RecordedStep[] = [
	{ id: "s1", kind: "navigate", selectors: [], url: "http://localhost:3000/" },
	{ id: "s2", kind: "click", selectors: [{ strategy: "text", value: "Chaussures" }] },
	{ id: "s3", kind: "click", selectors: [{ strategy: "css", value: "#del" }] },
];
const review = { taskId: "7", specId: "7", title: "t", branch: "b", baseBranch: "d", files: [], committed: true, reused: false };
const run = { passed: false, exitCode: 1, durationMs: 9, output: "<b>1 failed</b>", setup: "awaiting-approval", firstRun: true, firstRuns: 4, firstPassed: 3 };

const runTest = vi.fn(async () => undefined);
const reshootSteps = vi.fn(async () => undefined);
const applyReshoot = vi.fn(async () => undefined);

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	useBrowserRecorderStore.setState({ ...initial, runTest, reshootSteps, applyReshoot }, true);
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("RecorderRun", () => {
	it("shows nothing before a recording has steps", () => {
		const { container } = render(<RecorderRun projectPath="/p" />);
		expect(container).toBeEmptyDOMElement();
	});

	it("runs only a test proposed on a review card, and shows how it went", () => {
		useBrowserRecorderStore.setState({ steps });
		const { rerender } = render(<RecorderRun projectPath="/p" />);
		const start = screen.getByRole("button", { name: "Lancer le test sur sa carte de revue" });
		expect(start).toBeDisabled();
		useBrowserRecorderStore.setState({ outcome: { success: true, review } });
		rerender(<RecorderRun projectPath="/p" />);
		fireEvent.click(start);
		expect(runTest).toHaveBeenCalledWith("/p");

		useBrowserRecorderStore.setState({ run });
		rerender(<RecorderRun projectPath="/p" />);
		const result = screen.getByTestId("recorder-run-result");
		expect(result).toHaveTextContent("Le test a échoué (code de sortie 1).");
		expect(result).toHaveTextContent("attend son approbation");
		expect(result).toHaveTextContent("Premier lancement de ce test.");
		expect(result).toHaveTextContent("3 test(s) enregistré(s) sur 4");
		expect(screen.getByText("<b>1 failed</b>")).toBeInTheDocument();

		useBrowserRecorderStore.setState({
			run: { ...run, passed: true, exitCode: 0, setup: "ready", firstRun: false, output: "" },
		});
		rerender(<RecorderRun projectPath="/p" />);
		expect(screen.getByTestId("recorder-run-result")).toHaveTextContent("Le test est passé.");
		expect(screen.queryByText("Premier lancement de ce test.")).not.toBeInTheDocument();
		useBrowserRecorderStore.setState({ run: { ...run, exitCode: null } });
		rerender(<RecorderRun projectPath="/p" />);
		expect(screen.getByTestId("recorder-run-result")).toHaveTextContent("code de sortie —");
	});

	it("reshoots, and applies only the new selectors still picked", () => {
		useBrowserRecorderStore.setState({ steps });
		const { rerender } = render(<RecorderRun projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Revérifier les sélecteurs" }));
		expect(reshootSteps).toHaveBeenCalledWith("/p");

		useBrowserRecorderStore.setState({ reshoot: [] });
		rerender(<RecorderRun projectPath="/p" />);
		expect(screen.getByText("Rien à rejouer.")).toBeInTheDocument();

		const css = [{ strategy: "css", value: "#shoes" }] as const;
		useBrowserRecorderStore.setState({
			reshoot: [
				{ id: "s1", status: "ok" },
				{ id: "s2", status: "changed", selectors: css },
				{ id: "s3", status: "changed", selectors: [{ strategy: "css", value: "#remove" }] },
				{ id: "s8", status: "missing" },
			],
		});
		rerender(<RecorderRun projectPath="/p" />);
		const list = screen.getByTestId("recorder-reshoot");
		for (const status of ["Trouvé", "Changé", "Introuvable"]) expect(list).toHaveTextContent(status);
		expect(list).toHaveTextContent('css "#shoes"');
		const [first, second] = screen.getAllByRole("checkbox");
		fireEvent.click(second);
		fireEvent.click(screen.getByRole("button", { name: "Utiliser les nouveaux sélecteurs" }));
		expect(applyReshoot).toHaveBeenCalledWith("/p", ["s2"]);
		fireEvent.click(first);
		expect(screen.getByRole("button", { name: "Utiliser les nouveaux sélecteurs" })).toBeDisabled();
		fireEvent.click(second);
		fireEvent.click(screen.getByRole("button", { name: "Utiliser les nouveaux sélecteurs" }));
		expect(applyReshoot).toHaveBeenLastCalledWith("/p", ["s3"]);

		useBrowserRecorderStore.setState({ applied: ["s2", "s3"] });
		rerender(<RecorderRun projectPath="/p" />);
		expect(screen.getAllByText("mis à jour")).toHaveLength(2);
		expect(screen.queryByRole("button", { name: "Utiliser les nouveaux sélecteurs" })).not.toBeInTheDocument();
	});
});
