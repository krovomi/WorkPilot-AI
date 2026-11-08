import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env-utils", () => ({
	getAugmentedEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
	clearNpmPrefixCache: vi.fn(),
}));
vi.mock("../platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platform")>();
	// updateCli is tested as on Linux whatever the CI runner is: the Windows
	// and macOS plans are covered through planCliUpdate.
	return {
		...actual,
		findExecutable: vi.fn(() => null),
		getCurrentOS: vi.fn(() => "linux"),
		getPathDelimiter: vi.fn(() => ":"),
		isWindows: vi.fn(() => false),
		requiresShell: vi.fn(() => false),
		isSecurePath: vi.fn(() => true),
	};
});
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(),
	execFile: vi.fn((...args: unknown[]) => {
		const callback = args.at(-1);
		const file = String(args[0]);
		const stdout = file.endsWith("hermes")
			? "Hermes Agent v0.21.1 (2026.9.24)\nPython: 3.12.3\n"
			: "v22.20.0\n";
		if (typeof callback === "function") callback(null, { stdout, stderr: "" });
	}),
}));

import { spawn } from "node:child_process";
import type { AgentCliStatus, AgentCliTool } from "../../shared/types/agent-cli";
import { findExecutable } from "../platform";
import {
	checkCliUpdate,
	detectInstallOwner,
	isOlder,
	parseHermesVersion,
	planCliUpdate,
	releaseVersionOf,
	type UpdateHost,
	updateCli,
} from "./cli-update";

const linux: UpdateHost = {
	platform: "linux",
	npm: "/usr/bin/npm",
	pnpm: null,
	brew: null,
	nodeVersion: "22.20.0",
	homeDir: "/home/me",
};
const windows: UpdateHost = {
	platform: "win32",
	npm: "C:\\Program Files\\nodejs\\npm.cmd",
	pnpm: null,
	brew: null,
	nodeVersion: "22.20.0",
	homeDir: "C:\\Users\\me",
};
const mac: UpdateHost = { ...linux, platform: "darwin", brew: "/opt/homebrew/bin/brew" };

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

describe("versions", () => {
	it("reads a release tag, never a canary or an old calendar tag", () => {
		expect(releaseVersionOf("v0.23.0")).toBe("0.23.0");
		expect(releaseVersionOf("0.24.1")).toBe("0.24.1");
		expect(() => releaseVersionOf("v0.23.0+canary.20261107")).toThrow(TypeError);
		expect(() => releaseVersionOf("v2026.9.24")).toThrow(TypeError);
		expect(() => releaseVersionOf(undefined)).toThrow(TypeError);
	});

	it("reads hermes's release from its own line, not Python's", () => {
		expect(parseHermesVersion("Hermes Agent v0.21.1 (2026.9.24)\nPython: 3.12.3")).toBe(
			"0.21.1",
		);
		expect(parseHermesVersion("Hermes Agent vgit.af5c201\nPython: 3.12.3")).toBeUndefined();
	});

	it("is outdated only when both versions are known and the first is older", () => {
		expect(isOlder("0.21.1", "0.23.0")).toBe(true);
		expect(isOlder("0.23.0", "0.23.0")).toBe(false);
		expect(isOlder("1.10.0", "1.9.3")).toBe(false);
		expect(isOlder(undefined, "0.23.0")).toBe(false);
		expect(isOlder("0.21.1", undefined)).toBe(false);
	});
});

