/**
 * The Test Generation store's runs: what a unit, E2E or TDD generation asks
 * the main process for, the stages and code it streams into the studio, the
 * card it wrote to, the listeners it removes at the end, and cancelling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-store", () => ({
	useProjectStore: {
		getState: () => ({ getActiveProject: () => ({ path: "/proj" }) }),
	},
}));

import {
	openTestGenerationDialog,
	type TestGenStageEvent,
	useTestGenerationStore,
} from "../test-generation-store";

type Listener = (data: never) => void;
const initial = useTestGenerationStore.getState();
const store = () => useTestGenerationStore.getState();
let listeners: Record<string, Listener>;
let api: Record<string, ReturnType<typeof vi.fn>>;

const REVIEW = {
	taskId: "042-cart-tests",
	branch: "workpilot/042-cart-tests",
	baseBranch: "develop",
	title: "Tests for cart",
	files: ["tests/cart.test.ts"],
	committed: true,
};
const RESULT = { test_file_path: "tests/cart.test.ts", test_file_content: "it()" };

beforeEach(() => {
	useTestGenerationStore.setState(initial, true);
	listeners = {};
	const on = (name: string) =>
		vi.fn((cb: Listener) => {
			listeners[name] = cb;
		});
	api = {
		onTestGenerationStatus: on("status"),
		onTestGenerationComplete: on("complete"),
		onTestGenerationError: on("error"),
		onTestGenerationProgress: on("progress"),
		onTestGenerationCode: on("code"),
		removeTestGenerationStatusListener: vi.fn(),
		removeTestGenerationCompleteListener: vi.fn(),
		removeTestGenerationErrorListener: vi.fn(),
		removeTestGenerationProgressListener: vi.fn(),
		removeTestGenerationCodeListener: vi.fn(),
		generateUnitTests: vi.fn(),
		generateE2ETests: vi.fn(),
		generateTDDTests: vi.fn(),
		cancelTestGeneration: vi.fn(),
	};
	globalThis.electronAPI = api as never;
});

const runs = [
	{
		kind: "unit",
		start: () => store().generateUnitTests("/proj/src/cart.ts", "tests/old.ts", 90, "tests", ["vitest"]),
		method: "generateUnitTests",
		args: ["/proj/src/cart.ts", "tests/old.ts", 90, "/proj", "tests", ["vitest"]],
		status: "Unit tests generated successfully",
	},
	{
		kind: "e2e",
		start: () => store().generateE2ETests("As a buyer I pay", "checkout", "e2e", ["playwright"]),
		method: "generateE2ETests",
		args: ["As a buyer I pay", "checkout", "/proj", "e2e", ["playwright"]],
		status: "E2E tests generated successfully",
	},
	{
		kind: "tdd",
		start: () =>
			store().generateTDDTests({ description: "adds VAT", language: "csharp", snippet_type: "class" }, "tests", ["xunit"]),
		method: "generateTDDTests",
		args: ["adds VAT", "csharp", "class", "/proj", "tests", ["xunit"]],
		status: "TDD tests generated successfully",
	},
] as const;

describe.each(runs)("$kind generation", ({ kind, start, method, args, status }) => {
	it("asks the main process with the active project and streams the run", async () => {
		const run = start();
		expect(api[method]).toHaveBeenCalledWith(...args);
		expect(store()).toMatchObject({ phase: "generating", runKind: kind, isLiveRun: true });

		listeners.status("Reading the source" as never);
		listeners.code("it(" as never);
		listeners.code("'adds')" as never);
		expect(store()).toMatchObject({ status: "Reading the source", streamedCode: "it('adds')" });

		listeners.complete({ result: RESULT, review: REVIEW } as never);
		await expect(run).resolves.toEqual(RESULT);
		expect(store()).toMatchObject({ phase: "complete", status, result: RESULT });
		expect(store().review).toMatchObject({ taskId: "042-cart-tests", specId: "042-cart-tests" });
		expect(store().genEndedAt).not.toBeNull();
		for (const name of ["Status", "Complete", "Error", "Progress", "Code"]) {
			expect(api[`removeTestGeneration${name}Listener`]).toHaveBeenCalledOnce();
		}
	});

	it("keeps the last card when the run wrote nothing, and replays itself on retry", async () => {
		useTestGenerationStore.setState({ review: REVIEW as never });
		const run = start();
		listeners.complete({ result: RESULT } as never);
		await run;
		expect(store().review).toEqual(REVIEW);

		api[method].mockClear();
		store().retryLastRun();
		expect(api[method]).toHaveBeenCalledWith(...args);
	});

	it("rejects with the failure and marks the stage it died on", async () => {
		const run = start();
		listeners.progress({ type: "stage", stage: "generate" } as never);
		listeners.error({ code: "model_unreachable", message: "No key", stage: "generate" } as never);
		await expect(run).rejects.toThrow();
		expect(store().phase).toBe("error");
		expect(store().liveStages).toEqual([expect.objectContaining({ id: "generate", status: "failed" })]);
	});
});

describe("stages", () => {
	const event = (e: Partial<TestGenStageEvent>) => store().applyStageEvent({ type: "stage", ...e } as TestGenStageEvent);

	it("closes the stage still active when the next one starts", () => {
		event({ stage: "read", detail: "cart.ts", lines: 120, language: "ts", framework: "vitest" });
		event({ stage: "generate" });
		expect(store().liveStages).toEqual([
			{ id: "read", status: "done", detail: "cart.ts", lines: 120 },
			{ id: "generate", status: "active", detail: undefined, lines: undefined },
		]);
		expect(store().liveMeta).toEqual({ language: "ts", framework: "vitest" });
	});

	it("updates a known stage, keeping its detail unless a new one comes", () => {
		event({ stage: "read", detail: "cart.ts", lines: 10 });
		event({ stage: "read", status: "done" });
		expect(store().liveStages[0]).toEqual({ id: "read", status: "done", detail: "cart.ts", lines: 10 });
		event({ stage: "read", detail: "cart.tsx", lines: 12 });
		expect(store().liveStages[0]).toEqual({ id: "read", status: "done", detail: "cart.tsx", lines: 12 });
	});

	it("records a stage that arrives already done, with its path and test count", () => {
		event({ stage: "write", status: "done", path: "tests/a.ts", tests: 4 });
		expect(store().liveStages[0].status).toBe("done");
		expect(store().liveMeta).toEqual({ path: "tests/a.ts", tests: 4 });
	});

	it("finishes every stage on the final event, folding in its path and count", () => {
		event({ stage: "read" });
		event({ stage: "generate" });
		event({ stage: "done", path: "tests/b.ts", tests: 7 });
		expect(store().liveStages.map((s) => s.status)).toEqual(["done", "done"]);
		expect(store().liveMeta).toEqual({ path: "tests/b.ts", tests: 7 });
		event({ stage: "done" });
		expect(store().liveMeta).toEqual({ path: "tests/b.ts", tests: 7 });
	});

	it("marks nothing failed when no stage has started or none is active", () => {
		event({ stage: "generate", status: "failed" });
		expect(store().liveStages).toEqual([]);
		event({ stage: "read", status: "done" });
		event({ stage: "done", status: "failed" });
		expect(store().liveStages).toEqual([expect.objectContaining({ id: "read", status: "done" })]);
	});
});

describe("dialog and settings", () => {
	it("cancels the run and clears what it streamed", () => {
		useTestGenerationStore.setState({ phase: "generating", streamedCode: "x", liveStages: [{ id: "read", status: "active" }] as never });
		store().cancelGeneration();
		expect(api.cancelTestGeneration).toHaveBeenCalled();
		expect(store()).toMatchObject({ phase: "idle", streamedCode: "", liveStages: [], genStartedAt: null });
	});

	it("still resets when the process is already gone", () => {
		api.cancelTestGeneration.mockImplementation(() => {
			throw new Error("no process");
		});
		useTestGenerationStore.setState({ phase: "generating" });
		store().cancelGeneration();
		expect(store().phase).toBe("idle");
	});

	it("opens on a file and closes clean", () => {
		store().openDialog("/proj/src/a.ts", "tests/a.test.ts");
		expect(store()).toMatchObject({ isOpen: true, selectedFile: "/proj/src/a.ts", existingTestPath: "tests/a.test.ts" });
		store().openDialog("/proj/src/b.ts");
		expect(store().existingTestPath).toBeNull();
		useTestGenerationStore.setState({ review: REVIEW as never, result: RESULT as never, error: "x" });
		store().closeDialog();
		expect(store()).toMatchObject({ isOpen: false, review: null, result: null, error: null });
	});

	it("opens a blank dialog from anywhere", () => {
		useTestGenerationStore.setState({ coverageTarget: 50, selectedFile: "x" });
		openTestGenerationDialog();
		expect(store()).toMatchObject({ isOpen: true, selectedFile: "", coverageTarget: initial.coverageTarget });
	});

	it("keeps the settings the studio sets", () => {
		store().setCoverageTarget(95);
		store().setTddLanguage("go");
		store().setTddSnippetType("method");
		store().setSelectedFile("/proj/main.go");
		expect(store()).toMatchObject({
			coverageTarget: 95,
			tddLanguage: "go",
			tddSnippetType: "method",
			selectedFile: "/proj/main.go",
		});
	});

	it("ignores a card that is not one, and clears an error", () => {
		store().setReview({ taskId: "" });
		expect(store().review).toBeNull();
		store().setError("boom");
		expect(store().error).toBeTruthy();
		store().clearError();
		expect(store()).toMatchObject({ error: null, errorDetail: null });
	});
});
