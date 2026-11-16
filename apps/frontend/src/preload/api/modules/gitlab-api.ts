import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	GitLabImportResult,
	GitLabInvestigationResult,
	GitLabInvestigationStatus,
	GitLabIssue,
	GitLabMergeRequest,
	GitLabMRReviewProgress,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
	GitLabNote,
	GitLabSyncStatus,
	IPCResult,
} from "../../../shared/types";
import {
	createIpcListener,
	type IpcListenerCleanup,
	invokeIpc,
	sendIpc,
} from "./ipc-utils";

/**
 * GitLab Integration API operations
 */
export interface GitLabAPI {
	checkGitLabConnection: (
		projectId: string,
	) => Promise<IPCResult<GitLabSyncStatus>>;

	// Issue operations
	getGitLabIssues: (
		projectId: string,
		state?: "opened" | "closed" | "all",
	) => Promise<IPCResult<GitLabIssue[]>>;
	getGitLabIssueNotes: (
		projectId: string,
		issueIid: number,
	) => Promise<IPCResult<GitLabNote[]>>;
	investigateGitLabIssue: (
		projectId: string,
		issueIid: number,
		selectedNoteIds?: number[],
	) => void;
	importGitLabIssues: (
		projectId: string,
		issueIids: number[],
	) => Promise<IPCResult<GitLabImportResult>>;

	// Merge Request operations
	getGitLabMergeRequests: (
		projectId: string,
		state?: string,
	) => Promise<IPCResult<GitLabMergeRequest[]>>;
	createGitLabMergeRequest: (
		projectId: string,
		options: {
			title: string;
			description?: string;
			sourceBranch: string;
			targetBranch: string;
			labels?: string[];
			assigneeIds?: number[];
			removeSourceBranch?: boolean;
			squash?: boolean;
		},
	) => Promise<IPCResult<GitLabMergeRequest>>;
	// MR Review operations (AI-powered)
	getGitLabMRReview: (
		projectId: string,
		mrIid: number,
	) => Promise<GitLabMRReviewResult | null>;
	runGitLabMRReview: (projectId: string, mrIid: number) => void;
	runGitLabMRFollowupReview: (projectId: string, mrIid: number) => void;
	postGitLabMRReview: (
		projectId: string,
		mrIid: number,
		selectedFindingIds?: string[],
	) => Promise<boolean>;
	postGitLabMRNote: (
		projectId: string,
		mrIid: number,
		body: string,
	) => Promise<boolean>;
	mergeGitLabMR: (
		projectId: string,
		mrIid: number,
		mergeMethod?: "merge" | "squash" | "rebase",
	) => Promise<boolean>;
	assignGitLabMR: (
		projectId: string,
		mrIid: number,
		userIds: number[],
	) => Promise<boolean>;
	approveGitLabMR: (projectId: string, mrIid: number) => Promise<boolean>;
	cancelGitLabMRReview: (projectId: string, mrIid: number) => Promise<boolean>;
	checkGitLabMRNewCommits: (
		projectId: string,
		mrIid: number,
	) => Promise<GitLabNewCommitsCheck>;

	// MR Review Event Listeners
	onGitLabMRReviewProgress: (
		callback: (projectId: string, progress: GitLabMRReviewProgress) => void,
	) => IpcListenerCleanup;
	onGitLabMRReviewComplete: (
		callback: (projectId: string, result: GitLabMRReviewResult) => void,
	) => IpcListenerCleanup;
	onGitLabMRReviewError: (
		callback: (
			projectId: string,
			data: { mrIid: number; error: string },
		) => void,
	) => IpcListenerCleanup;

	// OAuth operations (glab CLI)
	checkGitLabCli: () => Promise<
		IPCResult<{ installed: boolean; version?: string }>
	>;
	installGitLabCli: () => Promise<IPCResult<{ command: string }>>;
	checkGitLabAuth: (
		instanceUrl?: string,
	) => Promise<IPCResult<{ authenticated: boolean; username?: string }>>;
	startGitLabAuth: (
		instanceUrl?: string,
	) => Promise<
		IPCResult<{ deviceCode: string; verificationUrl: string; userCode: string }>
	>;
	getGitLabToken: (
		instanceUrl?: string,
	) => Promise<IPCResult<{ token: string }>>;
	getGitLabUser: (
		instanceUrl?: string,
	) => Promise<IPCResult<{ username: string; name?: string }>>;
	listGitLabUserProjects: (instanceUrl?: string) => Promise<
		IPCResult<{
			projects: Array<{
				pathWithNamespace: string;
				description: string | null;
				visibility: string;
			}>;
		}>
	>;

	// Event Listeners
	onGitLabInvestigationProgress: (
		callback: (projectId: string, status: GitLabInvestigationStatus) => void,
	) => IpcListenerCleanup;
	onGitLabInvestigationComplete: (
		callback: (projectId: string, result: GitLabInvestigationResult) => void,
	) => IpcListenerCleanup;
	onGitLabInvestigationError: (
		callback: (projectId: string, error: string) => void,
	) => IpcListenerCleanup;
}

/**
 * Creates the GitLab Integration API implementation
 */
