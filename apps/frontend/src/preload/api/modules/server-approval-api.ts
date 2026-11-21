/**
 * Spec Approval of a server card (server mode): its criticality and
 * approvals, and the approvals lent on a server project
 * (main/ipc-handlers/server-approval-handlers.ts).
 *
 * The renderer names a task, a server project or a delegation by its id; the
 * main process checks every argument again and asks the server.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type {
	ServerCardApproval,
	ServerCriticality,
	ServerDelegation,
	ServerDelegationInput,
	ServerPerson,
} from "../../../shared/types/server-approval";
import { invokeIpc } from "./ipc-utils";

export interface ServerApprovalAPI {
	getServerCardApproval: (taskId: string) => Promise<IPCResult<ServerCardApproval>>;
	setServerCardCriticality: (
		taskId: string,
		criticality: ServerCriticality,
	) => Promise<IPCResult<ServerCardApproval>>;
	listServerDelegations: (projectId: string) => Promise<IPCResult<ServerDelegation[]>>;
	createServerDelegation: (
		projectId: string,
		input: ServerDelegationInput,
	) => Promise<IPCResult<ServerDelegation>>;
	revokeServerDelegation: (projectId: string, delegationId: string) => Promise<IPCResult<void>>;
	listServerDelegates: (projectId: string) => Promise<IPCResult<ServerPerson[]>>;
}

export const createServerApprovalAPI = (): ServerApprovalAPI => ({
	getServerCardApproval: (taskId) => invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_SERVER_GET, taskId),
	setServerCardCriticality: (taskId, criticality) =>
		invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_SERVER_SET_CRITICALITY, taskId, criticality),
	listServerDelegations: (projectId) =>
		invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_DELEGATIONS_LIST, projectId),
	createServerDelegation: (projectId, input) =>
		invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE, projectId, input),
	revokeServerDelegation: (projectId, delegationId) =>
		invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE, projectId, delegationId),
	listServerDelegates: (projectId) =>
		invokeIpc(IPC_CHANNELS.SPEC_APPROVAL_DELEGATES_LIST, projectId),
});
