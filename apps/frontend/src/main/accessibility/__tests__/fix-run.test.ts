/**
 * One-click fixes go to a review card, never to the checkout (#391): only
 * well-formed fix ids are kept, a run that changed nothing takes its card
 * away, and a failure never leaves a half-made card behind.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: vi.fn() }));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import { fixOnReviewCard, readFixRequest } from "../fix-run";

const ID = "img-alt:src/App.tsx:4:12345";
const review = {
	taskId: "003",
	specId: "003",
	title: "Corrections d'accessibilité",
	branch: "workpilot/003-a11y",
	baseBranch: "develop",
	files: ["src/App.tsx"],
	committed: true,
	reused: false,
};

function fakeRun() {
	return {
		workspace: {} as never,
		root: "/worktrees/003",
		map: (t: string | undefined) => t,
		finish: vi.fn().mockResolvedValue(review),
		abandon: vi.fn().mockResolvedValue(undefined),
	};
}

describe("readFixRequest", () => {
	it("keeps the well-formed ids once, and a valid language", () => {
		const request = readFixRequest({
			projectPath: "/p",
			fixIds: [ID, ID, "rm -rf /", 42, "img-alt:x:1"],
			pageLang: "fr-CA",
			aiAlt: "yes",
		});
		expect(request).toEqual({ projectPath: "/p", fixIds: [ID], pageLang: "fr-CA", aiAlt: false });
	});

	it("refuses a request without a project or a fix, and a hostile language", () => {
		expect(readFixRequest({ fixIds: [ID] })).toBeNull();
		expect(readFixRequest({ projectPath: "/p", fixIds: [] })).toBeNull();
		expect(readFixRequest({ projectPath: "/p", fixIds: [ID], pageLang: '"><script>' })?.pageLang).toBe("en");
	});
});

describe("fixOnReviewCard", () => {
	const request = { projectPath: "/p", fixIds: [ID], pageLang: "fr", aiAlt: false };

	it("runs the fixer in the card's worktree and commits there", async () => {
		const run = fakeRun();
		const fixer = vi.fn().mockResolvedValue({
			applied: [{ fixId: ID, ruleId: "img-alt", file: "src/App.tsx", line: 4, attribute: "alt", value: "Hero" }],
			missing: [],
			aiAlt: 0,
		});
		const outcome = await fixOnReviewCard(request, async () => run, fixer);
		expect(fixer).toHaveBeenCalledWith("/worktrees/003", request);
		expect(run.finish).toHaveBeenCalledWith(
			expect.objectContaining({ message: "fix(a11y): 1 WCAG fix (img-alt)" }),
		);
		expect(outcome.review?.branch).toBe("workpilot/003-a11y");
	});

	it("takes the card away when nothing was fixed", async () => {
		const run = fakeRun();
		const outcome = await fixOnReviewCard(request, async () => run, async () => ({
			applied: [],
			missing: [ID],
			aiAlt: 0,
		}));
		expect(run.abandon).toHaveBeenCalled();
		expect(run.finish).not.toHaveBeenCalled();
		expect(outcome).toEqual({ applied: [], missing: [ID], review: null, aiAlt: 0 });
	});

	it("takes the card away when the fixer fails", async () => {
		const run = fakeRun();
		await expect(
			fixOnReviewCard(request, async () => run, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(run.abandon).toHaveBeenCalled();
	});
});
