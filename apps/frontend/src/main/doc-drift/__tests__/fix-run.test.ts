/**
 * Documentation drift fixes go to a review card, never to the checkout (#354):
 * only well-formed fix ids are kept, a run that changed nothing takes its card
 * away, and a failure never leaves a half-made card behind.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: vi.fn() }));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import { fixOnReviewCard, readFixRequest } from "../fix-run";

const ID = "rename:src/cart.ts:6:qty:quantity";
const review = {
	taskId: "004",
	specId: "004",
	title: "Corrections de documentation",
	branch: "workpilot/004-docs",
	baseBranch: "develop",
	files: ["src/cart.ts"],
	committed: true,
	reused: false,
};

function fakeRun() {
	return {
		workspace: {} as never,
		root: "/worktrees/004",
		map: (t: string | undefined) => t,
		finish: vi.fn().mockResolvedValue(review),
		abandon: vi.fn().mockResolvedValue(undefined),
	};
}

describe("readFixRequest", () => {
	it("keeps the well-formed ids once", () => {
		const request = readFixRequest({
			projectPath: "/p",
			fixIds: [ID, ID, "rm -rf /", 42, "rename:x:1:a", "delete:src/a.ts:1:a:b"],
		});
		expect(request).toEqual({ projectPath: "/p", fixIds: [ID] });
	});

	it("refuses a request without a project or a fix", () => {
		expect(readFixRequest({ fixIds: [ID] })).toBeNull();
		expect(readFixRequest({ projectPath: "/p", fixIds: [] })).toBeNull();
		expect(readFixRequest(null)).toBeNull();
	});
});

describe("fixOnReviewCard", () => {
	const request = { projectPath: "/p", fixIds: [ID] };

	it("runs the fixer in the card's worktree and commits there", async () => {
		const run = fakeRun();
		const fixer = vi.fn().mockResolvedValue({
			applied: [{ fixId: ID, kind: "rename", file: "src/cart.ts", line: 6 }],
			missing: [],
		});
		const outcome = await fixOnReviewCard(request, async () => run, fixer);
		expect(fixer).toHaveBeenCalledWith("/worktrees/004", [ID]);
		expect(run.finish).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "1 correction de documentation depuis le détecteur de dérive." }),
		);
		expect(outcome.review?.branch).toBe("workpilot/004-docs");
	});

	it("takes the card away when nothing was fixed, and after a failure", async () => {
		const empty = fakeRun();
		const outcome = await fixOnReviewCard(request, async () => empty, async () => ({ applied: [], missing: [ID] }));
		expect(outcome).toEqual({ applied: [], missing: [ID], review: null });
		expect(empty.abandon).toHaveBeenCalled();

		const failing = fakeRun();
		await expect(
			fixOnReviewCard(request, async () => failing, async () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		expect(failing.abandon).toHaveBeenCalled();
		expect(failing.finish).not.toHaveBeenCalled();
	});
});
