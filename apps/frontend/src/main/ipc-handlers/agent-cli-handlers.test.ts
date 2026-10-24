/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platform")>();
	return {
		...actual,
		findExecutable: vi.fn(() => null),
		requiresShell: vi.fn(actual.requiresShell),
	};
});
// Answers at once, so a call the code should not make fails the assertion
// below instead of hanging the test until its timeout.
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFile: vi.fn((...args: unknown[]) => {
		const callback = args.at(-1);
		if (typeof callback === "function") callback(null, "", "");
	}),
}));

import { execFile } from "node:child_process";
import { findExecutable, requiresShell } from "../platform";
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

	it("knows pi by its executable", async () => {
		const result = await checkAgentCli("pi");
		expect(result).toEqual({ tool: "pi", installed: false });
		expect(findExecutable).toHaveBeenLastCalledWith("pi", expect.any(Array));
	});

	it("never runs a .cmd launcher through a shell", async () => {
		vi.mocked(findExecutable).mockReturnValueOnce(
			"C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd",
		);
		// What `requiresShell` answers for a `.cmd` on Windows, on every OS:
		// the refusal under test is the Windows one.
		vi.mocked(requiresShell).mockReturnValueOnce(true);
		const result = await checkAgentCli("opencode");
		expect(result).toEqual({
			tool: "opencode",
			installed: true,
			version: undefined,
		});
		expect(execFile).not.toHaveBeenCalled();
	});
});
