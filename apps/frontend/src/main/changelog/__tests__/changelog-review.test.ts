/**
 * « Enregistrer » writes CHANGELOG.md on a review card's branch: never in the
 * project folder, never outside it, and a failed save leaves no card.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogSaveRequest, ChangelogSaveResult } from "../../../shared/types";

vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../generated-review/review-run", () => ({
	openReviewRun: () => Promise.reject(new Error("no review run in this test")),
}));
vi.mock("../../project-store", () => ({ projectStore: { getProjects: () => [] } }));
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }));

import { changelogVersion, saveChangelogForReview } from "../changelog-review";

let root: string;
let project: string;
let worktree: string;
let run: {
	root: string;
	map: (t: string | undefined) => string | undefined;
	finish: ReturnType<typeof vi.fn>;
	abandon: ReturnType<typeof vi.fn>;
};
let openRun: ReturnType<typeof vi.fn>;
const review = {
	taskId: "002-changelog",
	specId: "002-changelog",
	title: "Mise à jour du changelog : 1.4.0",
	branch: "workpilot/002-changelog",
	baseBranch: "develop",
	files: ["CHANGELOG.md"],
	committed: true,
	reused: false,
};

/** Prepend, like the service. */
const saveIn = (dir: string, request: ChangelogSaveRequest): ChangelogSaveResult => {
	const file = path.join(dir, request.filePath ?? "CHANGELOG.md");
	let existing = "";
	try {
		existing = readFileSync(file, "utf-8");
	} catch {
		// No changelog yet.
	}
	const content = existing ? `${request.content}\n\n${existing}` : request.content;
	writeFileSync(file, content, "utf-8");
	return { filePath: file, bytesWritten: Buffer.byteLength(content) };
};

const request = (content: string, filePath?: string): ChangelogSaveRequest => ({
	projectId: "p1",
	content,
	filePath,
	mode: "prepend",
});

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "changelog-review-")));
	project = path.join(root, "project");
	worktree = path.join(project, ".workpilot", "worktrees", "tasks", "002-changelog");
	mkdirSync(worktree, { recursive: true });
	writeFileSync(path.join(worktree, "CHANGELOG.md"), "## 1.3.0\n", "utf-8");
	run = {
		root: worktree,
		map: (t) => t,
		finish: vi.fn(async () => review),
		abandon: vi.fn(async () => undefined),
	};
	openRun = vi.fn(async () => run);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("saveChangelogForReview", () => {
	it("prepends the version on the card's branch and commits it", async () => {
		const result = await saveChangelogForReview(
			project,
			request("## [1.4.0] - 2026-11-09\n\n- Fix"),
			saveIn,
			openRun as never,
		);

		expect(openRun).toHaveBeenCalledWith(project, "changelog", "1.4.0");
		expect(run.finish).toHaveBeenCalledWith({
			message: "docs(changelog): add 1.4.0",
			summary: "Journal des modifications : 1.4.0",
		});
		expect(result).toMatchObject({ filePath: "CHANGELOG.md", review });
		expect(readFileSync(path.join(worktree, "CHANGELOG.md"), "utf-8")).toBe(
			"## [1.4.0] - 2026-11-09\n\n- Fix\n\n## 1.3.0\n",
		);
		expect(existsSync(path.join(project, "CHANGELOG.md"))).toBe(false);
	});

	it("commits the pasted images the text references, then clears them from staging", async () => {
		const staging = path.join(project, ".workpilot", "changelog-assets");
		mkdirSync(staging, { recursive: true });
		writeFileSync(path.join(staging, "shot.png"), "png");
		writeFileSync(path.join(staging, "unused.png"), "png");

		await saveChangelogForReview(
			project,
			request("## 1.4.0\n\n![shot](.github/assets/shot.png)"),
			saveIn,
			openRun as never,
		);

		expect(readFileSync(path.join(worktree, ".github", "assets", "shot.png"), "utf-8")).toBe("png");
		expect(existsSync(path.join(worktree, ".github", "assets", "unused.png"))).toBe(false);
		expect(existsSync(path.join(staging, "shot.png"))).toBe(false);
		expect(existsSync(path.join(staging, "unused.png"))).toBe(true);
		expect(existsSync(path.join(project, ".github"))).toBe(false);
	});

	it("refuses a file outside the project or in its WorkPilot folder, before any card", async () => {
		for (const filePath of ["../escape.md", path.join(root, "abs.md"), ".workpilot/x.md", ".git/config"]) {
			await expect(
				saveChangelogForReview(project, request("## 1.0.0", filePath), saveIn, openRun as never),
			).rejects.toThrow("inside the project");
		}
		expect(openRun).not.toHaveBeenCalled();
		expect(existsSync(path.join(root, "escape.md"))).toBe(false);
	});

	it("takes the card back when the commit fails", async () => {
		run.finish.mockRejectedValueOnce(new Error("git has no author identity"));
		await expect(
			saveChangelogForReview(project, request("## 1.4.0"), saveIn, openRun as never),
		).rejects.toThrow("git has no author identity");
		expect(run.abandon).toHaveBeenCalled();
	});

	it("reports no card when the commit had nothing new", async () => {
		run.finish.mockResolvedValueOnce({ ...review, committed: false, files: [] });
		const result = await saveChangelogForReview(project, request("notes"), saveIn, openRun as never);
		expect(result.review).toBeNull();
		expect(run.finish).toHaveBeenCalledWith(
			expect.objectContaining({ message: "docs(changelog): update CHANGELOG.md" }),
		);
	});
});

describe("changelogVersion", () => {
	it.each([
		["## [1.4.0] - 2026-11-09", "1.4.0"],
		["# v2.0.0-rc.1", "2.0.0-rc.1"],
		["### 10.2.3 (2026-01-01)", "10.2.3"],
		["Some notes\n## Unreleased", undefined],
	])("reads %j", (content, version) => {
		expect(changelogVersion(content)).toBe(version);
	});
});
