/** Every agent process gets the agent safety settings, normalized, in one variable. */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SAFETY } from "../../../shared/utils/agent-safety";

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => ({ agentSafety: { sandbox: { mode: "restricted", allowedPaths: ["src"] } } }),
}));

import { AGENT_SAFETY_ENV, agentSafetyEnv } from "../agent-safety-env";

describe("agentSafetyEnv", () => {
	it("reads the settings file by default", () => {
		const sent = JSON.parse(agentSafetyEnv()[AGENT_SAFETY_ENV]);
		expect(sent.sandbox).toMatchObject({ mode: "restricted", allowedPaths: ["src"] });
	});

	it("sends the defaults when nothing is saved", () => {
		expect(JSON.parse(agentSafetyEnv({})[AGENT_SAFETY_ENV])).toEqual(DEFAULT_AGENT_SAFETY);
		expect(JSON.parse(agentSafetyEnv({ agentSafety: "x" })[AGENT_SAFETY_ENV])).toEqual(DEFAULT_AGENT_SAFETY);
	});

	it("never passes an unbounded value on", () => {
		const env = agentSafetyEnv({ agentSafety: { anomaly: { pauseBelow: 500, stopBelow: -3 } } });
		const sent = JSON.parse(env[AGENT_SAFETY_ENV]);
		expect(sent.anomaly).toMatchObject({ pauseBelow: 100, stopBelow: 0 });
	});
});
