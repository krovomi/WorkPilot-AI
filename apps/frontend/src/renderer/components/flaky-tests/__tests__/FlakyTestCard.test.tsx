/** @vitest-environment jsdom */
/**
 * A flaky test on the page (#351): its verdict, what its code shows, its
 * history, a re-run of the suspects only, and a Kanban card to fix it or put it
 * in quarantine, worded in the app's language for the test's own stack.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { FlakyReport, FlakyTest } from "../../../../shared/types/flaky-tests";
import { useFlakyTestsStore } from "../../../stores/flaky-tests-store";
import { useProjectStore } from "../../../stores/project-store";
import { FlakyTestReport } from "../FlakyTestReport";
import { buildFlakyTask } from "../flaky-task";

const FLAKY: FlakyTest = {
	testName: "tests.test_cart::test_adds",
	totalRuns: 5,
	failures: 2,
	flakinessRate: 0.4,
	probableCause: "timing",
	confidence: "medium",
	errorPatterns: ["AssertionError: worker not done"],
	suggestedFix: "",
	verdict: "flaky",
	file: "tests/test_cart.py",
	line: 8,
	stack: "pytest",
	sourceCauses: [{ cause: "timing", evidence: [{ line: 9, text: "time.sleep(0.5)" }] }],
	lastAuthor: "Ana",
	history: { firstSeen: "2026-11-01T10:00:00+00:00", observations: 2, trend: "worse", systems: ["linux"], ciOnly: true },
};

const REPORT: FlakyReport = {
	mode: "run",
	runCount: 5,
	command: "python -m pytest",
	totalTests: 40,
	flakyCount: 1,
	summary: "",
	summaryCode: "flaky",
	minRuns: 2,
	alwaysFailing: ["tests.test_pay::test_refund"],
	flakyTests: [FLAKY],
};

const api = {
	runFlakyTestsScan: vi.fn(),
	detectFlakyTestCommands: vi.fn(),
	cancelFlakyTestsScan: vi.fn(),
	getSharedAnalysisReport: vi.fn(),
	createTask: vi.fn(),
};

const INITIAL = useFlakyTestsStore.getState();

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.detectFlakyTestCommands.mockResolvedValue({
		commands: [{ id: "pytest", label: "pytest", command: "python -m pytest" }],
		remote: false,
	});
	api.getSharedAnalysisReport.mockResolvedValue(null);
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useFlakyTestsStore.setState({ ...INITIAL, phase: "complete", report: REPORT }, true);
	useProjectStore.setState({ projects: [{ id: "p1", path: "/repo" }] as never, activeProjectId: "p1" });
	await i18n.changeLanguage("fr");
});

afterEach(async () => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	await i18n.changeLanguage("en");
});

describe("a flaky test on the page", () => {
	it("shows its verdict, the line that explains it and its history", async () => {
		render(<FlakyTestReport projectPath="/repo" />);

		expect(await screen.findByText("instable")).toBeInTheDocument();
		expect(screen.getByText("tests/test_cart.py:8")).toBeInTheDocument();
		expect(screen.getByText("time.sleep(0.5)")).toBeInTheDocument();
		expect(screen.getByText("Pire que la dernière fois")).toBeInTheDocument();
		expect(screen.getByText("CI seulement")).toBeInTheDocument();
		expect(screen.getByText("Modifié en dernier par Ana")).toBeInTheDocument();
	});

	it("runs only the suspects again", async () => {
		api.runFlakyTestsScan.mockResolvedValue(REPORT);
		render(<FlakyTestReport projectPath="/repo" />);

		fireEvent.click(await screen.findByText("Relancer les 2 suspects"));

		await waitFor(() =>
			expect(api.runFlakyTestsScan).toHaveBeenCalledWith(
				expect.objectContaining({
					projectPath: "/repo",
					mode: "run",
					only: ["tests.test_cart::test_adds", "tests.test_pay::test_refund"],
				}),
			),
		);
	});

	it("puts the test in quarantine on a Kanban card, in its stack's terms", async () => {
		api.createTask.mockResolvedValue({ success: true, data: { id: "t1", title: "Quarantaine" } });
		render(<FlakyTestReport projectPath="/repo" />);

		fireEvent.click(await screen.findByText("Mettre en quarantaine sur une carte"));

		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		const [projectId, title, description, metadata] = api.createTask.mock.calls[0];
		expect(projectId).toBe("p1");
		expect(title).toBe("Mettre en quarantaine le test instable test_adds");
		expect(description).toContain("pytest.mark.xfail");
		expect(description).toContain("`tests/test_cart.py:9` `time.sleep(0.5)`");
		expect(metadata.sourceType).toBe("flaky-tests");
		expect(await screen.findByText("L'ouvrir sur le tableau")).toBeInTheDocument();
	});
});

describe("buildFlakyTask", () => {
	it("forbids the fixes that hide the problem", () => {
		const t = i18n.getFixedT("en", "flakyTests");
		const spec = buildFlakyTask(FLAKY, "fix", t as never);

		expect(spec.title).toBe("Fix the flaky test test_adds");
		expect(spec.description).toContain("no skip, no retry");
		expect(spec.description).toContain("Replace fixed sleeps");
		expect(spec.acceptanceCriteria[0]).toBe("tests.test_cart::test_adds passes in 10 runs in a row.");
	});

	it("words the quarantine for every stack", () => {
		const t = i18n.getFixedT("en", "flakyTests");
		for (const [stack, marker] of [
			["dotnet", "Category!=Quarantine"],
			["jvm", "@Tag(\"quarantine\")"],
			["go", "QUARANTINE=1"],
			["rust", "--ignored"],
			["vitest", "quarantine.test.ts"],
		] as const) {
			const spec = buildFlakyTask({ ...FLAKY, stack }, "quarantine", t as never);
			expect(spec.description).toContain(marker);
		}
	});
});
