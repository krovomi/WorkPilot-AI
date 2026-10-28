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
import {
	checkAgentCli,
	extractAgentCliVersion,
	probeAcpAgent,
	readAcpDeclaration,
} from "./agent-cli-handlers";

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

/** Gemini CLI 0.65's `initialize` answer, as captured (tests/fixtures/acp). */
const GEMINI_INITIALIZE = {
	protocolVersion: 1,
	authMethods: [
		{ id: "oauth-personal", name: "Log in with Google" },
		{ id: "gemini-api-key", name: "Use Gemini API key" },
	],
	agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.65.0" },
	agentCapabilities: {
		loadSession: true,
		promptCapabilities: { image: true, audio: true, embeddedContext: true },
		mcpCapabilities: { http: true, sse: true },
	},
};

describe("ACP declaration", () => {
	it("reads what the agent declares", () => {
		expect(readAcpDeclaration("gemini-cli", GEMINI_INITIALIZE)).toEqual({
			tool: "gemini-cli",
			declared: {
				name: "Gemini CLI",
				version: "0.65.0",
				protocolVersion: 1,
				loadSession: true,
				images: true,
				audio: true,
				embeddedContext: true,
				mcpHttp: true,
				mcpSse: true,
				authMethods: ["oauth-personal", "gemini-api-key"],
			},
		});
	});

	it("counts only a literal true as declared", () => {
		const declared = readAcpDeclaration("gemini-cli", {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: "true",
				promptCapabilities: { image: 1 },
				mcpCapabilities: { http: null },
			},
		}).declared;
		expect(declared).toMatchObject({
			loadSession: false,
			images: false,
			audio: false,
			embeddedContext: false,
			mcpHttp: false,
			mcpSse: false,
			authMethods: [],
		});
	});

	it("refuses an answer that is not ACP version 1", () => {
		expect(readAcpDeclaration("gemini-cli", { protocolVersion: 2 })).toEqual({
			tool: "gemini-cli",
			error: "not_acp",
		});
		expect(readAcpDeclaration("gemini-cli", "ok")).toEqual({
			tool: "gemini-cli",
			error: "not_acp",
		});
	});

	it("probes only an ACP tool of the closed list", async () => {
		expect((await probeAcpAgent("opencode")).error).toBe("failed");
		expect((await probeAcpAgent("gemini --yolo")).error).toBe("failed");
	});

	it("says when the agent is not installed", async () => {
		vi.mocked(findExecutable).mockReturnValueOnce(null);
		expect(await probeAcpAgent("gemini-cli")).toEqual({
			tool: "gemini-cli",
			error: "not_installed",
		});
	});

	it("never starts a .cmd launcher", async () => {
		vi.mocked(findExecutable).mockReturnValueOnce(
			"C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd",
		);
		vi.mocked(requiresShell).mockReturnValueOnce(true);
		expect(await probeAcpAgent("gemini-cli")).toEqual({
			tool: "gemini-cli",
			error: "shell_launcher",
		});
	});
});
