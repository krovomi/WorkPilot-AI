/** The PR follow-through gets the approval tier switch, normalized, as WORKPILOT_APPROVALS. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => ({ approvalTiers: "enforce" }),
}));

import { APPROVALS_ENV, approvalsEnv } from "../approvals-env";

describe("approvalsEnv", () => {
	it("reads the settings file by default", () => {
		expect(approvalsEnv()).toEqual({ [APPROVALS_ENV]: "enforce" });
	});

	it("is observe when nothing or anything unknown is saved, never enforce", () => {
		expect(approvalsEnv({})[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv(undefined as unknown as Record<string, unknown>)[APPROVALS_ENV]).toBe(
			"enforce",
		);
		expect(approvalsEnv({ approvalTiers: "ENFORCE" })[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv({ approvalTiers: 2 })[APPROVALS_ENV]).toBe("observe");
		expect(approvalsEnv({ approvalTiers: "off" })[APPROVALS_ENV]).toBe("off");
	});
});