export const createGitLabAPI = (): GitLabAPI => ({
	checkGitLabConnection: (
		projectId: string,
	): Promise<IPCResult<GitLabSyncStatus>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_CHECK_CONNECTION, projectId),

	// Issue operations
	getGitLabIssues: (
		projectId: string,
		state?: "opened" | "closed" | "all",
	): Promise<IPCResult<GitLabIssue[]>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_GET_ISSUES, projectId, state),

	getGitLabIssueNotes: (
		projectId: string,
		issueIid: number,
	): Promise<IPCResult<GitLabNote[]>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES, projectId, issueIid),

	investigateGitLabIssue: (
		projectId: string,
		issueIid: number,
		selectedNoteIds?: number[],
	): void =>
		sendIpc(
			IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE,
			projectId,
			issueIid,
			selectedNoteIds,
		),

	importGitLabIssues: (
		projectId: string,
		issueIids: number[],
	): Promise<IPCResult<GitLabImportResult>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_IMPORT_ISSUES, projectId, issueIids),

	// Merge Request operations
	getGitLabMergeRequests: (
		projectId: string,
		state?: string,
	): Promise<IPCResult<GitLabMergeRequest[]>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS, projectId, state),

	createGitLabMergeRequest: (
		projectId: string,
		options: {
			title: string;
			description?: string;
			sourceBranch: string;
			targetBranch: string;
			labels?: string[];
			assigneeIds?: number[];
			removeSourceBranch?: boolean;
			squash?: boolean;
		},
	): Promise<IPCResult<GitLabMergeRequest>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST, projectId, options),

	// MR Review operations (AI-powered)
	getGitLabMRReview: (
		projectId: string,
		mrIid: number,
	): Promise<GitLabMRReviewResult | null> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_GET_REVIEW, projectId, mrIid),

	runGitLabMRReview: (projectId: string, mrIid: number): void =>
		sendIpc(IPC_CHANNELS.GITLAB_MR_REVIEW, projectId, mrIid),

	runGitLabMRFollowupReview: (projectId: string, mrIid: number): void =>
		sendIpc(IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW, projectId, mrIid),

	postGitLabMRReview: (
		projectId: string,
		mrIid: number,
		selectedFindingIds?: string[],
	): Promise<boolean> =>
		invokeIpc(
			IPC_CHANNELS.GITLAB_MR_POST_REVIEW,
			projectId,
			mrIid,
			selectedFindingIds,
		),

	postGitLabMRNote: (
		projectId: string,
		mrIid: number,
		body: string,
	): Promise<boolean> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_POST_NOTE, projectId, mrIid, body),

	mergeGitLabMR: (
		projectId: string,
		mrIid: number,
		mergeMethod?: "merge" | "squash" | "rebase",
	): Promise<boolean> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_MERGE, projectId, mrIid, mergeMethod),

	assignGitLabMR: (
		projectId: string,
		mrIid: number,
		userIds: number[],
	): Promise<boolean> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_ASSIGN, projectId, mrIid, userIds),

	approveGitLabMR: (projectId: string, mrIid: number): Promise<boolean> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_APPROVE, projectId, mrIid),

	cancelGitLabMRReview: (projectId: string, mrIid: number): Promise<boolean> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL, projectId, mrIid),

	checkGitLabMRNewCommits: (
		projectId: string,
		mrIid: number,
	): Promise<GitLabNewCommitsCheck> =>
		invokeIpc(IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS, projectId, mrIid),

	// MR Review Event Listeners
	onGitLabMRReviewProgress: (
		callback: (projectId: string, progress: GitLabMRReviewProgress) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS, callback),

	onGitLabMRReviewComplete: (
		callback: (projectId: string, result: GitLabMRReviewResult) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE, callback),

	onGitLabMRReviewError: (
		callback: (
			projectId: string,
			data: { mrIid: number; error: string },
		) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR, callback),

	// OAuth operations (glab CLI)
	checkGitLabCli: (): Promise<
		IPCResult<{ installed: boolean; version?: string }>
	> => invokeIpc(IPC_CHANNELS.GITLAB_CHECK_CLI),

	installGitLabCli: (): Promise<IPCResult<{ command: string }>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_INSTALL_CLI),

	checkGitLabAuth: (
		instanceUrl?: string,
	): Promise<IPCResult<{ authenticated: boolean; username?: string }>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_CHECK_AUTH, instanceUrl),

	startGitLabAuth: (
		instanceUrl?: string,
	): Promise<
		IPCResult<{ deviceCode: string; verificationUrl: string; userCode: string }>
	> => invokeIpc(IPC_CHANNELS.GITLAB_START_AUTH, instanceUrl),

	getGitLabToken: (
		instanceUrl?: string,
	): Promise<IPCResult<{ token: string }>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_GET_TOKEN, instanceUrl),

	getGitLabUser: (
		instanceUrl?: string,
	): Promise<IPCResult<{ username: string; name?: string }>> =>
		invokeIpc(IPC_CHANNELS.GITLAB_GET_USER, instanceUrl),

	listGitLabUserProjects: (
		instanceUrl?: string,
	): Promise<
		IPCResult<{
			projects: Array<{
				pathWithNamespace: string;
				description: string | null;
				visibility: string;
			}>;
		}>
	> => invokeIpc(IPC_CHANNELS.GITLAB_LIST_USER_PROJECTS, instanceUrl),

	// Event Listeners
	onGitLabInvestigationProgress: (
		callback: (projectId: string, status: GitLabInvestigationStatus) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_INVESTIGATION_PROGRESS, callback),

	onGitLabInvestigationComplete: (
		callback: (projectId: string, result: GitLabInvestigationResult) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_INVESTIGATION_COMPLETE, callback),

	onGitLabInvestigationError: (
		callback: (projectId: string, error: string) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR, callback),
});
