/**
 * Server mode: a server card's approval and the approvals lent on a server
 * project, for the Spec Approval view (`../server-card-approvals.ts`).
 *
 * The renderer is not trusted: it names a task of a server card the app
 * listed, or a server project by its id, and every other argument is checked
 * again here before anything is asked of the server, which checks them once
 * more. Nothing here takes a path.
 *
 * Channels:
 *   invoke SPEC_APPROVAL_SERVER_GET (taskId)                     → IPCResult<ServerCardApproval>
 *   invoke SPEC_APPROVAL_SERVER_SET_CRITICALITY (taskId, level)  → IPCResult<ServerCardApproval>
 *   invoke SPEC_APPROVAL_DELEGATIONS_LIST (projectId)            → IPCResult<ServerDelegation[]>
 *   invoke SPEC_APPROVAL_DELEGATION_CREATE (projectId, input)    → IPCResult<ServerDelegation>
 *   invoke SPEC_APPROVAL_DELEGATION_REVOKE (projectId, id)       → IPCResult<void>
 *   invoke SPEC_APPROVAL_DELEGATES_LIST (projectId)              → IPCResult<ServerPerson[]>
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult, Project } from "../../shared/types";
import type { ServerDelegationInput } from "../../shared/types/server-approval";
import { findServerCard, type ServerCard } from "../server-board-actions";
import {
	createServerDelegation,
	getServerCardApproval,
	isCriticality,
	listServerDelegates,
	listServerDelegations,
	revokeServerDelegation,
	setServerCardCriticality,
} from "../server-card-approvals";
import { getServerProject } from "../server-projects";

const NOT_A_SERVER_CARD = "Not a card of the server";
const NOT_A_SERVER_PROJECT = "Not a project of the server";
/** The ids the server gives people and delegations (UUIDs). */
const ID = /^[A-Za-z0-9-]{1,36}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function moment(value: unknown): string | null {
	if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The delegation the renderer asks for, reduced to what the server takes. */
export function delegationInput(raw: unknown): ServerDelegationInput | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	const toUserId = typeof input.toUserId === "string" ? input.toUserId : "";
	const endsAt = moment(input.endsAt);
	if (!ID.test(toUserId) || !endsAt) return null;
	if (input.startsAt === undefined || input.startsAt === null || input.startsAt === "") {
		return { toUserId, endsAt };
	}
	const startsAt = moment(input.startsAt);
	return startsAt ? { toUserId, endsAt, startsAt } : null;
}

function onCard<T>(
	act: (card: ServerCard, ...args: unknown[]) => Promise<IPCResult<T>>,
): (_event: unknown, taskId: unknown, ...args: unknown[]) => Promise<IPCResult<T>> {
	return async (_event, taskId, ...args) => {
		const card = findServerCard(taskId);
		if (!card) return { success: false, error: NOT_A_SERVER_CARD };
		return act(card, ...args);
	};
}

function onProject<T>(
	act: (project: Project, ...args: unknown[]) => Promise<IPCResult<T>>,
): (_event: unknown, projectId: unknown, ...args: unknown[]) => Promise<IPCResult<T>> {
	return async (_event, projectId, ...args) => {
		const project = getServerProject(projectId);
		if (!project) return { success: false, error: NOT_A_SERVER_PROJECT };
		return act(project, ...args);
	};
}

export function registerServerApprovalHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_SERVER_GET,
		onCard((card) => getServerCardApproval(card)),
	);
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_SERVER_SET_CRITICALITY,
		onCard(async (card, level) =>
			isCriticality(level)
				? setServerCardCriticality(card, level)
				: { success: false, error: "Unknown criticality" },
		),
	);
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_DELEGATIONS_LIST,
		onProject((project) => listServerDelegations(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE,
		onProject(async (project, raw) => {
			const input = delegationInput(raw);
			return input
				? createServerDelegation(project, input)
				: { success: false, error: "Invalid delegation" };
		}),
	);
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE,
		onProject(async (project, id) =>
			typeof id === "string" && ID.test(id)
				? revokeServerDelegation(project, id)
				: { success: false, error: "Invalid delegation" },
		),
	);
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_DELEGATES_LIST,
		onProject((project) => listServerDelegates(project)),
	);
}
