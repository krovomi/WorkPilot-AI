/**
 * The feedback given on the findings of one PR review (#361): loaded when the
 * PR changes, updated by each click. The main process validates and stores it.
 */

import { useCallback, useEffect, useState } from "react";
import type {
	ReviewFeedbackError,
	ReviewFeedbackInput,
	ReviewFeedbackMap,
} from "../../../../shared/types/review-feedback";

export interface FindingFeedbackState {
	feedback: ReviewFeedbackMap;
	error: ReviewFeedbackError | null;
	pendingId: string | null;
	submit: (input: ReviewFeedbackInput) => Promise<boolean>;
}

export function useFindingFeedback(
	projectId: string | undefined,
	prNumber: number | undefined,
): FindingFeedbackState {
	const [feedback, setFeedback] = useState<ReviewFeedbackMap>({});
	const [error, setError] = useState<ReviewFeedbackError | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);

	useEffect(() => {
		setFeedback({});
		setError(null);
		if (!projectId || !prNumber) return;
		let cancelled = false;
		window.electronAPI.github
			.getReviewFindingFeedback(projectId, prNumber)
			.then((result) => {
				if (cancelled) return;
				if (result.success) setFeedback(result.feedback);
			})
			.catch(() => {
				// Feedback is optional: the review stays usable without it.
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, prNumber]);

	const submit = useCallback(
		async (input: ReviewFeedbackInput): Promise<boolean> => {
			if (!projectId || !prNumber) return false;
			setPendingId(input.findingId);
			try {
				const result = await window.electronAPI.github.setReviewFindingFeedback(
					projectId,
					prNumber,
					input,
				);
				if (result.success) {
					setFeedback(result.feedback);
					setError(null);
					return true;
				}
				setError(result.error);
				return false;
			} catch {
				setError("write_failed");
				return false;
			} finally {
				setPendingId(null);
			}
		},
		[projectId, prNumber],
	);

	return { feedback, error, pendingId, submit };
}
