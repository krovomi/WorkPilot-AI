/**
 * A task's review comments (F9): listed from the spec directory by the main
 * process, added on a line, resolved or reopened by the person.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReviewComment, ReviewCommentInput } from "../../../../shared/types/review-comments";

export function useReviewComments(taskId: string, enabled = true) {
	const [comments, setComments] = useState<ReviewComment[]>([]);
	const [error, setError] = useState<string | null>(null);

	const apply = useCallback(
		(result: { success: boolean; data?: ReviewComment[]; error?: string } | undefined) => {
			if (result?.success && result.data) {
				setComments(result.data);
				setError(null);
				return true;
			}
			setError(result?.error ?? "not_writable");
			return false;
		},
		[],
	);

	const refresh = useCallback(async () => {
		try {
			const result = await window.electronAPI.listReviewComments(taskId);
			if (result.success) apply(result);
			else setComments([]); // a server card, no worktree: no comment
		} catch {
			setComments([]);
		}
	}, [taskId, apply]);

	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);

	const add = useCallback(
		async (input: ReviewCommentInput) => apply(await window.electronAPI.addReviewComment(taskId, input)),
		[taskId, apply],
	);

	const update = useCallback(
		async (id: string, action: "resolve" | "reopen" | "delete") =>
			apply(await window.electronAPI.updateReviewComment(taskId, id, action)),
		[taskId, apply],
	);

	return { comments, error, refresh, add, update };
}
