/**
 * The governance bridge sends a project path (or, for a server project, its
 * id) and the other arguments on their own channels; the main revalidates them.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createGovernanceAPI } from "../governance-api";

describe("createGovernanceAPI", () => {
	it("asks for the report of one project", async () => {
		await createGovernanceAPI().getGovernanceReport("/p");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_REPORT, { projectPath: "/p" });
	});

	it("asks for an export in one format", async () => {
		await createGovernanceAPI().exportPolicyAudit("/p", "csv");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT, { projectPath: "/p", format: "csv" });
	});

	it("sends a server project's id, never a path, on the server channels", async () => {
		const api = createGovernanceAPI();
		await api.getServerGovernance("p-1");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_SERVER_REPORT, { projectId: "p-1" });
		await api.exportServerPolicyAudit("p-1", "json");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_SERVER_EXPORT, { projectId: "p-1", format: "json" });
		await api.answerServerGovernanceRequest("p-1", "0123456789ab", false);
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_SERVER_ANSWER, {
			projectId: "p-1",
			requestId: "0123456789ab",
			approved: false,
		});
		await api.stopServerProjectAgents("p-1", "mine");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.GOVERNANCE_SERVER_STOP, { projectId: "p-1", scope: "mine" });
	});
});
