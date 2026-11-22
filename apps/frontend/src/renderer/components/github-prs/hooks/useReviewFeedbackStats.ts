/**
 * The project's feedback on PR review findings, as a whole (#361, lot 2):
 * acceptance rate per category, learned rules, reset, conventions file, and
 * on a server project the rejections held for a maintainer (lot 3). Loaded on
 * demand; the main process reads and validates everything.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ReviewFeedbackError,
	ReviewFeedbackStats,
	ReviewFeedbackStatsResult,
} from "../../../../shared/types/review-feedback";

export interface ConventionsWritten {
	path: string;
	rules: number;
}

export interface ReviewFeedbackStatsState {
	stats: ReviewFeedbackStats | null;
	loading: boolean;
	error: ReviewFeedbackError | null;
	pendingSignature: string | null;
	/** `<pr>:<finding>` of the held rejection being decided. */
	pendingHeld: string | null;
	writing: boolean;
	written: ConventionsWritten | null;
	load: () => Promise<void>;
	reset: (signature: string) => Promise<void>;
	decide: (prNumber: number, findingId: string, approve: boolean) => Promise<void>;
	writeConventions: () => Promise<void>;
}

export function useReviewFeedbackStats(
	projectId: string | undefined,
): ReviewFeedbackStatsState {
	const [stats, setStats] = useState<ReviewFeedbackStats | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<ReviewFeedbackError | null>(null);
	const [pendingSignature, setPendingSignature] = useState<string | null>(null);
	const [pendingHeld, setPendingHeld] = useState<string | null>(null);
	const [writing, setWriting] = useState(false);
	const [written, setWritten] = useState<ConventionsWritten | null>(null);
	// The project the answers are for: a late answer for another one is dropped.
	const current = useRef(projectId);

	useEffect(() => {
		current.current = projectId;
		setStats(null);
		setError(null);
		setWritten(null);
	}, [projectId]);

	/** `update` only while the view still shows the project that was asked about. */
	const forCurrent = useCallback((asked: string, update: () => void) => {
		if (current.current === asked) update();
	}, []);

	const apply = useCallback(
		(asked: string, result: ReviewFeedbackStatsResult) =>
			forCurrent(asked, () => {
				if (result.success) {
					setStats(result.stats);
					setError(null);
				} else {
					setError(result.error);
				}
			}),
		[forCurrent],
	);

	const load = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		try {
			apply(
				projectId,
				await window.electronAPI.github.getReviewFeedbackStats(projectId),
			);
		} catch {
			forCurrent(projectId, () => setError("not_found"));
		} finally {
			setLoading(false);
		}
	}, [projectId, apply, forCurrent]);

	const reset = useCallback(
		async (signature: string) => {
			if (!projectId) return;
			setPendingSignature(signature);
			try {
				apply(
					projectId,
					await window.electronAPI.github.resetReviewFeedbackRule(
						projectId,
						signature,
					),
				);
			} catch {
				forCurrent(projectId, () => setError("write_failed"));
			} finally {
				setPendingSignature(null);
			}
		},
		[projectId, apply, forCurrent],
	);

	const decide = useCallback(
		async (prNumber: number, findingId: string, approve: boolean) => {
			if (!projectId) return;
			setPendingHeld(`${prNumber}:${findingId}`);
			try {
				apply(
					projectId,
					await window.electronAPI.github.decideHeldReviewFeedback(
						projectId,
						prNumber,
						findingId,
						approve,
					),
				);
			} catch {
				forCurrent(projectId, () => setError("write_failed"));
			} finally {
				setPendingHeld(null);
			}
		},
		[projectId, apply, forCurrent],
	);

	const writeConventions = useCallback(async () => {
		if (!projectId) return;
		setWriting(true);
		setWritten(null);
		try {
			const result =
				await window.electronAPI.github.writeReviewConventions(projectId);
			forCurrent(projectId, () => {
				if (result.success) {
					setWritten({ path: result.path, rules: result.rules });
					setError(null);
				} else if (result.error !== "cancelled") {
					setError(result.error);
				}
			});
		} catch {
			forCurrent(projectId, () => setError("write_failed"));
		} finally {
			setWriting(false);
		}
	}, [projectId, forCurrent]);

	return {
		stats,
		loading,
		error,
		pendingSignature,
		pendingHeld,
		writing,
		written,
		load,
		reset,
		decide,
		writeConventions,
	};
}
