/**
 * The Spec Approval handlers of a server card: the renderer names a task of a
 * listed server card or a listed server project, and every other argument is
 * checked again here before the server is asked anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const api = vi.hoisted(() => ({
	getServerCardApproval: vi.fn(),
	setServerCardCriticality: vi.fn(),
	listServerDelegations: vi.fn(),
	createServerDelegation: vi.fn(),
	revokeServerDelegation: vi.fn(),
	listServerDelegates: vi.fn(),
}));
const PROJECT = { id: "p1" };
const CARD = { project: PROJECT, cardId: "001-a" };

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		},
	},
}));
vi.mock("../../server-board-actions", () => ({
	findServerCard: (taskId: unknown) => (taskId === "server:p1:001-a" ? CARD : null),
}));
vi.mock("../../server-projects", () => ({
	getServerProject: (id: unknown) => (id === "p1" ? PROJECT : undefined),
}));
vi.mock("../../server-card-approvals", async (original) => ({
	...(await original<typeof import("../../server-card-approvals")>()),
	...api,
}));

import { delegationInput, registerServerApprovalHandlers } from "../server-approval-handlers";

function call(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args);
}

beforeEach(() => {
	handlers.clear();
	for (const fn of Object.values(api)) {
		fn.mockReset();
		fn.mockResolvedValue({ success: true, data: "ok" });
	}
	registerServerApprovalHandlers();
});

describe("server approval handlers", () => {
	it("asks the server only for a listed server card", async () => {
		expect(await call(IPC_CHANNELS.SPEC_APPROVAL_SERVER_GET, "server:p1:001-a")).toEqual({
			success: true,
			data: "ok",
		});
		expect(api.getServerCardApproval).toHaveBeenCalledWith(CARD);
		expect(await call(IPC_CHANNELS.SPEC_APPROVAL_SERVER_GET, "../../etc")).toEqual({
			success: false,
			error: "Not a card of the server",
		});
		expect(api.getServerCardApproval).toHaveBeenCalledTimes(1);
	});

	it("sets a criticality from the closed list only", async () => {
		await call(IPC_CHANNELS.SPEC_APPROVAL_SERVER_SET_CRITICALITY, "server:p1:001-a", "high");
		expect(api.setServerCardCriticality).toHaveBeenCalledWith(CARD, "high");
		expect(
			await call(IPC_CHANNELS.SPEC_APPROVAL_SERVER_SET_CRITICALITY, "server:p1:001-a", "none"),
		).toEqual({ success: false, error: "Unknown criticality" });
		expect(api.setServerCardCriticality).toHaveBeenCalledTimes(1);
	});

	it("reaches the delegations of a listed server project only", async () => {
		await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATIONS_LIST, "p1");
		await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATES_LIST, "p1");
		expect(api.listServerDelegations).toHaveBeenCalledWith(PROJECT);
		expect(api.listServerDelegates).toHaveBeenCalledWith(PROJECT);
		for (const channel of [
			IPC_CHANNELS.SPEC_APPROVAL_DELEGATIONS_LIST,
			IPC_CHANNELS.SPEC_APPROVAL_DELEGATES_LIST,
			IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE,
			IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE,
		]) {
			expect(await call(channel, "/home/user/project")).toEqual({
				success: false,
				error: "Not a project of the server",
			});
		}
	});

	it("lends only a well-formed delegation", async () => {
		await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE, "p1", {
			toUserId: "u-2",
			endsAt: "2026-12-01T23:59:00+01:00",
			extra: "dropped",
		});
		expect(api.createServerDelegation).toHaveBeenCalledWith(PROJECT, {
			toUserId: "u-2",
			endsAt: "2026-12-01T22:59:00.000Z",
		});
		expect(
			await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE, "p1", { toUserId: "../x" }),
		).toEqual({ success: false, error: "Invalid delegation" });
		expect(api.createServerDelegation).toHaveBeenCalledTimes(1);
	});

	it("ends a delegation named by an id only", async () => {
		await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE, "p1", "d-1");
		expect(api.revokeServerDelegation).toHaveBeenCalledWith(PROJECT, "d-1");
		for (const id of ["d/1", 7, "x".repeat(37)]) {
			expect(await call(IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE, "p1", id)).toEqual({
				success: false,
				error: "Invalid delegation",
			});
		}
		expect(api.revokeServerDelegation).toHaveBeenCalledTimes(1);
	});
});

describe("delegationInput", () => {
	it("keeps the colleague and the period, in UTC", () => {
		expect(
			delegationInput({
				toUserId: "u1",
				endsAt: "2026-12-01T10:00:00Z",
				startsAt: "2026-11-25T08:00+02:00",
			}),
		).toEqual({
			toUserId: "u1",
			endsAt: "2026-12-01T10:00:00.000Z",
			startsAt: "2026-11-25T06:00:00.000Z",
		});
		for (const startsAt of [undefined, null, ""]) {
			expect(delegationInput({ toUserId: "u1", endsAt: "2026-12-01T10:00:00Z", startsAt })).toEqual(
				{ toUserId: "u1", endsAt: "2026-12-01T10:00:00.000Z" },
			);
		}
	});

	it("refuses anything else", () => {
		for (const raw of [
			null,
			[],
			"u1",
			{ toUserId: 5, endsAt: "2026-12-01T10:00:00Z" },
			{ toUserId: "u1", endsAt: "2026-12-01" },
			{ toUserId: "u1", endsAt: "2026-12-01T10:00:00" },
			{ toUserId: "u1", endsAt: 1 },
			{ toUserId: "u1", endsAt: "2026-13-45T99:00:00Z" },
			{ toUserId: "u1", endsAt: "2026-12-01T10:00:00Z", startsAt: "soon" },
		]) {
			expect(delegationInput(raw)).toBeNull();
		}
	});
});
