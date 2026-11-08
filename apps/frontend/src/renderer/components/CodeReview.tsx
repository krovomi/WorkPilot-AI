import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReviewWorkspace } from "./code-review/ReviewWorkspace";
import type { ReviewResult } from "./code-review/ReviewResults";

/** Static review of a patch, every stack, through the main process (codeInsights:run). */
export function CodeReview({ projectId }: { projectId: string }) {
	const { t } = useTranslation("codeReview");
	const [result, setResult] = useState<ReviewResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Only the latest request may update the view (a project switch or a new run discards older ones).
	const latest = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: switching projects invalidates the current analysis
	useEffect(() => {
		latest.current += 1;
		setResult(null);
		setError(null);
		setLoading(false);
	}, [projectId]);
	async function review(diff: string) {
		const id = ++latest.current;
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const report = await window.electronAPI.runCodeInsights({ action: "review", text: diff });
			if (id === latest.current) setResult(report);
		} catch (e) {
			if (id === latest.current)
				setError(e instanceof Error && e.message ? e.message : t("errors.reviewFailed"));
		} finally {
			if (id === latest.current) setLoading(false);
		}
	}
	return (
		<ReviewWorkspace
			key={projectId}
			projectId={projectId}
			onReview={review}
			result={result}
			loading={loading}
			error={error}
		/>
	);
}
