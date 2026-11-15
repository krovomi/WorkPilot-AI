/**
 * Logins the app checks through a command-line tool: the Codex CLI for
 * OpenAI and the GitHub CLI for Copilot. The tools themselves are stood in
 * for at the child_process boundary: each test says what the command
 * printed or how it exited, and checks what the app concluded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
	windows: false,
	mac: false,
	codexPath: null as string | null,
	execFile: vi.fn(),
	exec: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: cli.execFile,
	exec: cli.exec,
}));
vi.mock("../../env-utils", () => ({ findExecutable: () => cli.codexPath }));
vi.mock("../../platform", () => ({
	isWindows: () => cli.windows,
	isMacOS: () => cli.mac,
}));
vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => undefined,
	writeSettingsFile: vi.fn(),
}));
vi.mock("../../utils/profile-manager", () => ({
	loadProfilesFile: async () => ({ profiles: [], activeProfileId: null }),
	saveProfilesFile: vi.fn(),
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CredentialManager,
	checkCodexCliLoginStatus,
	detectWindsurfLocalToken,
	readWindsurfCachedPlanInfo,
} from "../credential-manager";

type Outcome = { stdout?: string; stderr?: string; error?: Error };
/** Answer a callback-style child_process call the way Node does. */
function answers(outcomes: Record<string, Outcome>) {
	return (...args: unknown[]) => {
		const callback = args[args.length - 1] as (
			err: Error | null,
			out: { stdout: string; stderr: string },
		) => void;
		const key = Object.keys(outcomes).find((k) =>
			JSON.stringify(args.slice(0, -1)).includes(k),
		);
		const outcome = key ? outcomes[key] : { error: new Error("ENOENT") };
		const result = { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
		if (outcome.error) {
			callback(Object.assign(outcome.error, result), result);
		} else {
			callback(null, result);
		}
	};
}

beforeEach(() => {
	cli.windows = false;
	cli.mac = false;
	cli.codexPath = null;
	cli.execFile.mockReset();
	cli.exec.mockReset();
	process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkCodexCliLoginStatus", () => {
	it("is false when codex is not installed", async () => {
		await expect(checkCodexCliLoginStatus()).resolves.toBe(false);
		expect(cli.execFile).not.toHaveBeenCalled();
	});

	it("asks codex for its login status, without a shell", async () => {
		cli.codexPath = "/usr/local/bin/codex";
		cli.execFile.mockImplementation(answers({ codex: { stdout: "Logged in" } }));
		await expect(checkCodexCliLoginStatus()).resolves.toBe(true);
		expect(cli.execFile).toHaveBeenCalledWith(
			"/usr/local/bin/codex",
			["login", "status"],
			{ encoding: "utf-8", timeout: 5000, windowsHide: true },
			expect.any(Function),
		);
	});

	it("is false when codex says the user is logged out", async () => {
		cli.codexPath = "/usr/local/bin/codex";
		cli.execFile.mockImplementation(
			answers({ codex: { error: new Error("exit 1"), stderr: "Not logged in" } }),
		);
		await expect(checkCodexCliLoginStatus()).resolves.toBe(false);
	});

	it("runs a Windows .cmd launcher through cmd.exe, quoted", async () => {
		cli.windows = true;
		cli.codexPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
		cli.execFile.mockImplementation(answers({ "cmd.exe": { stdout: "ok" } }));
		await expect(checkCodexCliLoginStatus()).resolves.toBe(true);
		expect(cli.execFile).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\cmd.exe",
			[
				"/d",
				"/s",
				"/c",
				'""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" login status"',
			],
			expect.objectContaining({ windowsHide: true }),
			expect.any(Function),
		);
	});

	it("falls back to the system cmd.exe when ComSpec is unset", async () => {
		delete process.env.ComSpec;
		cli.windows = true;
		cli.codexPath = "C:\\npm\\codex.bat";
		cli.execFile.mockImplementation(answers({ "cmd.exe": {} }));
		await checkCodexCliLoginStatus();
		expect(cli.execFile.mock.calls[0][0]).toBe("C:\\Windows\\System32\\cmd.exe");
	});

	it("refuses a launcher path that would break out of cmd.exe's quotes", async () => {
		cli.windows = true;
		cli.codexPath = 'C:\\evil" & calc & ".cmd';
		await expect(checkCodexCliLoginStatus()).resolves.toBe(false);
		expect(cli.execFile).not.toHaveBeenCalled();
	});

	it("runs a Windows .exe directly", async () => {
		cli.windows = true;
		cli.codexPath = "C:\\tools\\codex.exe";
		cli.execFile.mockImplementation(answers({ "codex.exe": {} }));
		await expect(checkCodexCliLoginStatus()).resolves.toBe(true);
		expect(cli.execFile.mock.calls[0][0]).toBe("C:\\tools\\codex.exe");
	});

	it("is what an OpenAI connection test asks by default", async () => {
		cli.codexPath = "/usr/local/bin/codex";
		cli.execFile.mockImplementation(answers({ codex: {} }));
		const result = await new CredentialManager().testProvider("openai");
		expect(result).toMatchObject({
			success: true,
			message: "OpenAI Codex CLI authentication active",
		});
	});
});

