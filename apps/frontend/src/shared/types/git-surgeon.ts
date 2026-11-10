/**
 * Git History Surgeon — Types for history analysis and cleanup.
 */

export type HistoryIssueType =
	| "large_blob"
	| "sensitive_data"
	| "messy_commits"
	| "force_push_risk"
	| "duplicate_commits";

export type SurgeryAction =
	| "squash"
	| "reword"
	| "drop"
	| "bfg_remove"
	| "filter_branch";

export interface HistoryIssue {
	issueType: HistoryIssueType;
	severity: string;
	description: string;
	commitSha: string;
	filePath: string;
	sizeBytes: number;
	suggestedAction: SurgeryAction;
}

export interface SurgeryPlan {
	issues: HistoryIssue[];
	actions: Array<{ action: SurgeryAction; description: string }>;
	estimatedSizeSavingsMb: number;
	requiresForcePush: boolean;
	summary: string;
}

/** How a planned commit is made from the original ones (#360). */
export type RewriteKind = "keep" | "reword" | "squash" | "split";

export interface CommitConvention {
	kind: "conventional" | "gitmoji" | "custom";
	source: string;
	pattern: string;
}

export interface Readability {
	conforming: number;
	total: number;
	percent: number;
}

export interface BranchCommit {
	sha: string;
	subject: string;
	body: string;
	message: string;
	author: string;
	date: string;
	files: string[];
	fileCount: number;
	lines: number;
	signed: boolean;
	merge: boolean;
}

export interface RewriteStep {
	id: string;
	kind: RewriteKind;
	sources: string[];
	message: string;
	reason: string;
	paths: string[];
	author: string;
	/** Whether the backend found the message in the project's convention. */
	conforms?: boolean;
}

export interface RewriteWarning {
	code: "signed" | "pushed" | "merges";
	count: number;
	remotes?: string[];
	after?: string;
}

export interface RewritePlan {
	base: string;
	head: string;
	branch: string;
	convention: CommitConvention;
	before: Readability;
	after: Readability | null;
	commits: BranchCommit[];
	plan: RewriteStep[];
	keptCommits: number;
	warnings: RewriteWarning[];
	blocked: string;
	messagesBy: "rules" | "model";
	modelMessages: number;
}

export interface RewriteResult {
	branch: string;
	head: string;
	base: string;
	source: string;
	commits: number;
	kept: number;
	treeMatches: boolean;
	counts: Record<RewriteKind, number>;
	before: Readability;
	after: Readability;
}

export interface LocalBranch {
	name: string;
	lastCommitAt: string;
	ageDays: number;
	upstream: string;
	gone: boolean;
	merged: boolean;
	stale: boolean;
	current: boolean;
	protected: boolean;
	checkedOut: boolean;
	suggestedName: string;
}

export interface BranchListing {
	defaultBranch: string;
	branches: LocalBranch[];
}

export interface BranchDeletion {
	deleted: string[];
	refused: Record<string, string>;
}

export interface SurgeonMonth {
	month: string;
	runs: number;
	squash: number;
	reword: number;
	split: number;
	readability?: number;
}
