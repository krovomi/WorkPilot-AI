import { describe, expect, it } from "vitest";
import { DEFAULT_SWARM_SETTINGS } from "../../types/swarm";
import { parseSwarmSettings, swarmEnv } from "../swarm-settings";

const ON = {
	enabled: true,
	maxParallelAgents: 4,
	failFast: false,
	maxRetriesPerSubtask: 2,
};

describe("parseSwarmSettings", () => {
	it("keeps what the panel offers", () => {
		expect(parseSwarmSettings(ON)).toEqual(ON);
		expect(
			parseSwarmSettings({ ...ON, maxParallelAgents: 8, maxRetriesPerSubtask: 0 }),
		).toEqual({ ...ON, maxParallelAgents: 8, maxRetriesPerSubtask: 0 });
	});

	it("fills what is missing with the defaults", () => {
		expect(parseSwarmSettings(undefined)).toEqual(DEFAULT_SWARM_SETTINGS);
		expect(parseSwarmSettings({ enabled: true })).toEqual({
			...DEFAULT_SWARM_SETTINGS,
			enabled: true,
		});
	});

	it.each([
		null,
		"on",
		[ON],
		{ ...ON, enabled: "yes" },
		{ ...ON, failFast: 1 },
		{ ...ON, maxParallelAgents: 1 },
		{ ...ON, maxParallelAgents: 9 },
		{ ...ON, maxParallelAgents: 2.5 },
		{ ...ON, maxParallelAgents: "4" },
		{ ...ON, maxRetriesPerSubtask: -1 },
		{ ...ON, maxRetriesPerSubtask: 6 },
	])("refuses %j", (value) => {
		expect(() => parseSwarmSettings(value)).toThrow("swarm-invalid-settings");
	});
});

describe("swarmEnv", () => {
	it("says how many subtasks run at once, and how often one is retried", () => {
		expect(swarmEnv(ON)).toEqual({
			WORKPILOT_SWARM_MAX_PARALLEL: "4",
			WORKPILOT_SWARM_MAX_RETRIES: "2",
		});
		expect(swarmEnv({ ...ON, failFast: true })).toMatchObject({
			WORKPILOT_SWARM_FAIL_FAST: "1",
		});
	});

	it("says nothing when the swarm is off, absent or unreadable", () => {
		expect(swarmEnv({ ...ON, enabled: false })).toEqual({});
		expect(swarmEnv(undefined)).toEqual({});
		expect(swarmEnv({ ...ON, maxParallelAgents: 40 })).toEqual({});
	});
});
