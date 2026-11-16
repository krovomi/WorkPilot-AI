/**
 * The Test Generation studio: four modes, what to test on the left, the run
 * on the wires in the middle, the result on the right, the action of the
 * moment at the bottom. The store is the real one; its runs are replaced by
 * fakes that move it the way the backend does.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDestination, TestLibrarySelection } from "../../../../shared/types/test-generation";
import { useProjectStore } from "../../../stores/project-store";
import { type TestGenerationResult, useTestGenerationStore } from "../../../stores/test-generation-store";
import { TestGenerationDialog } from "../TestGenerationDialog";

vi.mock("../../generated-review/GeneratedReviewBanner", () => ({
	GeneratedReviewBanner: ({ review }: { review: { taskId: string } }) => (
		<div data-testid="review-banner">{review.taskId}</div>
	),
}));

const ROOT = "/work/app";
const FILE = `${ROOT}/src/cart.ts`;

const SELECTION: TestLibrarySelection = {
	language: "typescript",
	selected: ["vitest"],
	installed: ["vitest"],
	explicit: false,
	libraries: [
		{
			id: "vitest",
			name: "Vitest",
			package: "vitest",
			ecosystem: "npm",
			language: "typescript",
			category: "framework",
			usage: "",
			recommended: true,
			installed: true,
		},
		{
			id: "msw",
			name: "MSW",
			package: "msw",
			ecosystem: "npm",
			language: "typescript",
			category: "http",
			usage: "",
			recommended: false,
			installed: false,
		},
	],
	missing: [],
	installCommands: [],
};

const RESULT: TestGenerationResult = {
	source_file: FILE,
	functions_analyzed: 2,
	tests_generated: 2,
	coverage_gaps: [],
	generated_tests: [
		{
			test_name: "adds an item",
			test_code: "expect(cart.add(1)).toBe(1);\nexpect(cart.size).toBe(1);",
			target_function: `${ROOT}/src/cart.ts`,
			test_type: "unit",
			description: "The cart grows by one",
			imports: [],
			fixtures: [],
		},
		{
			test_name: "empties",
			test_code: "",
			target_function: "",
			test_type: "unit",
			description: "",
			imports: [],
			fixtures: [],
		},
	],
	test_file_content: "import { cart } from './cart';\ndescribe('cart', () => {});",
	test_file_path: `${ROOT}/tests/cart.test.ts`,
};

const api = {
	listDirectory: vi.fn(),
	resolveTestLibraries: vi.fn(),
	resolveTestDestination: vi.fn(),
	addTestPackages: vi.fn(),
	toHostPath: vi.fn(),
};

const runs = {
	analyzeCoverage: vi.fn(),
	generateUnitTests: vi.fn(),
	generateE2ETests: vi.fn(),
	generateTDDTests: vi.fn(),
	cancelGeneration: vi.fn(),
};

const store = () => useTestGenerationStore.getState();

function openStudio(state: Partial<ReturnType<typeof store>> = {}) {
	act(() => useTestGenerationStore.setState({ isOpen: true, ...state }));
}

const studio = () => screen.getByTestId("test-studio");
const modeTab = (mode: string) => screen.getByTestId(`test-studio-mode-${mode}`);
const runButton = () => screen.getByTestId("test-studio-run");

/** A generation the backend answers in full. */
function completes(kind: "unit" | "e2e" | "tdd") {
	return async () => {
		useTestGenerationStore.setState({
			runKind: kind,
			phase: "complete",
			result: RESULT,
			streamedCode: RESULT.test_file_content,
			liveMeta: { language: "typescript", framework: "vitest", path: RESULT.test_file_path, tests: 2 },
			genStartedAt: 1_000,
			genEndedAt: 3_500,
		});
		return RESULT;
	};
}

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				// jsdom lays nothing out: nothing to watch.
			}
			disconnect() {
				// Nothing was watched.
			}
		},
	);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

