/** Settings, Approval tiers: the Claude Ship detection, never a failure the page must handle. */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../app-logger", () => ({ appLog: { warn: vi.fn() } }));
vi.mock("../../agent/approvals-env", () => ({
	claudeShipStatus: () => ({ detected: true, accounts: [{ name: "Work", plan: "team" }] }),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { getClaudeShipStatus, registerApprovalsHandlers } from "../approvals-handlers";

describe("approvals handlers", () => {
	it("answers the detection", () => {
		expect(getClaudeShipStatus()).toEqual({
			success: true,
			data: { detected: true, accounts: [{ name: "Work", plan: "team" }] },
		});
	});

	it("answers not detected when the profiles cannot be read", () => {
		const broken = () => {
			throw new Error("no profiles");
		};
		expect(getClaudeShipStatus(broken)).toEqual({
			success: true,
			data: { detected: false, accounts: [] },
		});
	});

	it("registers its one channel", async () => {
		registerApprovalsHandlers();
		const call = vi.mocked(ipcMain.handle).mock.calls[0];
		expect(call[0]).toBe(IPC_CHANNELS.APPROVALS_CLAUDE_SHIP_STATUS);
		expect((call[1] as () => unknown)()).toMatchObject({ success: true });
	});
});
