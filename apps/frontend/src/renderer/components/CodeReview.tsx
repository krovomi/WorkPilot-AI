import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReviewWorkspace } from "./code-review/ReviewWorkspace";
import type { ReviewResult } from "./code-review/ReviewResults";
export function CodeReview({ projectId }: { projectId: string }) {
	const { t } = useTranslation("codeReview");
	const [result, setResult] = useState<ReviewResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<AbortController | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: switching projects invalidates the current analysis
	useEffect(() => {
		setResult(null);
		setError(null);
		setLoading(false);
		return () => request.current?.abort();
	}, [projectId]);
	async function review(diff: string) {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const response = await fetch(
				`${import.meta.env?.VITE_BACKEND_URL || ""}/api/code-review/analyze`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ diff }),
					signal: controller.signal,
				},
			);
			if (!response.ok) throw new Error(t("errors.reviewFailed"));
			const data = await response.json();
			if (!data.success)
				throw new Error(data.error || t("errors.reviewFailed"));
			if (!controller.signal.aborted) setResult(data.review);
		} catch (e) {
			if (!controller.signal.aborted)
				setError(e instanceof Error ? e.message : t("errors.networkError"));
		} finally {
			if (!controller.signal.aborted) setLoading(false);
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