describe("TestGenerationDialog", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		localStorage.clear();
		api.listDirectory.mockResolvedValue({ success: false });
		api.resolveTestLibraries.mockResolvedValue({ libraries: SELECTION });
		api.resolveTestDestination.mockResolvedValue({ destination: null });
		api.toHostPath.mockImplementation(async (p: string) => p);
		Object.assign(globalThis.electronAPI, api);
		useProjectStore.setState({
			projects: [{ id: "p1", name: "app", path: ROOT }] as never,
			activeProjectId: "p1",
		});
		useTestGenerationStore.getState().reset();
		useTestGenerationStore.setState({ isOpen: false, selectedFile: "", ...runs });
		for (const run of Object.values(runs)) run.mockResolvedValue(undefined);
	});

	it("stays closed until opened", () => {
		render(<TestGenerationDialog />);
		expect(screen.queryByTestId("test-studio")).not.toBeInTheDocument();
	});

	it("opens on the analysis and asks for a file first", async () => {
		render(<TestGenerationDialog />);
		openStudio();

		expect(screen.getByRole("dialog", { name: "Test Generation Agent" })).toBeInTheDocument();
		expect(modeTab("analyze")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Pick the file to analyze.")).toBeInTheDocument();
		expect(runButton()).toBeDisabled();
		expect(screen.getByText("4 steps")).toBeInTheDocument();
		expect(screen.getByText("No analysis yet")).toBeInTheDocument();
		// Ctrl+Enter does nothing without a file.
		fireEvent.keyDown(studio(), { key: "Enter", ctrlKey: true });
		expect(runs.analyzeCoverage).not.toHaveBeenCalled();
		await waitFor(() => expect(api.resolveTestLibraries).toHaveBeenCalled());
	});

	it("analyzes the file and turns the gaps into a unit run", async () => {
		runs.analyzeCoverage.mockImplementation(async () => {
			useTestGenerationStore.setState({
				runKind: "analyze",
				phase: "complete",
				coverageGaps: [
					{
						function: { name: "add", full_name: "Cart.add", line_number: 12 } as never,
						priority: "high",
						reason: "No test calls it",
						suggested_test_count: 2,
					},
					{
						function: { name: "clear", full_name: "", line_number: 0 } as never,
						priority: "low",
						reason: "",
						suggested_test_count: 0,
					},
				],
			});
			return [];
		});
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE, existingTestPath: `${ROOT}/tests/cart.old.test.ts` });

		expect(screen.getByText("Ready. Ctrl + Enter runs the agent.")).toBeInTheDocument();
		expect(within(studio()).getByText("cart.old.test.ts")).toBeInTheDocument();
		fireEvent.keyDown(studio(), { key: "Enter", metaKey: true });

		await waitFor(() =>
			expect(runs.analyzeCoverage).toHaveBeenCalledWith(FILE, `${ROOT}/tests/cart.old.test.ts`),
		);
		expect(await screen.findByText("Cart.add")).toBeInTheDocument();
		expect(screen.getByText("No test calls it")).toBeInTheDocument();
		expect(screen.getByText("line 12")).toBeInTheDocument();
		expect(screen.getByText("clear")).toBeInTheDocument();
		expect(screen.getByText("2 gaps found")).toBeInTheDocument();
		expect(screen.getByText("1 high priority")).toBeInTheDocument();
		expect(within(screen.getByTestId("test-studio-tab-gaps")).getByText("2")).toBeInTheDocument();

		runs.generateUnitTests.mockImplementation(completes("unit"));
		await userEvent.click(screen.getByTestId("test-studio-generate-from-gaps"));

		await waitFor(() =>
			expect(runs.generateUnitTests).toHaveBeenCalledWith(
				FILE,
				`${ROOT}/tests/cart.old.test.ts`,
				80,
				undefined,
				["vitest"],
			),
		);
		expect(modeTab("unit")).toHaveAttribute("aria-selected", "true");
		expect(await screen.findByText("2 tests written")).toBeInTheDocument();
	});

	it("does not start unit tests from the gaps once the file is cleared", async () => {
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		act(() =>
			useTestGenerationStore.setState({
				runKind: "analyze",
				phase: "complete",
				coverageGaps: [
					{
						function: { name: "add", full_name: "Cart.add", line_number: 3 } as never,
						priority: "medium",
						reason: "",
						suggested_test_count: 1,
					},
				],
			}),
		);
		act(() => useTestGenerationStore.setState({ selectedFile: "" }));

		await userEvent.click(screen.getByTestId("test-studio-generate-from-gaps"));

		expect(api.resolveTestDestination).not.toHaveBeenCalled();
		expect(runs.generateUnitTests).not.toHaveBeenCalled();
	});

	it("shows why an analysis failed in the gaps tab", () => {
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		act(() =>
			useTestGenerationStore.setState({
				runKind: "analyze",
				phase: "error",
				error: "boom",
				errorDetail: { message: "boom" } as never,
			}),
		);
		expect(screen.queryByText("No analysis yet")).not.toBeInTheDocument();
		expect(screen.getByText("stopped")).toBeInTheDocument();
	});

	it("shows an analysis that found nothing to cover", async () => {
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		act(() => useTestGenerationStore.setState({ runKind: "analyze", phase: "analyzing" }));
		expect(screen.getByText("Analysis running")).toBeInTheDocument();
		expect(screen.getByText("The agent is analyzing the file…")).toBeInTheDocument();
		expect(screen.getByText("running…")).toBeInTheDocument();
		// The other modes are locked while it runs.
		expect(modeTab("unit")).toBeDisabled();

		act(() => useTestGenerationStore.setState({ phase: "complete", coverageGaps: [] }));
		expect(screen.getByText("Every function in this file already has tests.")).toBeInTheDocument();
	});

	it("writes unit tests where the project says and shows them as they come", async () => {
		const user = userEvent.setup();
		const onApplyTests = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		let finish!: () => void;
		runs.generateUnitTests.mockImplementation(
			() =>
				new Promise((resolve) => {
					useTestGenerationStore.setState({
						runKind: "unit",
						phase: "generating",
						liveStages: [
							{ id: "detect", status: "done" },
							{ id: "read", status: "done", lines: 42 },
							{ id: "generate", status: "active" },
						],
						liveMeta: { language: "typescript", framework: "vitest" },
						streamedCode: "",
						genStartedAt: Date.now(),
					});
					finish = () => void completes("unit")().then(resolve);
				}),
		);
		render(<TestGenerationDialog onApplyTests={onApplyTests} />);
		openStudio({ selectedFile: FILE });

		await user.click(modeTab("unit"));
		expect(screen.getByText("coverage 80%")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText(/Coverage Target/), { target: { value: "90" } });
		expect(store().coverageTarget).toBe(90);
		await waitFor(() => expect(screen.getByRole("checkbox", { name: /MSW/ })).toBeInTheDocument());
		await user.click(screen.getByRole("checkbox", { name: /MSW/ }));
		// Before a run the tests tab says there is nothing yet.
		await user.click(screen.getByTestId("test-studio-tab-tests"));
		expect(screen.getByText("No tests yet")).toBeInTheDocument();
		// MSW is not referenced yet: the studio offers to add it.
		await user.click(screen.getByRole("button", { name: "Add 1 package" }));
		await waitFor(() => expect(api.addTestPackages).toHaveBeenCalledWith(["msw"], ROOT, undefined, FILE));

		await user.click(runButton());

		await waitFor(() =>
			expect(runs.generateUnitTests).toHaveBeenCalledWith(FILE, undefined, 90, undefined, ["vitest", "msw"]),
		);
		expect(api.resolveTestDestination).toHaveBeenCalledWith(FILE, ROOT, undefined);
		expect(await screen.findByText("LIVE")).toBeInTheDocument();
		expect(screen.getByText("Waiting for the model…")).toBeInTheDocument();
		expect(screen.getByText("42 lines")).toBeInTheDocument();
		expect(screen.getByText("TypeScript · vitest")).toBeInTheDocument();
		expect(screen.getByText("The agent is writing the tests…")).toBeInTheDocument();
		// The clock runs while it writes.
		await waitFor(() => expect(screen.getByText("Elapsed").previousSibling).not.toHaveTextContent("0.0 s"));

		await user.click(screen.getByRole("button", { name: "Cancel generation" }));
		expect(runs.cancelGeneration).toHaveBeenCalled();

		await act(async () => finish());
		expect(await screen.findByText("done in 2.5 s")).toBeInTheDocument();
		expect(screen.getByTestId("test-studio-written")).toHaveTextContent(RESULT.test_file_path);
		// The file's name heads the code and ends the pipeline.
		expect(screen.getAllByText("cart.test.ts").length).toBeGreaterThanOrEqual(2);

		await user.click(screen.getByRole("button", { name: "Copy path" }));
		expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
		expect(writeText).toHaveBeenLastCalledWith(RESULT.test_file_path);

		await user.click(screen.getByRole("button", { name: "Copy All" }));
		expect(writeText).toHaveBeenLastCalledWith(RESULT.test_file_content);

		// The tests the file holds.
		await user.click(screen.getByTestId("test-studio-tab-tests"));
		expect(screen.getByText("The cart grows by one")).toBeInTheDocument();
		expect(screen.getByText("4 assertions")).toBeInTheDocument();
		expect(screen.getByText("→ cart.ts")).toBeInTheDocument();
		expect(screen.getByText("empties")).toBeInTheDocument();

		// What it was read from.
		await user.click(screen.getByTestId("test-studio-tab-stack"));
		expect(screen.getByText("Vitest · MSW")).toBeInTheDocument();

		await user.click(screen.getByTestId("test-studio-tab-code"));
		await user.click(screen.getByRole("button", { name: "Apply Tests" }));
		expect(onApplyTests).toHaveBeenCalledWith(RESULT.test_file_content, RESULT.test_file_path);
		expect(store().isOpen).toBe(false);
	});

	it("does not say Copied when the clipboard refuses", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
			configurable: true,
		});
		runs.generateUnitTests.mockImplementation(completes("unit"));
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		await userEvent.click(modeTab("unit"));
		await userEvent.click(runButton());
		await screen.findByTestId("test-studio-written");

		await userEvent.click(screen.getByRole("button", { name: "Copy path" }));
		await userEvent.click(screen.getByRole("button", { name: "Copy All" }));

		expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
		expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
	});

	it("asks where the tests go when the project cannot say, and stops on Cancel", async () => {
		const destination: TestDestination = {
			directory: `${ROOT}/tests`,
			fileName: "cart.test.ts",
			path: `${ROOT}/tests/cart.test.ts`,
			status: "needs_choice",
			reason: "no_tests_dir",
			projectRoot: ROOT,
			sourceRoot: `${ROOT}/src`,
			candidates: [{ path: `${ROOT}/tests`, kind: "sibling_of_source_root", exists: false }],
		};
		api.resolveTestDestination.mockResolvedValue({ destination });
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		await userEvent.click(modeTab("unit"));

		await userEvent.click(runButton());
		await userEvent.click(await screen.findByRole("button", { name: "Write tests here" }));
		await waitFor(() =>
			expect(runs.generateUnitTests).toHaveBeenCalledWith(FILE, undefined, 80, `${ROOT}/tests`, ["vitest"]),
		);

		await userEvent.click(runButton());
		const dialog = await screen.findByRole("dialog", { name: "Where should these tests go?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Where should these tests go?" })).not.toBeInTheDocument(),
		);
		expect(runs.generateUnitTests).toHaveBeenCalledTimes(1);
	});

	it("starts unit tests from the analysis bar", async () => {
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		await userEvent.click(screen.getByRole("button", { name: "Generate Tests" }));
		await waitFor(() => expect(runs.generateUnitTests).toHaveBeenCalled());
		expect(modeTab("unit")).toHaveAttribute("aria-selected", "true");
	});

	it("generates E2E tests from a story and a typed target", async () => {
		const user = userEvent.setup();
		runs.generateE2ETests.mockImplementation(completes("e2e"));
		render(<TestGenerationDialog />);
		openStudio();
		await user.click(modeTab("e2e"));
		expect(screen.getByText("Describe the user story and its target.")).toBeInTheDocument();

		await user.type(screen.getByLabelText(/User Story/), "As a buyer, I pay by card");
		await user.type(screen.getByRole("textbox", { name: "Target Module" }), "  /checkout ");
		// The story heads the pipeline.
		expect(screen.getByTestId("test-studio-step-scenario").parentElement).toHaveTextContent(
			"As a buyer, I pay by card",
		);
		await user.click(runButton());

		await waitFor(() =>
			expect(runs.generateE2ETests).toHaveBeenCalledWith("As a buyer, I pay by card", "/checkout", undefined, [
				"vitest",
			]),
		);
		expect(await screen.findByText("2 tests written")).toBeInTheDocument();
	});

	it("writes red tests in the project's language unless one is picked", async () => {
		const user = userEvent.setup();
		api.resolveTestLibraries.mockResolvedValue({ libraries: { ...SELECTION, language: "python" } });
		runs.generateTDDTests.mockImplementation(completes("tdd"));
		render(<TestGenerationDialog />);
		openStudio();
		await user.click(modeTab("tdd"));
		expect(runButton()).toBeDisabled();

		const languages = screen.getByRole("group", { name: "Language" });
		await waitFor(() =>
			expect(within(languages).getByRole("button", { name: /Project/ })).toHaveTextContent("Python"),
		);
		await user.type(screen.getByLabelText(/What should this code do/), "Sums two numbers");
		await user.click(screen.getByRole("button", { name: "Class" }));
		await user.click(runButton());
		await waitFor(() =>
			expect(runs.generateTDDTests).toHaveBeenCalledWith(
				{ description: "Sums two numbers", language: "python", snippet_type: "class" },
				undefined,
				["vitest"],
			),
		);

		await user.click(within(languages).getByRole("button", { name: "Go" }));
		expect(store().tddLanguage).toBe("go");
		await user.click(within(languages).getByRole("button", { name: /Project/ }));
		expect(store().tddLanguage).toBe("");
		await user.click(within(languages).getByRole("button", { name: "Go" }));
		await user.click(runButton());
		await waitFor(() =>
			expect(runs.generateTDDTests).toHaveBeenLastCalledWith(
				expect.objectContaining({ language: "go" }),
				undefined,
				expect.any(Array),
			),
		);
	});

	it("falls back to TypeScript for red tests in a language it does not know", async () => {
		api.resolveTestLibraries.mockResolvedValue({ libraries: { ...SELECTION, language: "cobol" } });
		render(<TestGenerationDialog />);
		openStudio();
		await userEvent.click(modeTab("tdd"));
		await userEvent.type(screen.getByLabelText(/What should this code do/), "x");
		await userEvent.click(runButton());
		await waitFor(() =>
			expect(runs.generateTDDTests).toHaveBeenCalledWith(
				expect.objectContaining({ language: "typescript" }),
				undefined,
				expect.any(Array),
			),
		);
	});

	it("opens the part of the result a step stands for", async () => {
		render(<TestGenerationDialog />);
		openStudio();
		await userEvent.click(modeTab("unit"));

		await userEvent.click(screen.getByTestId("test-studio-step-detect"));
		expect(screen.getByTestId("test-studio-step-detect")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("test-studio-tab-stack")).toHaveAttribute("aria-selected", "true");

		await userEvent.click(screen.getByTestId("test-studio-step-write"));
		expect(screen.getByTestId("test-studio-tab-code")).toHaveAttribute("aria-selected", "true");

		await userEvent.click(screen.getByTestId("test-studio-step-write"));
		expect(screen.getByTestId("test-studio-step-write")).toHaveAttribute("aria-pressed", "false");

		// Clicking the mode already shown changes nothing.
		await userEvent.click(modeTab("unit"));
		expect(modeTab("unit")).toHaveAttribute("aria-selected", "true");
	});

	it("shows where a run failed and keeps the error in the inspector", async () => {
		render(<TestGenerationDialog />);
		openStudio({ selectedFile: FILE });
		await userEvent.click(modeTab("unit"));
		act(() =>
			useTestGenerationStore.setState({
				runKind: "unit",
				phase: "error",
				error: "The model did not answer",
				errorDetail: { message: "The model did not answer" } as never,
				liveStages: [{ id: "detect", status: "done" }, { id: "read", status: "failed" }],
			}),
		);

		expect(screen.getByText("stopped")).toBeInTheDocument();
		expect(screen.getByText("failed here")).toBeInTheDocument();
		expect(screen.getAllByText("not reached").length).toBeGreaterThan(0);
		expect(screen.getByText("No code was generated.")).toBeInTheDocument();
	});

	it("shows the review card the tests went to and closes for it", async () => {
		render(<TestGenerationDialog />);
		openStudio();
		act(() => useTestGenerationStore.setState({ review: { taskId: "task-7", files: ["a"] } as never }));
		expect(screen.getByTestId("review-banner")).toHaveTextContent("task-7");
	});

	it("forgets what was typed once closed", async () => {
		render(<TestGenerationDialog />);
		openStudio();
		await userEvent.click(modeTab("tdd"));
		await userEvent.type(screen.getByLabelText(/What should this code do/), "Sums");

		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(store().isOpen).toBe(false);
		openStudio();

		expect(modeTab("analyze")).toHaveAttribute("aria-selected", "true");
		await userEvent.click(modeTab("tdd"));
		expect(screen.getByLabelText(/What should this code do/)).toHaveValue("");
	});
});
