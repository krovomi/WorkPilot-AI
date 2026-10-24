/**
 * Git Surgeon API
 *
 * Renderer-side bridge to the git surgeon runner.
 */

import type { SurgeryPlan } from "../../../shared/types/git-surgeon";
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

export interface GitSurgeonAPI {
	runGitSurgeonScan: (options: GitSurgeonRunOptions) => Promise<SurgeryPlan>;
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
