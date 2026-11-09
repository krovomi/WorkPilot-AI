/**
 * The renderer names a folder; only a project of this computer gets a card.
 * Anything else is refused before a branch is made (S6: the renderer is not
 * trusted to point at any folder).
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { projects, openMock } = vi.hoisted(() => ({
	projects: [] as Array<Record<string, unknown>>,
	openMock: vi.fn(),
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => projects },
}));
vi.mock("../review-card", () => ({
	openReviewWorkspace: (...args: unknown[]) => openMock(...args),
	recordReviewStep: vi.fn(),
	abandonReviewWorkspace: vi.fn(),
	toWorkspacePath: (_p: string, w: string, t?: string) => (t ? path.join(w, path.basename(t)) : t),
}));

import { findLocalProject, openReviewRun, ReviewUnavailableError } from "../review-run";

const local = path.join(path.sep, "work", "demo");

beforeEach(() => {
	projects.length = 0;
	projects.push(
		{ id: "local", path: local },
		{ id: "server", path: path.join(path.sep, "mirror"), remote: { serverUrl: "https://x" } },
	);
	openMock.mockReset().mockResolvedValue({
		worktreePath: path.join(local, ".workpilot", "worktrees", "tasks", "001-a"),
	});
});

describe("openReviewRun", () => {
	it("opens the card of a local project and writes into its worktree", async () => {
		const run = await openReviewRun(`${local}${path.sep}`, "test-studio", "A");

		expect(openMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "local" }),
			{ source: "test-studio", subject: "A", description: undefined },
			undefined,
		);
		expect(run.root).toBe(path.join(local, ".workpilot", "worktrees", "tasks", "001-a"));
	});

	it("refuses a folder that is not a local project, and a server project", async () => {
		await expect(openReviewRun(path.join(path.sep, "tmp"), "test-studio", "A")).rejects.toBeInstanceOf(
			ReviewUnavailableError,
		);
		await expect(openReviewRun(path.join(path.sep, "mirror"), "test-studio", "A")).rejects.toBeInstanceOf(
			ReviewUnavailableError,
		);
		await expect(openReviewRun(undefined, "test-studio", "A")).rejects.toBeInstanceOf(
			ReviewUnavailableError,
		);
		expect(openMock).not.toHaveBeenCalled();
		expect(findLocalProject(local)?.id).toBe("local");
	});

	it("says nothing was written when the branch cannot be prepared", async () => {
		openMock.mockRejectedValueOnce(new Error("not a git repository"));

		const failure = await openReviewRun(local, "test-studio", "A").catch((e) => e);

		expect(failure).toBeInstanceOf(ReviewUnavailableError);
		expect(failure.message).toMatch(/nothing was written/);
		expect(failure.details).toBe("not a git repository");
	});
});
