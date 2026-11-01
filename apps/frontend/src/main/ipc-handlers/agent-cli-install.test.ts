import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env-utils", () => ({
	getAugmentedEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
	clearNpmPrefixCache: vi.fn(),
}));
vi.mock("../platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platform")>();
	// installAgentCli is tested as on Linux whatever the CI runner is: the
	// Windows and macOS plans are covered through planAgentCliInstall.
	return {
		...actual,
		findExecutable: vi.fn(() => null),
		getCurrentOS: vi.fn(() => "linux"),
		getPathDelimiter: vi.fn(() => ":"),
		isWindows: vi.fn(() => false),
	};
});
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(),
	execFile: vi.fn((...args: unknown[]) => {
		const callback = args.at(-1);
		if (typeof callback === "function") callback(null, { stdout: "v22.20.0\n", stderr: "" });
	}),
}));

import { spawn } from "node:child_process";
import type { AgentCliStatus, AgentCliTool } from "../../shared/types/agent-cli";
import { findExecutable } from "../platform";
import {
	type InstallHost,
	installAgentCli,
	isForeignWindowsPath,
	isPermissionError,
	planAgentCliInstall,
	userPrefixRetry,
	versionAtLeast,
} from "./agent-cli-install";

const linux: InstallHost = {
	platform: "linux",
	npm: "/usr/bin/npm",
	nodeVersion: "22.20.0",
	homeDir: "/home/me",
};
const windows: InstallHost = {
	platform: "win32",
	npm: "C:\\Program Files\\nodejs\\npm.cmd",
	nodeVersion: "22.20.0",
	homeDir: "C:\\Users\\me",
};

/** A child process that prints `output` and exits with `code`. */
function fakeChild(code: number, output = "") {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: () => void;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	setTimeout(() => {
		if (output) child.stderr.emit("data", Buffer.from(output));
		child.emit("close", code);
	}, 0);
	return child;
}

describe("planAgentCliInstall", () => {
	it("installs npm packages first, then the vendor script", () => {
		const steps = planAgentCliInstall("pi", linux);
		expect(steps.map((s) => s.method)).toEqual(["npm", "script"]);
		expect(steps[0].args).toEqual([
			"install",
			"-g",
			"--ignore-scripts",
			"@earendil-works/pi-coding-agent@latest",
		]);
		expect(steps[1]).toMatchObject({ command: "bash", shell: false });
		expect(steps[1].args[1]).toContain("pipefail");
		expect(steps[1].args[1]).toContain("https://pi.dev/install.sh | sh");
	});

	it("skips npm when Node.js is older than the package needs", () => {
		const steps = planAgentCliInstall("pi", { ...linux, nodeVersion: "20.11.0" });
		expect(steps.map((s) => s.method)).toEqual(["script"]);
	});

	it("installs Antigravity with its script only", () => {
		expect(planAgentCliInstall("antigravity", linux).map((s) => s.method)).toEqual([
			"script",
		]);
		const [win] = planAgentCliInstall("antigravity", windows);
		expect(win.command).toBe("powershell.exe");
		expect(win.args.at(-1)).toBe("irm https://antigravity.google/cli/install.ps1 | iex");
	});

	it("runs npm.cmd through the shell on Windows only", () => {
		expect(planAgentCliInstall("gemini-cli", windows)[0].shell).toBe(true);
		expect(planAgentCliInstall("gemini-cli", linux)[0].shell).toBe(false);
	});

	it("has nothing to offer for Gemini CLI without npm", () => {
		expect(planAgentCliInstall("gemini-cli", { ...linux, npm: null })).toEqual([]);
	});

	it("retries an unwritable npm prefix into ~/.local, never on Windows", () => {
		const [npm] = planAgentCliInstall("opencode", linux);
		expect(userPrefixRetry(npm, linux)?.args).toEqual([
			"install",
			"-g",
			"--prefix",
			"/home/me/.local",
			"opencode-ai@latest",
		]);
		expect(userPrefixRetry(planAgentCliInstall("opencode", windows)[0], windows)).toBeNull();
	});
});

describe("helpers", () => {
	it("compares versions", () => {
		expect(versionAtLeast("22.19.0", "22.19")).toBe(true);
		expect(versionAtLeast("v22.20.1", "22.19")).toBe(true);
		expect(versionAtLeast("22.18.9", "22.19")).toBe(false);
		expect(versionAtLeast("18.0.0", "20.0")).toBe(false);
	});

	it("ignores a Windows npm seen from WSL", () => {
		expect(isForeignWindowsPath("/mnt/c/Program Files/nodejs/npm", "linux")).toBe(true);
		expect(isForeignWindowsPath("/usr/bin/npm", "linux")).toBe(false);
	});

	it("recognises npm permission errors", () => {
		expect(isPermissionError("npm ERR! code EACCES")).toBe(true);
		expect(isPermissionError("npm ERR! 404 Not Found")).toBe(false);
	});
});

describe("installAgentCli", () => {
	const check = vi.fn(
		async (tool: AgentCliTool): Promise<AgentCliStatus> => ({ tool, installed: true, version: "1.0.0" }),
	);

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		check.mockClear();
		vi.mocked(findExecutable).mockImplementation((name: string) =>
			name === "npm" ? "/usr/bin/npm" : name === "node" ? "/usr/bin/node" : null,
		);
	});

	it("refuses a tool outside the closed list without running anything", async () => {
		const result = await installAgentCli("rm -rf /", check);
		expect(result.success).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("installs with npm and reports the fresh check", async () => {
		vi.mocked(spawn).mockImplementation((() => fakeChild(0)) as never);
		const result = await installAgentCli("gemini-cli", check);
		expect(result).toMatchObject({ success: true, method: "npm" });
		expect(result.status?.version).toBe("1.0.0");
		expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
			"install",
			"-g",
			"@google/gemini-cli@latest",
		]);
	});

	it("retries into ~/.local after EACCES", async () => {
		vi.mocked(spawn)
			.mockImplementationOnce((() => fakeChild(243, "npm ERR! code EACCES")) as never)
			.mockImplementationOnce((() => fakeChild(0)) as never);
		const result = await installAgentCli("gemini-cli", check);
		expect(result.success).toBe(true);
		expect(vi.mocked(spawn).mock.calls[1][1]).toContain("--prefix");
	});

	it("falls back to the vendor script when npm fails", async () => {
		vi.mocked(spawn)
			.mockImplementationOnce((() => fakeChild(1, "network error")) as never)
			.mockImplementationOnce((() => fakeChild(0)) as never);
		const result = await installAgentCli("opencode", check);
		expect(result).toMatchObject({ success: true, method: "script" });
	});

	it("says when every method failed, with the output", async () => {
		vi.mocked(spawn).mockImplementation((() => fakeChild(1, "boom")) as never);
		const result = await installAgentCli("gemini-cli", check);
		expect(result).toMatchObject({ success: false, error: "failed", detail: "boom" });
	});

	it("says when the installer ran but the CLI is still not found", async () => {
		vi.mocked(spawn).mockImplementation((() => fakeChild(0)) as never);
		check.mockResolvedValueOnce({ tool: "pi", installed: false });
		const result = await installAgentCli("pi", check);
		expect(result).toMatchObject({ success: false, error: "not_on_path" });
	});

	it("asks for Node.js when nothing can install the CLI", async () => {
		vi.mocked(findExecutable).mockReturnValue(null);
		const result = await installAgentCli("gemini-cli", check);
		expect(result).toEqual({ tool: "gemini-cli", success: false, error: "node_required" });
	});
});