describe("detectInstallOwner", () => {
	it("finds npm and its prefix from the real path on Unix", () => {
		expect(
			detectInstallOwner(
				"/home/me/.nvm/versions/node/v22/bin/gemini",
				"/home/me/.nvm/versions/node/v22/lib/node_modules/@google/gemini-cli/dist/index.js",
				"linux",
			),
		).toEqual({ kind: "npm", prefix: "/home/me/.nvm/versions/node/v22" });
	});

	it("finds npm on Windows from the launcher's node_modules", () => {
		expect(
			detectInstallOwner(
				"C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd",
				"C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd",
				"win32",
				"C:\\Users\\me\\AppData\\Roaming\\npm",
			),
		).toEqual({ kind: "npm", prefix: "C:\\Users\\me\\AppData\\Roaming\\npm" });
	});

	it("never hands cmd.exe a prefix holding a shell metacharacter", () => {
		expect(
			detectInstallOwner("C:\\a&b\\npm\\pi.cmd", "C:\\a&b\\npm\\pi.cmd", "win32", "C:\\a&b\\npm"),
		).toEqual({ kind: "npm", prefix: undefined });
	});

	it("finds pnpm and Homebrew, else nobody", () => {
		expect(
			detectInstallOwner("/home/me/.local/share/pnpm/pi", "/home/me/.local/share/pnpm/pi", "linux"),
		).toEqual({ kind: "pnpm" });
		expect(
			detectInstallOwner(
				"/opt/homebrew/bin/gemini",
				"/opt/homebrew/Cellar/gemini-cli/0.12.0/bin/gemini",
				"darwin",
			),
		).toEqual({ kind: "brew" });
		expect(
			detectInstallOwner(
				"/home/me/.local/bin/hermes",
				"/home/me/.hermes/hermes-agent/venv/bin/hermes",
				"linux",
			),
		).toEqual({ kind: "other" });
	});
});

describe("planCliUpdate", () => {
	it("updates an npm copy with npm, into its own prefix", () => {
		const steps = planCliUpdate(
			"pi",
			linux,
			{ kind: "npm", prefix: "/home/me/.nvm/versions/node/v22" },
			"/home/me/.nvm/versions/node/v22/bin/pi",
		);
		expect(steps).toEqual([
			{
				method: "npm",
				command: "/usr/bin/npm",
				args: [
					"install",
					"-g",
					"--prefix",
					"/home/me/.nvm/versions/node/v22",
					"--ignore-scripts",
					"@earendil-works/pi-coding-agent@latest",
				],
				shell: false,
			},
		]);
	});

	it("goes through cmd.exe for npm on Windows and quotes a prefix with a space", () => {
		const [step] = planCliUpdate(
			"gemini-cli",
			windows,
			{ kind: "npm", prefix: "C:\\Users\\John Doe\\AppData\\Roaming\\npm" },
			"C:\\Users\\John Doe\\AppData\\Roaming\\npm\\gemini.cmd",
		);
		expect(step.shell).toBe(true);
		expect(step.args).toContain('"C:\\Users\\John Doe\\AppData\\Roaming\\npm"');
	});

	it("uses Homebrew for a Homebrew copy, then the CLI's own updater", () => {
		const steps = planCliUpdate("opencode", mac, { kind: "brew" }, "/opt/homebrew/bin/opencode");
		expect(steps.map((s) => [s.method, s.command, s.args])).toEqual([
			["brew", "/opt/homebrew/bin/brew", ["upgrade", "opencode"]],
			["self", "/opt/homebrew/bin/opencode", ["upgrade"]],
		]);
	});

	it("runs hermes's own updater without waiting on prompts", () => {
		const steps = planCliUpdate(
			"hermes",
			linux,
			{ kind: "other" },
			"/home/me/.local/bin/hermes",
		);
		expect(steps).toEqual([
			{
				method: "self",
				command: "/home/me/.local/bin/hermes",
				args: ["update", "--yes"],
				shell: false,
			},
		]);
	});

	it("reruns the vendor script only for a copy no package manager owns", () => {
		expect(
			planCliUpdate("antigravity", linux, { kind: "other" }, "/home/me/.local/bin/agy").map(
				(s) => s.method,
			),
		).toEqual(["self", "script"]);
		expect(
			planCliUpdate("pi", windows, { kind: "other" }, "C:\\Users\\me\\.pi\\bin\\pi.exe").map(
				(s) => s.method,
			),
		).toEqual(["script"]);
		// An npm copy whose npm is gone gets no script: it would add a second copy.
		expect(
			planCliUpdate("pi", { ...linux, npm: null }, { kind: "npm" }, "/usr/lib/node_modules/x/pi"),
		).toEqual([]);
	});

	it("has nothing to offer for a Gemini CLI no channel owns", () => {
		expect(planCliUpdate("gemini-cli", linux, { kind: "other" }, "/nix/store/x/bin/gemini")).toEqual(
			[],
		);
	});
});

