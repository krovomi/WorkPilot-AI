/**
 * Bitbucket Cloud API: a project's repository, issues, pull requests and
 * pipelines. Every call names a project id; the main process reads the
 * token from the project's settings (main/ipc-handlers/bitbucket/).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	BitbucketComment,
	BitbucketImportResult,
	BitbucketIssueFilter,
	BitbucketIssueList,
	BitbucketPipeline,
	BitbucketPipelineStep,
	BitbucketPullRequest,
	BitbucketPullRequestDiff,
	BitbucketPullRequestState,
	BitbucketSyncStatus,
	IPCResult,
} from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface BitbucketAPI {
	checkConnection: (projectId: string) => Promise<IPCResult<BitbucketSyncStatus>>;
	getIssues: (
		projectId: string,
		filter?: BitbucketIssueFilter,
	) => Promise<IPCResult<BitbucketIssueList>>;
	getIssueComments: (projectId: string, id: number) => Promise<IPCResult<BitbucketComment[]>>;
	importIssues: (projectId: string, ids: number[]) => Promise<IPCResult<BitbucketImportResult>>;
	getPullRequests: (
		projectId: string,
		state?: BitbucketPullRequestState,
	) => Promise<IPCResult<BitbucketPullRequest[]>>;
	getPullRequestDiff: (
		projectId: string,
		id: number,
	) => Promise<IPCResult<BitbucketPullRequestDiff>>;
	getPullRequestComments: (
		projectId: string,
		id: number,
	) => Promise<IPCResult<BitbucketComment[]>>;
	getPipelines: (projectId: string, page?: number) => Promise<IPCResult<BitbucketPipeline[]>>;
	getPipelineSteps: (
		projectId: string,
		uuid: string,
	) => Promise<IPCResult<BitbucketPipelineStep[]>>;
}

export const createBitbucketAPI = (): BitbucketAPI => ({
	checkConnection: (projectId) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, projectId),
	getIssues: (projectId, filter) => invokeIpc(IPC_CHANNELS.BITBUCKET_GET_ISSUES, projectId, filter),
	getIssueComments: (projectId, id) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS, projectId, id),
	importIssues: (projectId, ids) => invokeIpc(IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, projectId, ids),
	getPullRequests: (projectId, state) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS, projectId, state),
	getPullRequestDiff: (projectId, id) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PR_DIFF, projectId, id),
	getPullRequestComments: (projectId, id) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PR_COMMENTS, projectId, id),
	getPipelines: (projectId, page) => invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PIPELINES, projectId, page),
	getPipelineSteps: (projectId, uuid) =>
		invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PIPELINE_STEPS, projectId, uuid),
});
