/**
 * Spec Refinement API
 *
 * Renderer-side bridge to the spec refinement runner which discovers
 * persisted refinement histories in the selected project.
 */

import type { RefinementHistory } from "../../../shared/types/spec-refinement";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface SpecRefinementRunOptions {
	projectPath: string;
}

export interface SpecRefinementResult {
	histories: RefinementHistory[];
}

export interface SpecRefinementEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; histories?: number };
}

export interface SpecRefinementAPI {
	runSpecRefinementScan: (
		options: SpecRefinementRunOptions,
	) => Promise<SpecRefinementResult>;
	cancelSpecRefinementScan: () => Promise<boolean>;
	onSpecRefinementEvent: (
		callback: (event: SpecRefinementEvent) => void,
	) => () => void;
	onSpecRefinementResult: (
		callback: (result: SpecRefinementResult) => void,
	) => () => void;
	onSpecRefinementError: (callback: (error: string) => void) => () => void;
}

export const createSpecRefinementAPI = (): SpecRefinementAPI => ({
	runSpecRefinementScan: (options: SpecRefinementRunOptions) =>
		invokeIpc<SpecRefinementResult>(IPC_CHANNELS.SPEC_REFINEMENT_RUN, options),

	cancelSpecRefinementScan: () => invokeIpc<boolean>(IPC_CHANNELS.SPEC_REFINEMENT_CANCEL),

	onSpecRefinementEvent: (callback) =>
		createIpcListener<[SpecRefinementEvent]>(IPC_CHANNELS.SPEC_REFINEMENT_EVENT, (payload) =>
			callback(payload),
		),

	onSpecRefinementResult: (callback) =>
		createIpcListener<[SpecRefinementResult]>(IPC_CHANNELS.SPEC_REFINEMENT_RESULT, (payload) =>
			callback(payload),
		),

	onSpecRefinementError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.SPEC_REFINEMENT_ERROR, (payload) =>
			callback(payload),
		),
});
