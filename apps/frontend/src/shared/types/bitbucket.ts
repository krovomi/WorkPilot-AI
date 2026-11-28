/**
 * Bitbucket Cloud as the views see it (main/ipc-handlers/bitbucket/). Every
 * field is built by the main process from Bitbucket's answer; the token never
 * crosses to the renderer.
 */

export interface BitbucketSyncStatus {
	connected: boolean;
	workspace?: string;
	repo?: string;
	fullName?: string;
	description?: string;
	/** Whether the repository has Bitbucket's issue tracker turned on. */
	hasIssues?: boolean;
	webUrl?: string;
	error?: string;
}

export interface BitbucketUser {
	displayName: string;
	nickname?: string;
}

export type BitbucketIssueFilter = "open" | "closed" | "all";

export interface BitbucketIssue {
	id: number;
	title: string;
	content: string;
	/** new, open, resolved, on hold, invalid, duplicate, wontfix, closed. */
	state: string;
	/** bug, enhancement, proposal, task. */
	kind: string;
	priority: string;
	reporter?: BitbucketUser;
	assignee?: BitbucketUser;
	createdOn: string;
	updatedOn: string;
	webUrl: string;
}

/** The issues of a repository, or that its issue tracker is turned off. */
export interface BitbucketIssueList {
	issuesEnabled: boolean;
	issues: BitbucketIssue[];
}

export interface BitbucketComment {
	id: number;
	content: string;
	author?: BitbucketUser;
	createdOn: string;
	/** Inline comment on a pull request: the file and line it is on. */
	path?: string;
	line?: number;
}

export type BitbucketPullRequestState = "OPEN" | "MERGED" | "DECLINED";

export interface BitbucketPullRequest {
	id: number;
	title: string;
	description: string;
	state: string;
	draft: boolean;
	author?: BitbucketUser;
	sourceBranch: string;
	destinationBranch: string;
	commentCount: number;
	createdOn: string;
	updatedOn: string;
	webUrl: string;
}

export interface BitbucketDiffFile {
	path: string;
	oldPath?: string;
	/** added, removed, modified, renamed. */
	status: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface BitbucketPullRequestDiff {
	files: BitbucketDiffFile[];
	/** The unified diff, cut at a bound the view can show. */
	diff: string;
	truncated: boolean;
}

export interface BitbucketPipeline {
	uuid: string;
	buildNumber: number;
	/** PENDING, IN_PROGRESS, SUCCESSFUL, FAILED, STOPPED, ERROR, EXPIRED… */
	state: string;
	branch?: string;
	createdOn: string;
	completedOn?: string;
	durationSeconds?: number;
	webUrl: string;
}

export interface BitbucketPipelineStep {
	uuid: string;
	name: string;
	state: string;
	startedOn?: string;
	completedOn?: string;
	durationSeconds?: number;
}

export interface BitbucketImportResult {
	success: boolean;
	imported: number;
	failed: number;
	errors?: string[];
}