describe("Copilot connection test", () => {
	const version = { stdout: "gh version 2.80.0 (2026-10-01)\n" };

	it("is authenticated when gh says it is logged in", async () => {
		cli.exec.mockImplementation(
			answers({
				"gh --version": version,
				"gh auth status": { stdout: "✓ Logged in to github.com account me" },
			}),
		);
		await expect(new CredentialManager().testProvider("copilot")).resolves.toEqual({
			success: true,
			message: "GitHub Copilot authentication (CLI-based)",
			details: {
				method: "GitHub CLI",
				version: "gh version 2.80.0 (2026-10-01)",
				status: "Authenticated",
			},
		});
	});

	it("reads the status from stderr too (gh on Windows)", async () => {
		cli.exec.mockImplementation(
			answers({
				"gh --version": version,
				"gh auth status": { stderr: "  - Token: gho_****" },
			}),
		);
		expect((await new CredentialManager().testProvider("copilot")).success).toBe(
			true,
		);
	});

	it("is authenticated when gh exits non-zero but still prints a login", async () => {
		cli.exec.mockImplementation(
			answers({
				"gh --version": version,
				"gh auth status": {
					error: new Error("exit 1"),
					stderr: "Logged in to github.com\nX Failed to log in to ghe.example",
				},
			}),
		);
		const result = await new CredentialManager().testProvider("copilot");
		expect(result).toMatchObject({ success: true, details: { status: "Authenticated" } });
	});

	it.each([
		["prints no login", { stdout: "You are not logged into any GitHub hosts." }],
		["exits non-zero", { error: new Error("exit 1"), stdout: "not logged in" }],
	])("says to run gh auth login when gh %s", async (_label, status) => {
		cli.exec.mockImplementation(
			answers({ "gh --version": version, "gh auth status": status }),
		);
		await expect(new CredentialManager().testProvider("copilot")).resolves.toEqual({
			success: false,
			message: "GitHub CLI not authenticated. Run: gh auth login",
		});
	});

	it("reads a failure that carries no output", async () => {
		cli.exec.mockImplementation((command: string, _opts: unknown, cb: Function) => {
			if (command === "gh --version") cb(null, version);
			else cb(new Error("killed"));
		});
		expect((await new CredentialManager().testProvider("copilot")).success).toBe(
			false,
		);
	});

	it("says to install gh when it is missing", async () => {
		cli.exec.mockImplementation(answers({}));
		await expect(new CredentialManager().testProvider("copilot")).resolves.toEqual({
			success: false,
			message:
				"GitHub CLI not available. Install GitHub CLI and run: gh auth login",
		});
		cli.exec.mockImplementation((_c: string, _o: unknown, cb: Function) => cb("gone"));
		expect((await new CredentialManager().testProvider("copilot")).success).toBe(
			false,
		);
		expect(console.warn).toHaveBeenCalledWith("GitHub CLI check failed:", "gone");
	});
});

describe("where the Windsurf IDE keeps its database, per OS", () => {
	const tail = ["Windsurf", "User", "globalStorage", "state.vscdb"];
	const saved = { HOME: process.env.HOME, APPDATA: process.env.APPDATA };
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "windsurf-os-"));
		process.env.HOME = home;
		process.env.APPDATA = join(home, "Roaming");
	});

	afterEach(() => {
		process.env.HOME = saved.HOME;
		if (saved.APPDATA === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = saved.APPDATA;
		rmSync(home, { recursive: true, force: true });
	});

	function place(...dirs: string[]): void {
		const file = join(home, ...dirs, ...tail);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "");
	}
	const NOT_FOUND = "Windsurf IDE not found. Install Windsurf and sign in first.";

	it.each([
		["Windows", { windows: true, mac: false }, ["Roaming"]],
		["macOS", { windows: false, mac: true }, ["Library", "Application Support"]],
		["Linux", { windows: false, mac: false }, [".config"]],
	])("looks in the %s folder and nowhere else", async (_os, flags, dirs) => {
		Object.assign(cli, flags);
		const elsewhere = ["Roaming", ".config"].includes(dirs[0])
			? ["Library", "Application Support"]
			: [".config"];
		place(...elsewhere);
		expect((await detectWindsurfLocalToken()).error).toBe(NOT_FOUND);

		place(...dirs);
		expect((await detectWindsurfLocalToken()).error).not.toBe(NOT_FOUND);
		expect((await readWindsurfCachedPlanInfo()).error).not.toBe(
			"Windsurf IDE not installed",
		);
	});

	it("finds nothing when the home or APPDATA variable is unset", async () => {
		delete process.env.APPDATA;
		cli.windows = true;
		expect((await detectWindsurfLocalToken()).error).toBe(NOT_FOUND);
		cli.windows = false;
		delete process.env.HOME;
		expect((await detectWindsurfLocalToken()).error).toBe(NOT_FOUND);
		cli.mac = true;
		expect((await detectWindsurfLocalToken()).error).toBe(NOT_FOUND);
	});
});
