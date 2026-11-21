/**
 * The governance bridge sends a project path and, for the export, a format on
 * their own channels; the main revalidates both.
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
});
