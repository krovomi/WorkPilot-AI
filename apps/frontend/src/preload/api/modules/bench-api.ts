/**
 * Repo bench API — finished cards replayed per engine and judged by the
 * tests they landed with (main/ipc-handlers/bench-handlers.ts).
 *
 * The renderer names a project, cards and engines; the main process finds
 * every path itself.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	BenchCandidate,
	BenchEngine,
	BenchStatus,
	IPCResult,
} from "../../../shared/types";
import { createIpcListener, type IpcListenerCleanup, invokeIpc } from "./ipc-utils";

export interface BenchAPI {
	getBenchCandidates: (projectId: string) => Promise<IPCResult<BenchCandidate[]>>;
	getBenchStatus: (projectId: string) => Promise<IPCResult<BenchStatus>>;
	startBench: (
		projectId: string,
		specIds: string[],
		engines: BenchEngine[],
		commits?: Record<string, string>,
	) => Promise<IPCResult<BenchStatus>>;
	discardBench: (projectId: string, runId: string) => Promise<IPCResult<BenchStatus>>;
	onBenchEvent: (
		callback: (projectId: string, status: BenchStatus) => void,
	) => IpcListenerCleanup;
}

export const createBenchAPI = (): BenchAPI => ({
	getBenchCandidates: (projectId) =>
		invokeIpc(IPC_CHANNELS.BENCH_CANDIDATES, projectId),
	getBenchStatus: (projectId) => invokeIpc(IPC_CHANNELS.BENCH_STATUS, projectId),
	startBench: (projectId, specIds, engines, commits) =>
		invokeIpc(IPC_CHANNELS.BENCH_START, projectId, specIds, engines, commits),
	discardBench: (projectId, runId) =>
		invokeIpc(IPC_CHANNELS.BENCH_DISCARD, projectId, runId),
	onBenchEvent: (callback) =>
		createIpcListener<[string, BenchStatus]>(IPC_CHANNELS.BENCH_EVENT, callback),
});
