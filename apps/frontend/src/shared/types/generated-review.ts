/**
 * Code a page generates goes through a review card, never into the checkout.
 *
 * The test studio, Import Design, the changelog, pair programming and the
 * Kanban's quick-command bar used to write into the person's project folder,
 * so the code landed on whatever branch was checked out (`develop`, `main`) without a review. They now write
 * into the worktree of a Kanban card waiting in human review, on the card's
 * own branch `workpilot/<spec>`, and the person reviews the diff and opens the
 * pull request from the card, as for any task
 * (`main/generated-review/`, `docs/architecture/generated-review.md`).
 */

/** The pages that write code into a project. */
export const GENERATED_REVIEW_SOURCES = [
	"test-studio",
	"design-import",
	"changelog",
	"pair-programming",
	"quick-command",
	"accessibility",
] as const;

export type GeneratedReviewSource = (typeof GENERATED_REVIEW_SOURCES)[number];

export function isGeneratedReviewSource(value: unknown): value is GeneratedReviewSource {
	return (
		typeof value === "string" &&
		(GENERATED_REVIEW_SOURCES as readonly string[]).includes(value)
	);
}

/** Where a page's code went: the card, its branch, what the last commit changed. */
export interface GeneratedReview {
	/** The Kanban card (its id is its spec id). */
	readonly taskId: string;
	readonly specId: string;
	readonly title: string;
	/** `workpilot/<spec>`: the branch the pull request is opened from. */
	readonly branch: string;
	/** The branch the pull request targets. */
	readonly baseBranch: string;
	/** Paths, relative to the project root, the last commit changed. */
	readonly files: readonly string[];
	/** False when the run wrote nothing new (no commit was made). */
	readonly committed: boolean;
	/** True when the code joined a card already waiting for review. */
	readonly reused: boolean;
}

/** A `GeneratedReview` read back from IPC, or null when it is not one. */
export function parseGeneratedReview(raw: unknown): GeneratedReview | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	if (!text(r.taskId) || !text(r.branch)) return null;
	return {
		taskId: text(r.taskId),
		specId: text(r.specId) || text(r.taskId),
		title: text(r.title),
		branch: text(r.branch),
		baseBranch: text(r.baseBranch),
		files: Array.isArray(r.files)
			? r.files.filter((f): f is string => typeof f === "string")
			: [],
		committed: r.committed === true,
		reused: r.reused === true,
	};
}
