/**
 * Consensus Arbiter API
 *
 * Renderer-side bridge to the consensus arbiter runner which detects and
 * resolves inter-agent conflicts from persisted opinion payloads.
 */

import type { ConsensusResult } from "../../../shared/types/consensus-arbiter";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface ConsensusArbiterRunOptions {
	projectPath: string;
}

export interface ConsensusArbiterScanResult {
	result: ConsensusResult;
}

export interface ConsensusArbiterEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; results?: number };
}

export interface ConsensusArbiterAPI {
	runConsensusArbiterScan: (
		options: ConsensusArbiterRunOptions,
	) => Promise<ConsensusArbiterScanResult>;
	cancelConsensusArbiterScan: () => Promise<boolean>;
	onConsensusArbiterEvent: (
		callback: (event: ConsensusArbiterEvent) => void,
	) => () => void;
	onConsensusArbiterResult: (
		callback: (result: ConsensusArbiterScanResult) => void,
	) => () => void;
	onConsensusArbiterError: (
		callback: (error: string) => void,
	) => () => void;
}

export const createConsensusArbiterAPI = (): ConsensusArbiterAPI => ({
	runConsensusArbiterScan: (options: ConsensusArbiterRunOptions) =>
		invokeIpc<ConsensusArbiterScanResult>(IPC_CHANNELS.CONSENSUS_ARBITER_RUN, options),

	cancelConsensusArbiterScan: () =>
		invokeIpc<boolean>(IPC_CHANNELS.CONSENSUS_ARBITER_CANCEL),

	onConsensusArbiterEvent: (callback) =>
		createIpcListener<[ConsensusArbiterEvent]>(
			IPC_CHANNELS.CONSENSUS_ARBITER_EVENT,
			(payload) => callback(payload),
		),

	onConsensusArbiterResult: (callback) =>
		createIpcListener<[ConsensusArbiterScanResult]>(
			IPC_CHANNELS.CONSENSUS_ARBITER_RESULT,
			(payload) => callback(payload),
		),

	onConsensusArbiterError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.CONSENSUS_ARBITER_ERROR, (payload) =>
			callback(payload),
		),
});
