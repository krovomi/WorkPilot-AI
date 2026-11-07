/**
 * The shared features a server project offers beyond its board, as the
 * server answers (`apps/backend/shared_features/`): Insights conversations,
 * the roadmap and the ideas, each written by a project job on the clone.
 */

/** A project job (`shared_features.api.job_public`). */
export interface FeatureJob {
	id: string;
	feature: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
	started_by: string | null;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
}

export interface FeatureJobOutput extends FeatureJob {
	lines: string[];
	next: number;
}

export const JOB_ACTIVE = new Set(["queued", "running"]);

/** `GET /api/features/<key>/snapshot`: the feature's files and its last job. */
export interface FeatureSnapshot {
	files: Record<string, { content: string; sha256: string }>;
	job: FeatureJob | null;
}

export interface InsightSummary {
	id: string;
	title: string;
	messageCount: number;
	createdAt: string | null;
	updatedAt: string | null;
	ownerId: string | null;
	ownerName: string | null;
	mine: boolean;
}

export interface InsightMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp?: string;
	suggestedTask?: { title?: string; description?: string } | null;
}

export interface InsightSession extends InsightSummary {
	messages: InsightMessage[];
	/** The job writing an answer, while one runs. */
	jobId: string | null;
}
