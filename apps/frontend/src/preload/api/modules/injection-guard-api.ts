/**
 * Injection Guard API
 *
 * Renderer-side bridge to the injection guard runner which scans persisted
 * prompt payloads for prompt injection attempts.
 */

import type { InjectionScanResult } from "../../../shared/types/injection-guard";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface InjectionGuardRunOptions {
	projectPath: string;
}

export interface InjectionGuardScanResult {
	results: InjectionScanResult[];
}

export interface InjectionGuardEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; results?: number };
}

export interface InjectionGuardAPI {
	runInjectionGuardScan: (
		options: InjectionGuardRunOptions,
	) => Promise<InjectionGuardScanResult>;
	cancelInjectionGuardScan: () => Promise<boolean>;
	onInjectionGuardEvent: (
		callback: (event: InjectionGuardEvent) => void,
	) => () => void;
	onInjectionGuardResult: (
		callback: (result: InjectionGuardScanResult) => void,
	) => () => void;
	onInjectionGuardError: (
		callback: (error: string) => void,
	) => () => void;
}

export const createInjectionGuardAPI = (): InjectionGuardAPI => ({
	runInjectionGuardScan: (options: InjectionGuardRunOptions) =>
		invokeIpc<InjectionGuardScanResult>(IPC_CHANNELS.INJECTION_GUARD_RUN, options),

	cancelInjectionGuardScan: () => invokeIpc<boolean>(IPC_CHANNELS.INJECTION_GUARD_CANCEL),

	onInjectionGuardEvent: (callback) =>
		createIpcListener<[InjectionGuardEvent]>(
			IPC_CHANNELS.INJECTION_GUARD_EVENT,
			(payload) => callback(payload),
		),

	onInjectionGuardResult: (callback) =>
		createIpcListener<[InjectionGuardScanResult]>(
			IPC_CHANNELS.INJECTION_GUARD_RESULT,
			(payload) => callback(payload),
		),

	onInjectionGuardError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.INJECTION_GUARD_ERROR, (payload) =>
			callback(payload),
		),
});
