/**
 * Missing translations go to a review card, never to the checkout (#346):
 * only well-formed locales reach the runner, a run that added nothing takes
 * its card away, and a failure never leaves a half-made card behind.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: vi.fn() }));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));

import { readTranslateRequest, translateOnReviewCard } from "../translate-run";

const review = {
	taskId: "004",
	specId: "004",
	title: "Traductions · fr",
	branch: "workpilot/004-i18n",
	baseBranch: "develop",
	files: ["public/locales/fr/common.json"],
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

const output = {
	added: 2,
	written: [{ file: "public/locales/fr/common.json", locale: "fr", count: 2 }],
	rejected: 1,
	skipped: 0,
	answered: true,
	notWritable: ["config/locales/fr.yml"],
};

describe("readTranslateRequest", () => {
	it("keeps the well-formed locales once", () => {
		expect(
			readTranslateRequest({ projectPath: "/p", referenceLocale: "en", locales: ["fr", "fr", "pt-BR", "../x", 3] }),
		).toEqual({ projectPath: "/p", referenceLocale: "en", locales: ["fr", "pt-BR"] });
	});

	it("refuses a request without a project, or with an option as the reference", () => {
		expect(readTranslateRequest({ referenceLocale: "en" })).toBeNull();
		expect(readTranslateRequest({ projectPath: "/p", referenceLocale: "--help" })).toBeNull();
		expect(readTranslateRequest(null)).toBeNull();
	});
});

describe("translateOnReviewCard", () => {
	const request = { projectPath: "/p", referenceLocale: "en", locales: ["fr"] };

	it("translates in the card's worktree and commits there", async () => {
		const run = fakeRun();
		const translator = vi.fn().mockResolvedValue(output);

		const outcome = await translateOnReviewCard(request, async () => run, translator);

		expect(translator).toHaveBeenCalledWith("/worktrees/004", request);
		expect(run.finish).toHaveBeenCalledWith(
			expect.objectContaining({ message: "feat(i18n): 2 missing translations (fr)" }),
		);
		expect(run.finish.mock.calls[0][0].summary).toContain("2 traductions");
		expect(outcome.review).toEqual(review);
		expect(outcome.notWritable).toEqual(["config/locales/fr.yml"]);
	});

	it("takes the card away when nothing was added", async () => {
		const run = fakeRun();
		const outcome = await translateOnReviewCard(request, async () => run, async () => ({
			...output,
			added: 0,
			written: [],
			answered: false,
		}));

		expect(run.abandon).toHaveBeenCalled();
		expect(run.finish).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ review: null, answered: false, added: 0 });
	});

	it("counts what was written, not what the runner claims", async () => {
		const run = fakeRun();
		const outcome = await translateOnReviewCard(request, async () => run, async () => ({
			...output,
			added: 99,
			written: [...output.written, { file: 3, locale: "fr", count: 5 } as never],
		}));

		expect(outcome.added).toBe(2);
	});

	it("takes the card away when the runner fails", async () => {
		const run = fakeRun();

		await expect(
			translateOnReviewCard(request, async () => run, async () => {
				throw new Error("no python");
			}),
		).rejects.toThrow("no python");
		expect(run.abandon).toHaveBeenCalled();
	});
});