describe("checkCliUpdate and updateCli", () => {
	const check = vi.fn(
		async (tool: AgentCliTool): Promise<AgentCliStatus> => ({
			tool,
			installed: true,
			version: "0.9.0",
		}),
	);
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		check.mockClear();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.mocked(findExecutable).mockImplementation((name: string) =>
			name === "npm"
				? "/usr/bin/npm"
				: name === "node"
					? "/usr/bin/node"
					: name === "hermes"
						? "/home/me/.local/bin/hermes"
						: name === "opencode"
							? "/home/me/.opencode/bin/opencode"
							: null,
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

	it("refuses a tool outside the closed list without running anything", async () => {
		expect(await checkCliUpdate("rm -rf /", check)).toMatchObject({ installed: false });
		expect((await updateCli("rm -rf /", check)).success).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("compares hermes with its latest GitHub release", async () => {
		fetchMock.mockResolvedValue(answer({ tag_name: "v0.23.0" }));
		const status = await checkCliUpdate("hermes", check);
		expect(status).toEqual({
			tool: "hermes",
			installed: true,
			version: "0.21.1",
			latest: "0.23.0",
			isOutdated: true,
		});
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://api.github.com/repos/NousResearch/hermes-agent/releases/latest",
		);
	});

	it("asks no registry for a CLI that is not installed", async () => {
		check.mockResolvedValueOnce({ tool: "pi", installed: false });
		expect(await checkCliUpdate("pi", check)).toEqual({
			tool: "pi",
			installed: false,
			isOutdated: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("updates with the CLI's own updater and reports the fresh check", async () => {
		fetchMock.mockResolvedValue(answer({ version: "1.0.0" }));
		check.mockResolvedValue({ tool: "opencode", installed: true, version: "1.0.0" });
		vi.mocked(spawn).mockImplementation((() => fakeChild(0)) as never);
		const result = await updateCli("opencode", check);
		expect(result).toMatchObject({ success: true, method: "self" });
		expect(vi.mocked(spawn).mock.calls[0].slice(0, 2)).toEqual([
			"/home/me/.opencode/bin/opencode",
			["upgrade"],
		]);
		check.mockReset();
		check.mockImplementation(async (tool) => ({ tool, installed: true, version: "0.9.0" }));
	});

	it("says when the update ran but the CLI is still old", async () => {
		fetchMock.mockResolvedValue(answer({ version: "2.0.0" }));
		vi.mocked(spawn).mockImplementation((() => fakeChild(0, "done")) as never);
		const result = await updateCli("opencode", check);
		expect(result).toMatchObject({ success: false, error: "still_outdated" });
		expect(result.status).toMatchObject({ version: "0.9.0", isOutdated: true });
	});

	it("falls back to the vendor script when the updater fails, then reports every failure", async () => {
		vi.mocked(spawn).mockImplementation((() => fakeChild(1, "boom")) as never);
		const result = await updateCli("opencode", check);
		expect(result).toMatchObject({ success: false, error: "failed", detail: "boom" });
		expect(vi.mocked(spawn).mock.calls.map((call) => call[0])).toEqual([
			"/home/me/.opencode/bin/opencode",
			"bash",
		]);
	});

	it("says when the CLI is not installed", async () => {
		vi.mocked(findExecutable).mockReturnValue(null);
		expect(await updateCli("gemini-cli", check)).toEqual({
			tool: "gemini-cli",
			success: false,
			error: "not_installed",
		});
	});
});
