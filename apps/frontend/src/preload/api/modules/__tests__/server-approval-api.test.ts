/**
 * The Spec Approval bridge of a server card sends ids, a criticality and a
 * delegation on their own channels; the main checks each of them again.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createServerApprovalAPI } from "../server-approval-api";

describe("createServerApprovalAPI", () => {
	it("names a task, a project or a delegation on its own channel", async () => {
		const api = createServerApprovalAPI();
		const input = { toUserId: "u2", endsAt: "2026-12-01T10:00:00Z" };
		const calls: [Promise<unknown>, unknown[]][] = [
			[api.getServerCardApproval("t1"), [IPC_CHANNELS.SPEC_APPROVAL_SERVER_GET, "t1"]],
			[
				api.setServerCardCriticality("t1", "high"),
				[IPC_CHANNELS.SPEC_APPROVAL_SERVER_SET_CRITICALITY, "t1", "high"],
			],
			[api.listServerDelegations("p1"), [IPC_CHANNELS.SPEC_APPROVAL_DELEGATIONS_LIST, "p1"]],
			[
				api.createServerDelegation("p1", input),
				[IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_CREATE, "p1", input],
			],
			[
				api.revokeServerDelegation("p1", "d1"),
				[IPC_CHANNELS.SPEC_APPROVAL_DELEGATION_REVOKE, "p1", "d1"],
			],
			[api.listServerDelegates("p1"), [IPC_CHANNELS.SPEC_APPROVAL_DELEGATES_LIST, "p1"]],
		];
		for (const [promise, expected] of calls) {
			await promise;
			expect(invoke).toHaveBeenCalledWith(...expected);
		}
	});
});
