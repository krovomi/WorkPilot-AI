/**
 * Rule candidates from rejected plans (plan of 29 October, IA1).
 *
 * The feedback a person types when rejecting a plan is handed to the backend,
 * which keeps it as a candidate in the project's
 * `.workpilot/learning/review-lessons.json`. Nothing reaches a prompt until
 * the person adopts it in the Learning Loop.
 */
import { backendFetch } from "./ipc-handlers/_backend-fetch";

/** Fire and forget: a backend that is down costs a candidate, never the review. */
export async function recordPlanFeedback(
	projectDir: string,
	specId: string,
	feedback: string | undefined,
): Promise<boolean> {
	const text = feedback?.trim();
	if (!text) return false;
	try {
		const result = await backendFetch<{ recorded?: boolean }>(
			"/api/brain/review-lessons/plan-feedback",
			{
				method: "POST",
				body: JSON.stringify({
					project_dir: projectDir,
					spec_id: specId,
					feedback: text,
				}),
			},
			10_000,
		);
		return result.success && result.recorded === true;
	} catch {
		return false;
	}
}
