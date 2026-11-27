/** The PR follow-through gets the approval switches, normalized: WORKPILOT_APPROVALS and WORKPILOT_CLAUDE_SHIP. */
import { describe, expect, it, vi } from "vitest";

const accounts = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => ({ approvalTiers: "enforce" }),
}));
vi.mock("../../ai-accounts/account-plans", () => ({
	accountsWithPlan: () => accounts.list,
}));

import { APPROVALS_ENV, CLAUDE_SHIP_ENV, approvalsEnv, claudeShipStatus } from "../approvals-env";

const account = (name: string, plan: string, signedIn = true) => ({
	id: name,
	provider: "anthropic",
	name,
	plan,
	isDefault: false,
	signedIn,
});

describe("approvalsEnv", () => {
	it("reads the settings file and the Claude accounts by default", () => {
		accounts.list = [account("Work", "team")];
		expect(approvalsEnv()).toEqual({ [APPROVALS_ENV]: "enforce", [CLAUDE_SHIP_ENV]: "1" });
		accounts.list = [];
		expect(approvalsEnv()[CLAUDE_SHIP_ENV]).toBe("0");
	});

	it("is observe when nothing or anything unknown is saved, never enforce", () => {
		const none = () => false;
		expect(approvalsEnv({}, none)[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv({ approvalTiers: "ENFORCE" }, none)[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv({ approvalTiers: 2 }, none)[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv({ approvalTiers: "off" }, none)[APPROVALS_ENV]).toBe("off");
	});

	it("turns Claude Ship on by detection in auto, and forced otherwise", () => {
		const yes = vi.fn(() => true);
		expect(approvalsEnv({}, yes)[CLAUDE_SHIP_ENV]).toBe("1");
		expect(approvalsEnv({ claudeShip: "weird" }, () => false)[CLAUDE_SHIP_ENV]).toBe("0");
		const untouched = vi.fn(() => true);
		expect(approvalsEnv({ claudeShip: "off" }, untouched)[CLAUDE_SHIP_ENV]).toBe("0");
		expect(approvalsEnv({ claudeShip: "on" }, untouched)[CLAUDE_SHIP_ENV]).toBe("1");
		expect(untouched).not.toHaveBeenCalled();
	});
});

describe("claudeShipStatus", () => {
	it("names the signed-in Team and Enterprise accounts only", () => {
		const status = claudeShipStatus([
			account("Work", "team"),
			account("Corp", "enterprise"),
			account("Home", "max"),
			account("Old", "team", false),
		] as never);
		expect(status).toEqual({
			detected: true,
			accounts: [
				{ name: "Work", plan: "team" },
				{ name: "Corp", plan: "enterprise" },
			],
		});
		expect(claudeShipStatus([account("Home", "pro")] as never).detected).toBe(false);
	});
});
