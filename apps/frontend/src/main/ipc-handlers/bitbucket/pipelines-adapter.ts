/**
 * Bitbucket Pipelines for the « Build rouge » loop (`ci-pipeline-providers.ts`):
 * the latest pipeline on a task's branch, and the steps that failed. Same
 * config and API path as the Bitbucket views (`utils.ts`), so the token only
 * goes to api.bitbucket.org.
 */

import type { PipelineRunState } from "../../../shared/types";
import type { PipelineProviderAdapter, PipelineRun } from "../../ci-pipeline-providers";
import { toPipeline, toPipelineStep } from "./transform";
import {
	type BitbucketConfig,
	bitbucketConfigFromEnv,
	bitbucketFetch,
	bitbucketFetchAll,
	isPipelineUuid,
	repoPath,
} from "./utils";

const MAX_ERROR_LINES = 40;

/** Bitbucket's pipeline state (see `pipelineState`) as the loop names it. */
export function runState(state: string): PipelineRunState {
	switch (state) {
		case "SUCCESSFUL":
			return "succeeded";
		case "FAILED":
		case "ERROR":
			return "failed";
		case "STOPPED":
		case "EXPIRED":
			return "canceled";
		case "RUNNING":
		case "IN_PROGRESS":
			return "running";
		default: // PENDING, PAUSED, HALTED…
			return "queued";
	}
}

const FAILED_STEP = new Set(["FAILED", "ERROR"]);

export class BitbucketPipelinesAdapter implements PipelineProviderAdapter {
	readonly id = "bitbucket-pipelines" as const;
	readonly label = "Bitbucket Pipelines";

	constructor(private readonly cfg: BitbucketConfig) {}

	async fetchLatestRun(branch: string): Promise<PipelineRun | null> {
		const query = `target.ref_name=${encodeURIComponent(branch)}&sort=-created_on&pagelen=1`;
		const body = (await bitbucketFetch(this.cfg, `${repoPath(this.cfg)}/pipelines/?${query}`)) as {
			values?: unknown[];
		};
		const raw = Array.isArray(body?.values) ? body.values[0] : undefined;
		if (!raw) return null;
		const web = `https://bitbucket.org/${encodeURIComponent(this.cfg.workspace)}/${encodeURIComponent(this.cfg.repo)}`;
		const pipeline = toPipeline(raw, web);
		if (!isPipelineUuid(pipeline.uuid)) return null;
		return {
			state: runState(pipeline.state),
			runId: pipeline.uuid,
			runNumber: `#${pipeline.buildNumber}`,
			definitionName: pipeline.branch,
			webUrl: pipeline.webUrl || undefined,
			queueTime: pipeline.createdOn || undefined,
			finishTime: pipeline.completedOn,
		};
	}

	async fetchRunErrors(run: PipelineRun): Promise<string[]> {
		if (!isPipelineUuid(run.runId)) return [];
		const steps = await bitbucketFetchAll<unknown>(
			this.cfg,
			`${repoPath(this.cfg)}/pipelines/${encodeURIComponent(run.runId)}/steps/?pagelen=100`,
		);
		return steps
			.map(toPipelineStep)
			.filter((step) => FAILED_STEP.has(step.state))
			.slice(0, MAX_ERROR_LINES)
			.map((step) => `[${step.name}] ${step.state.toLowerCase()}`);
	}
}

/** The adapter of a project whose `.env` turns Bitbucket on with a complete config, else null. */
export function bitbucketPipelinesAdapter(env: Record<string, string>): BitbucketPipelinesAdapter | null {
	const cfg = bitbucketConfigFromEnv(env);
	return cfg ? new BitbucketPipelinesAdapter(cfg) : null;
}
