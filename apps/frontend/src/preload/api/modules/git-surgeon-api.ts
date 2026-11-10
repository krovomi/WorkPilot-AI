/**
 * Git Surgeon API
 *
 * Renderer-side bridge to the git surgeon runner.
 */

import type {
	BranchDeletion,
	BranchListing,
	RewritePlan,
	RewriteResult,
	SurgeonMonth,
	SurgeryPlan,
} from "../../../shared/types/git-surgeon";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface GitSurgeonRunOptions {
	projectPath: string;
	maxCommits?: number;
}

export interface GitSurgeonEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; issues?: number; savingsMb?: number };
}

/** The plan sent back to be replayed on a new branch: steps as the page edited them. */
export interface GitSurgeonApplyInput {
	base: string;
	head: string;
	branch?: string;
	plan: { kind: string; sources: string[]; message: string; paths: string[] }[];
}

export interface GitSurgeonAPI {
	runGitSurgeonScan: (options: GitSurgeonRunOptions) => Promise<SurgeryPlan>;
	planGitRewrite: (options: { projectPath: string; base?: string; ai?: boolean }) => Promise<RewritePlan>;
	applyGitRewrite: (options: { projectPath: string; plan: GitSurgeonApplyInput }) => Promise<RewriteResult>;
	listGitBranches: (options: { projectPath: string }) => Promise<BranchListing>;
	deleteMergedBranches: (options: { projectPath: string; names: string[] }) => Promise<BranchDeletion>;
	gitSurgeonHistory: (options: { projectPath: string }) => Promise<{ months: SurgeonMonth[] }>;
	cancelGitSurgeonScan: () => Promise<boolean>;
	onGitSurgeonEvent: (
		callback: (event: GitSurgeonEvent) => void,
	) => () => void;
	onGitSurgeonResult: (
		callback: (plan: SurgeryPlan) => void,
	) => () => void;
	onGitSurgeonError: (callback: (error: string) => void) => () => void;
}

export const createGitSurgeonAPI = (): GitSurgeonAPI => ({
	runGitSurgeonScan: (options: GitSurgeonRunOptions) =>
		invokeIpc<SurgeryPlan>(IPC_CHANNELS.GIT_SURGEON_RUN, options),

	cancelGitSurgeonScan: () => invokeIpc<boolean>(IPC_CHANNELS.GIT_SURGEON_CANCEL),

	planGitRewrite: (options) => invokeIpc<RewritePlan>(IPC_CHANNELS.GIT_SURGEON_PLAN, options),

	applyGitRewrite: (options) => invokeIpc<RewriteResult>(IPC_CHANNELS.GIT_SURGEON_APPLY, options),

	listGitBranches: (options) => invokeIpc<BranchListing>(IPC_CHANNELS.GIT_SURGEON_BRANCHES, options),

	deleteMergedBranches: (options) => invokeIpc<BranchDeletion>(IPC_CHANNELS.GIT_SURGEON_DELETE_BRANCHES, options),

	gitSurgeonHistory: (options) => invokeIpc<{ months: SurgeonMonth[] }>(IPC_CHANNELS.GIT_SURGEON_HISTORY, options),

	onGitSurgeonEvent: (callback) =>
		createIpcListener<[GitSurgeonEvent]>(IPC_CHANNELS.GIT_SURGEON_EVENT, (payload) =>
			callback(payload),
		),

	onGitSurgeonResult: (callback) =>
		createIpcListener<[SurgeryPlan]>(IPC_CHANNELS.GIT_SURGEON_RESULT, (payload) =>
			callback(payload),
		),

	onGitSurgeonError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.GIT_SURGEON_ERROR, (payload) =>
			callback(payload),
		),
});
