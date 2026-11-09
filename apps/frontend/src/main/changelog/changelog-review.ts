/**
 * « Enregistrer » of the changelog page, on a review card's branch.
 *
 * The page used to prepend the new version to CHANGELOG.md in the project
 * folder, so on whatever branch was checked out (develop, main) with no
 * review. It now writes the file in the worktree of a Kanban card, commits
 * it there and puts the card in human review; the person opens the pull
 * request from the card (docs/architecture/generated-review.md).
 *
 * Images pasted into the text wait in `.workpilot/changelog-assets/` (never
 * committed) and join the commit, under `.github/assets/`, with the text
 * that references them.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CHANGELOG_PATH } from "../../shared/constants";
import type { ChangelogSaveRequest, ChangelogSaveResult } from "../../shared/types";
import { getAppLanguage } from "../app-language";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { resolveUnder, resolveWritableUnder } from "../security/renderer-path";

/** Where pasted images wait for the save, inside the project. */
export const STAGED_ASSETS_DIR = path.join(".workpilot", "changelog-assets");
/** Where the text references them, and where the commit puts them. */
const ASSETS_REF = /\.github\/assets\/([\w.-]+)/g;

/** The staged image a `.github/assets/<name>` reference points to, if any. */
export function stagedAsset(projectPath: string, relative: unknown): string | undefined {
	if (typeof relative !== "string") return undefined;
	const match = /^\.github\/assets\/([\w.-]+)$/.exec(relative);
	const name = match?.[1];
	if (!name || name.startsWith(".")) return undefined;
	// Resolved, links included, inside the project: only a plain file.
	return resolveUnder(projectPath, path.join(STAGED_ASSETS_DIR, name), "file") ?? undefined;
}

/** Copy the staged images the text references into the worktree. */
function bringAssets(projectPath: string, worktree: string, content: string): string[] {
	const staged: string[] = [];
	for (const match of content.matchAll(ASSETS_REF)) {
		const source = stagedAsset(projectPath, match[0]);
		if (!source) continue;
		const target = path.join(worktree, ".github", "assets", path.basename(source));
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(source, target);
		staged.push(source);
	}
	return staged;
}

type OpenRun = (projectPath: string, source: "changelog", subject: string) => Promise<ReviewRun>;

/** Writes `CHANGELOG.md` (or the file named) into the given folder. */
type SaveIn = (root: string, request: ChangelogSaveRequest) => ChangelogSaveResult;

const STEP_SUMMARY = {
	en: (subject: string) => `Changelog: ${subject}`,
	fr: (subject: string) => `Journal des modifications : ${subject}`,
};

/** The version the new entry is about, read from its first heading. */
export function changelogVersion(content: string): string | undefined {
	const heading = content.split("\n").find((line) => /^#{1,3}\s/.test(line));
	const match = heading?.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
	return match ? match[1] : undefined;
}

/** A path WorkPilot keeps out of every commit, or git's own. */
function isInternal(relative: string): boolean {
	const first = relative.split(/[\\/]+/).find(Boolean)?.toLowerCase() ?? "";
	return first === ".git" || first.startsWith(".workpilot");
}

export async function saveChangelogForReview(
	projectPath: string,
	request: ChangelogSaveRequest,
	saveIn: SaveIn,
	openRun: OpenRun = openReviewRun,
): Promise<ChangelogSaveResult> {
	const relative = request.filePath || DEFAULT_CHANGELOG_PATH;
	// Checked before a card is opened: a refused path leaves nothing behind.
	if (isInternal(relative) || !resolveWritableUnder(projectPath, relative)) {
		throw new Error("The changelog file must be inside the project");
	}
	const version = changelogVersion(request.content);
	const subject = version ?? path.basename(relative);
	const run = await openRun(projectPath, "changelog", subject);
	try {
		const saved = saveIn(run.root, { ...request, filePath: relative });
		const staged = bringAssets(projectPath, run.root, request.content);
		const review = await run.finish({
			message: version ? `docs(changelog): add ${version}` : `docs(changelog): update ${relative}`,
			summary: STEP_SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](subject),
		});
		// Committed: the images live on the card's branch now.
		for (const file of staged) rmSync(file, { force: true });
		return { ...saved, filePath: relative, review: review.committed ? review : null };
	} catch (error) {
		await run.abandon().catch(() => undefined);
		throw error;
	}
}
