/**
 * The sandbox status a build reports at launch: validated, kept per task and
 * provider, the latest winning.
 */
import { describe, expect, it } from "vitest";
import { parseSandboxStatus, TaskSandboxRegistry } from "../task-sandbox";

const SANDBOX = {
	provider: "openai",
	state: "unavailable",
	backend: "bubblewrap",
	reason: "bubblewrap (bwrap) is not installed",
	network: [],
};

describe("parseSandboxStatus", () => {
	it("reads a well-formed status and attaches the task", () => {
		expect(parseSandboxStatus("t1", { sandbox: SANDBOX }, "p")).toEqual({
			...SANDBOX,
			taskId: "t1",
			projectId: "p",
		});
	});

	it.each([
		["an unknown state", { ...SANDBOX, state: "safe" }],
		["no provider", { ...SANDBOX, provider: "" }],
		["an overlong reason", { ...SANDBOX, reason: "x".repeat(501) }],
		["a network that is not a list", { ...SANDBOX, network: "all" }],
	])("refuses %s", (_label, sandbox) => {
		expect(parseSandboxStatus("t1", { sandbox })).toBeNull();
	});
});

describe("TaskSandboxRegistry", () => {
	it("keeps the latest status per task and provider", () => {
		const registry = new TaskSandboxRegistry();
		const first = parseSandboxStatus("t1", { sandbox: SANDBOX });
		const later = parseSandboxStatus("t1", { sandbox: { ...SANDBOX, state: "isolated", reason: null } });
		const other = parseSandboxStatus("t1", { sandbox: { ...SANDBOX, provider: "claude", state: "delegated" } });
		if (!first || !later || !other) throw new Error("fixture rejected");
		registry.set(first);
		registry.set(other);
		registry.set(later);
		expect(registry.list().map((s) => [s.provider, s.state])).toEqual([
			["openai", "isolated"],
			["claude", "delegated"],
		]);
	});
});
