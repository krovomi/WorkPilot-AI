/**
 * A notebook run and a notebook refactor (#371): the renderer names a
 * notebook inside the project, never an absolute path or `..`; a refactor
 * goes to a review card, which goes away again when nothing changed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: vi.fn() }));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import {
	EXECUTE_TIMEOUT_MS,
	executeNotebook,
	notebookMetrics,
	readNotebookPath,
	readRefactorRequest,
	readRunRequest,
	refactorOnReviewCard,
} from "../notebook-runs";

const review = {
	taskId: "007",
	specId: "007",
	title: "Refactor de notebook",
	branch: "workpilot/007-notebook",
	baseBranch: "develop",
	files: ["analysis/report.ipynb", "analysis/report_functions.py"],
	committed: true,
	reused: false,
};

function fakeRun() {
	return {
		workspace: {} as never,
		root: "/p/.workpilot/worktrees/007",
		map: (t: string | undefined) => t,
		finish: vi.fn().mockResolvedValue(review),
		abandon: vi.fn().mockResolvedValue(undefined),
	};
}

describe("readNotebookPath", () => {
	it("keeps a notebook relative to the project", () => {
		expect(readNotebookPath("analysis/report.ipynb")).toBe("analysis/report.ipynb");
		expect(readNotebookPath("docs/intro.QMD")).toBe("docs/intro.QMD");
		expect(readNotebookPath("explore.dib")).toBe("explore.dib");
	});

	it("refuses absolute paths, escapes, workpilot files and other suffixes", () => {
		for (const raw of [
			"/etc/passwd.ipynb",
			"C:\\x.ipynb",
			"../other/x.ipynb",
			"a/../../x.ipynb",
			"a//x.ipynb",
			".workpilot/specs/x.ipynb",
			"script.py",
			"x.ipynb\0",
			42,
			"",
			`${"a".repeat(500)}.ipynb`,
		]) {
			expect(readNotebookPath(raw)).toBeNull();
		}
	});
});

describe("readRunRequest / readRefactorRequest", () => {
	it("needs a project and a notebook", () => {
		expect(readRunRequest({ projectPath: "/p", notebook: "a.ipynb" })).toEqual({
			projectPath: "/p",
			notebook: "a.ipynb",
		});
		expect(readRunRequest({ notebook: "a.ipynb" })).toBeNull();
		expect(readRunRequest(null)).toBeNull();
	});

	it("keeps well-formed cell indices once, sorted, and refuses an empty refactor", () => {
		expect(
			readRefactorRequest({ projectPath: "/p", notebook: "a.ipynb", extract: [4, 2, 4, -1, 1.5, "3"], clean: "yes" }),
		).toEqual({ projectPath: "/p", notebook: "a.ipynb", extract: [2, 4], clean: false });
		expect(readRefactorRequest({ projectPath: "/p", notebook: "a.ipynb", extract: [] })).toBeNull();
		expect(readRefactorRequest({ projectPath: "/p", notebook: "a.ipynb", clean: true })?.clean).toBe(true);
	});

	it("only rewrites .ipynb notebooks", () => {
		expect(readRefactorRequest({ projectPath: "/p", notebook: "a.qmd", clean: true })).toBeNull();
	});

	it("caps the number of cells", () => {
		const extract = Array.from({ length: 80 }, (_, i) => i);
		expect(readRefactorRequest({ projectPath: "/p", notebook: "a.ipynb", extract })?.extract).toHaveLength(50);
	});
});

describe("executeNotebook and notebookMetrics", () => {
	it("passes the project and the notebook as arguments", async () => {
		const runner = vi.fn().mockResolvedValue({ status: "done" });
		await executeNotebook({ projectPath: "/p", notebook: "a.ipynb" }, runner as never);
		expect(runner).toHaveBeenCalledWith(
			["--project-path", "/p", "--action", "execute", "--notebook", "a.ipynb"],
			"NOTEBOOK_EXECUTION:",
			EXECUTE_TIMEOUT_MS,
		);
	});

	it("returns no month when the runner answers something else", async () => {
		const runner = vi.fn().mockResolvedValue({ months: "nope" });
		expect(await notebookMetrics("/p", runner as never)).toEqual([]);
	});
});

describe("refactorOnReviewCard", () => {
	const request = { projectPath: "/p", notebook: "analysis/report.ipynb", extract: [3], clean: true };

	it("runs in the card's worktree and commits there", async () => {
		const run = fakeRun();
		const runner = vi.fn().mockResolvedValue({
			extracted: [{ cellIndex: 3, function: "train", module: "report_functions.py" }],
			refused: [],
			cleaned: true,
			changed: ["analysis/report.ipynb", "analysis/report_functions.py"],
		});
		const openRun = vi.fn().mockResolvedValue(run);
		const outcome = await refactorOnReviewCard(request, openRun, runner as never);
		expect(openRun).toHaveBeenCalledWith("/p", "report.ipynb");
		expect(runner.mock.calls[0][0]).toEqual([
			"--project-path",
			"/p/.workpilot/worktrees/007",
			"--action",
			"apply",
			"--notebook",
			"analysis/report.ipynb",
			"--extract",
			"3",
			"--clean",
		]);
		expect(run.finish).toHaveBeenCalledWith(
			expect.objectContaining({ message: "refactor(notebook): extract 1 cell into functions, clean outputs in report.ipynb" }),
		);
		expect(run.abandon).not.toHaveBeenCalled();
		expect(outcome.review?.branch).toBe("workpilot/007-notebook");
	});

	it("takes the card away when nothing changed", async () => {
		const run = fakeRun();
		const runner = vi.fn().mockResolvedValue({
			extracted: [],
			refused: [{ cellIndex: 3, reason: "uses a magic" }],
			cleaned: false,
			changed: [],
		});
		const outcome = await refactorOnReviewCard(request, async () => run, runner as never);
		expect(run.abandon).toHaveBeenCalled();
		expect(run.finish).not.toHaveBeenCalled();
		expect(outcome).toEqual({ extracted: [], refused: [{ cellIndex: 3, reason: "uses a magic" }], cleaned: false, review: null });
	});

	it("never leaves a half-made card when the runner fails", async () => {
		const run = fakeRun();
		const runner = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(refactorOnReviewCard(request, async () => run, runner as never)).rejects.toThrow("boom");
		expect(run.abandon).toHaveBeenCalled();
	});
});
