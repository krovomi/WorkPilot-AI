/**
 * The pull requests and pipelines of a project's Bitbucket repository: the
 * list in one of three states, a pull request's files and diff (cut at a
 * bound), its comments, the latest pipelines and a pipeline's steps.
 * Arguments are checked by `ipc-guard.ts` first. Creating a pull request
 * from a task's worktree goes through the task's "Create PR" (the backend's
 * `core/bitbucket_pr.py`), like the other forges.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	BitbucketPullRequestDiff,
	BitbucketPullRequestState,
} from "../../../shared/types";
import { bitbucketIpcMain } from "./ipc-guard";
import { withBitbucketProject } from "./project-bitbucket";
import {
	isLiveComment,
	toComment,
	toDiffFile,
	toPipeline,
	toPipelineStep,
	toPullRequest,
} from "./transform";
import { type BitbucketConfig, bitbucketFetch, bitbucketFetchAll, repoPath } from "./utils";

/** The diff a view shows at most. */
export const MAX_DIFF_CHARS = 500_000;
const PIPELINES_PER_PAGE = 20;

const repoWebUrl = (config: BitbucketConfig) =>
	`https://bitbucket.org/${encodeURIComponent(config.workspace)}/${encodeURIComponent(config.repo)}`;

async function pullRequestDiff(config: BitbucketConfig, id: number): Promise<BitbucketPullRequestDiff> {
	const base = `${repoPath(config)}/pullrequests/${id}`;
	const [stats, diff] = await Promise.all([
		bitbucketFetchAll<unknown>(config, `${base}/diffstat?pagelen=100`),
		bitbucketFetch(config, `${base}/diff`, { as: "text" }),
	]);
	const text = diff as string;
	return {
		files: stats.map(toDiffFile),
		diff: text.slice(0, MAX_DIFF_CHARS),
		truncated: text.length > MAX_DIFF_CHARS,
	};
}

export function registerBitbucketPullRequestHandlers(): void {
	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS,
		(_event, projectId: string, state: BitbucketPullRequestState = "OPEN") =>
			withBitbucketProject(projectId, "get pull requests", async (config) =>
				(
					await bitbucketFetchAll<unknown>(
						config,
						`${repoPath(config)}/pullrequests?state=${state}&pagelen=50&sort=-updated_on`,
					)
				).map(toPullRequest),
			),
	);

	bitbucketIpcMain.handle(IPC_CHANNELS.BITBUCKET_GET_PR_DIFF, (_event, projectId: string, id: number) =>
		withBitbucketProject(projectId, "get the diff", (config) => pullRequestDiff(config, id)),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_PR_COMMENTS,
		(_event, projectId: string, id: number) =>
			withBitbucketProject(projectId, "get comments", async (config) =>
				(
					await bitbucketFetchAll<unknown>(
						config,
						`${repoPath(config)}/pullrequests/${id}/comments?pagelen=100&sort=created_on`,
					)
				)
					.filter(isLiveComment)
					.map(toComment),
			),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_PIPELINES,
		(_event, projectId: string, page = 1) =>
			withBitbucketProject(projectId, "get pipelines", async (config) => {
				const body = (await bitbucketFetch(
					config,
					`${repoPath(config)}/pipelines/?sort=-created_on&pagelen=${PIPELINES_PER_PAGE}&page=${page}`,
				)) as { values?: unknown[] };
				const web = repoWebUrl(config);
				return (Array.isArray(body?.values) ? body.values : []).map((p) => toPipeline(p, web));
			}),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_PIPELINE_STEPS,
		(_event, projectId: string, uuid: string) =>
			withBitbucketProject(projectId, "get pipeline steps", async (config) =>
				(
					await bitbucketFetchAll<unknown>(
						config,
						`${repoPath(config)}/pipelines/${encodeURIComponent(uuid)}/steps/?pagelen=100`,
					)
				).map(toPipelineStep),
			),
	);
}
