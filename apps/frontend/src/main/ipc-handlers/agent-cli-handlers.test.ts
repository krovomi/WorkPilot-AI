import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	findExecutable: vi.fn(() => null),
}));

import { checkAgentCli, extractAgentCliVersion } from "./agent-cli-handlers";

describe("agent CLI handlers", () => {
	it("reads the first version-looking token", () => {
		expect(extractAgentCliVersion("opencode 1.4.2\n")).toBe("1.4.2");
		expect(extractAgentCliVersion("agy version 1.3.5-beta.1")).toBe(
			"1.3.5-beta.1",
		);
		expect(extractAgentCliVersion("no version here")).toBeUndefined();
	});

	it("refuses a tool outside the closed list", async () => {
		const result = await checkAgentCli("rm -rf /");
		expect(result.installed).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("reports a CLI that is not on PATH as not installed", async () => {
		const result = await checkAgentCli("antigravity");
		expect(result).toEqual({ tool: "antigravity", installed: false });
	});
});
