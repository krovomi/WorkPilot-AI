/**
 * How the CLI tool manager finds each tool, on a described machine.
 *
 * The machine is data: the files that exist, what each command line prints
 * (or how it fails), what is on PATH, what `where` answers on Windows, and the
 * OS. The manager runs for real on it. Every detection goes through both the
 * sync API (getToolInfo) and the async one (getToolPathAsync), which must
 * agree: the two are written separately.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const machine = vi.hoisted(() => {
	type Answer = { out: string | Buffer } | { fail: unknown };
	type Entry = { name: string; dir: boolean };
	const m = {
		home: "/home/u",
		windows: false,
		mac: false,
		packaged: false,
		files: new Set<string>(),
		dirs: new Map<string, Entry[] | { fail: unknown }>(),
		onPath: new Map<string, string>(),
		where: new Map<string, string>(),
		winPaths: new Map<"git" | "glab", string[]>(),
		answers: new Map<string, Answer>(),
		runs: [] as string[],
		exists(p: string): boolean {
			return m.files.has(p) || m.dirs.has(p);
		},
		entries(p: string) {
			const listed = m.dirs.get(p);
			if (!listed) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
			if ("fail" in listed) throw listed.fail;
			return listed.map((e) => ({ name: e.name, isDirectory: () => e.dir }));
		},
		run(cmd: string, args: readonly string[] = []): string | Buffer {
			const line = [cmd, ...args].join(" ");
			m.runs.push(line);
			const answer = m.answers.get(line);
			if (!answer) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
			if ("fail" in answer) throw answer.fail;
			return answer.out;
		},
	};
	return m;
});

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return machine.packaged;
		},
	},
}));

vi.mock("node:os", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:os")>();
	const homedir = () => machine.home;
	return { ...real, homedir, default: { ...real, homedir } };
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const existsSync = (p: unknown) => machine.exists(String(p));
	const readdirSync = (p: unknown) => machine.entries(String(p));
	const promises = {
		...real.promises,
		access: async (p: unknown) => {
			if (!machine.exists(String(p))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		readdir: async (p: unknown) => machine.entries(String(p)),
	};
	const mod = { ...real, existsSync, readdirSync, promises };
	return { ...mod, default: mod };
});

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	const execFileSync = (cmd: string, args?: readonly string[]) => machine.run(cmd, args);
	// promisify(execFile) resolves { stdout, stderr } through this symbol, as Node's own does.
	const execFile = Object.assign(() => {
		throw new Error("execFile is only used promisified");
	}, {
		[Symbol.for("nodejs.util.promisify.custom")]: async (cmd: string, args?: readonly string[]) => ({
			stdout: machine.run(cmd, args),
			stderr: "",
		}),
	});
	const mod = { ...real, execFileSync, execFile };
	return { ...mod, default: mod };
});

vi.mock("../env-utils", () => ({
	existsAsync: async (p: string) => machine.exists(p),
	findExecutable: (name: string) => machine.onPath.get(name) ?? null,
	findExecutableAsync: async (name: string) => machine.onPath.get(name) ?? null,
	getAugmentedEnv: () => ({}),
	getAugmentedEnvAsync: async () => ({}),
	shouldUseShell: (cmd: string) => machine.windows && /\.(cmd|bat)"?$/i.test(cmd.trim()),
}));

vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	isWindows: () => machine.windows,
	isMacOS: () => machine.mac,
}));

vi.mock("../utils/windows-paths", async (importOriginal) => {
	const real = await importOriginal<typeof import("../utils/windows-paths")>();
	const listFor = (paths: unknown) =>
		machine.winPaths.get(paths === real.WINDOWS_GIT_PATHS ? "git" : "glab") ?? [];
	return {
		...real,
		findWindowsExecutableViaWhere: (name: string) => machine.where.get(name) ?? null,
		findWindowsExecutableViaWhereAsync: async (name: string) => machine.where.get(name) ?? null,
		getWindowsExecutablePaths: listFor,
		getWindowsExecutablePathsAsync: async (paths: unknown) => listFor(paths),
	};
});

import {
	type CLITool,
	clearToolCache,
	configureTools,
	configureToolsFromSettings,
	getClaudeCliPathForSdk,
	getClaudeCliPathForSdkAsync,
	getToolInfo,
	getToolPath,
	getToolPathAsync,
	isPathFromWrongPlatform,
	preWarmToolCache,
	sortNvmVersionDirs,
	updateToolConfig,
} from "../cli-tool-manager";
import { findHomebrewPython } from "../utils/homebrew-python";

const answer = (line: string, out: string | Buffer) => machine.answers.set(line, { out });
const fail = (line: string, error: unknown = new Error("exit 1")) =>
	machine.answers.set(line, { fail: error });
const file = (p: string) => {
	machine.files.add(p);
	return p;
};
/** A tool on PATH that answers --version. */
const onPath = (name: string, at: string, version: string) => {
	machine.onPath.set(name, at);
	answer(`${at} --version`, version);
};

const warnings: string[] = [];
const warned = (text: string) => warnings.some((line) => line.includes(text));

const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Detect `tool` through the sync and the async API, which must agree. */
async function detect(tool: CLITool) {
	clearToolCache();
	const info = getToolInfo(tool);
	clearToolCache();
	const asyncPath = await getToolPathAsync(tool);
	expect(asyncPath).toBe(info.found ? info.path : tool);
	clearToolCache();
	return info;
}

beforeEach(() => {
	machine.windows = false;
	machine.mac = false;
	machine.packaged = false;
	machine.files.clear();
	machine.dirs.clear();
	machine.onPath.clear();
	machine.where.clear();
	machine.winPaths.clear();
	machine.answers.clear();
	machine.runs.length = 0;
	configureTools({});
	clearToolCache();
	warnings.length = 0;
	vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
		warnings.push(String(line));
	});
});

afterEach(() => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	savedEnv.clear();
	vi.restoreAllMocks();
});

describe("Python", () => {
	it("uses the configured interpreter when it is recent enough", async () => {
		configureTools({ pythonPath: "/custom/python" });
		answer("/custom/python --version", "Python 3.13.1\n");
		onPath("python3", "/usr/bin/python3", "Python 3.12.3");

		expect(await detect("python")).toEqual({
			found: true,
			path: "/custom/python",
			version: "3.13.1",
			source: "user-config",
			message: "Using user-configured Python: /custom/python",
		});
	});

	it("ignores a Windows path in the settings of a Mac or Linux machine", async () => {
		configureTools({ pythonPath: "C:\\Python312\\python.exe" });
		onPath("python3", "/usr/bin/python3", "Python 3.12.3");

		const info = await detect("python");
		expect(info).toMatchObject({ path: "/usr/bin/python3", source: "system-path" });
		expect(warned("different platform")).toBe(true);
		expect(machine.runs).not.toContain("C:\\Python312\\python.exe --version");
	});

	it.each([
		["too old", { out: "Python 3.11.9" }, "is too old. Requires 3.12.0+"],
		["unreadable", { out: "something else" }, "Unable to detect Python version"],
		["failing", { fail: new Error("EACCES") }, "Failed to validate Python: Error: EACCES"],
	])("falls back to PATH when the configured interpreter is %s", async (_, outcome, reason) => {
		configureTools({ pythonPath: "/custom/python" });
		machine.answers.set("/custom/python --version", outcome);
		onPath("python3", "/usr/bin/python3", "Python 3.12.3");

		expect(await detect("python")).toMatchObject({ path: "/usr/bin/python3", version: "3.12.3" });
		expect(warned(reason)).toBe(true);
	});

	it.each(["Python 3.12.0", "Python 4.0.0"])("accepts %s", async (version) => {
		onPath("python3", "/usr/bin/python3", version);
		expect((await detect("python")).found).toBe(true);
	});

	it("tries python when python3 is too old", async () => {
		onPath("python3", "/usr/bin/python3", "Python 3.10.0");
		onPath("python", "/usr/local/bin/python", "Python 3.14.0");
		expect(await detect("python")).toMatchObject({ path: "/usr/local/bin/python", version: "3.14.0" });
	});

	it("uses the Python bundled with a packaged app", async () => {
		machine.packaged = true;
		Object.defineProperty(process, "resourcesPath", { value: "/app/res", configurable: true });
		const bundled = file(path.join("/app/res", "python", "bin", "python3"));
		answer(`${bundled} --version`, "Python 3.12.8");
		onPath("python3", "/usr/bin/python3", "Python 3.13.0");

		expect(await detect("python")).toMatchObject({ path: bundled, source: "bundled" });
	});

	it("looks for python.exe in a packaged Windows app", async () => {
		machine.packaged = true;
		machine.windows = true;
		Object.defineProperty(process, "resourcesPath", { value: "/app/res", configurable: true });
		const bundled = file(path.join("/app/res", "python", "python.exe"));
		answer(`${bundled} --version`, "Python 3.12.8");

		expect(await detect("python")).toMatchObject({ path: bundled, source: "bundled" });
	});

	it("goes past a bundled Python that is missing or broken", async () => {
		machine.packaged = true;
		Object.defineProperty(process, "resourcesPath", { value: "/app/res", configurable: true });
		onPath("python3", "/usr/bin/python3", "Python 3.13.0");
		expect((await detect("python")).source).toBe("system-path");

		const bundled = file(path.join("/app/res", "python", "bin", "python3"));
		fail(`${bundled} --version`);
		expect((await detect("python")).source).toBe("system-path");
	});

	it("prefers the newest Homebrew Python on macOS, in both APIs", async () => {
		machine.mac = true;
		const newest = file(path.join("/opt/homebrew/bin", "python3.13"));
		const generic = file(path.join("/opt/homebrew/bin", "python3"));
		answer(`${newest} --version`, "Python 3.13.2");
		answer(`${generic} --version`, "Python 3.12.1");

		// The async detection used its own list, which put python3 first.
		expect(await detect("python")).toMatchObject({ path: newest, version: "3.13.2", source: "homebrew" });
		// Once per API: the sync one used to run --version twice on the winner.
		expect(machine.runs.filter((line) => line.startsWith(newest))).toHaveLength(2);
	});

	it("finds an Intel Mac's versioned Homebrew Python", async () => {
		machine.mac = true;
		const intel = file(path.join("/usr/local/bin", "python3.12"));
		answer(`${intel} --version`, "Python 3.12.9");
		// /usr/local/bin/python3.12 was missing from the async list.
		expect(await detect("python")).toMatchObject({ path: intel, source: "homebrew" });
	});

	it("goes past a Homebrew Python that is too old", async () => {
		machine.mac = true;
		const old = file(path.join("/opt/homebrew/bin", "python3"));
		answer(`${old} --version`, "Python 3.9.6");
		onPath("python3", "/usr/bin/python3", "Python 3.12.0");

		expect((await detect("python")).source).toBe("system-path");
		expect(machine.runs.filter((line) => line.startsWith(old))).toHaveLength(2);
	});

	it("uses the py launcher first on Windows", async () => {
		machine.windows = true;
		answer("py -3 --version", "Python 3.12.4");
		expect(await detect("python")).toMatchObject({ path: "py -3", source: "system-path" });
	});

	it("falls back to python on PATH when the Windows launcher fails", async () => {
		machine.windows = true;
		fail("py -3 --version");
		onPath("python", "C:\\Python313\\python.exe", "Python 3.13.0");
		expect((await detect("python")).path).toBe("C:\\Python313\\python.exe");
	});

	it("says what to install when no Python fits", async () => {
		expect(await detect("python")).toEqual({
			found: false,
			source: "fallback",
			message: "Python 3.12.0+ not found. Please install Python or configure in Settings.",
		});
	});
});

describe("Git", () => {
	it("uses the configured git and reads its version", async () => {
		configureTools({ gitPath: "/custom/git" });
		answer("/custom/git --version", "git version 2.47.1\n");
		expect(await detect("git")).toEqual({
			found: true,
			path: "/custom/git",
			version: "2.47.1",
			source: "user-config",
			message: "Using user-configured Git: /custom/git",
		});
	});

	it("ignores a configured git from another platform or that does not run", async () => {
		onPath("git", "/usr/bin/git", "git version 2.43.0");
		configureTools({ gitPath: "D:/tools/git.exe" });
		expect((await detect("git")).path).toBe("/usr/bin/git");
		expect(warned("different platform")).toBe(true);

		configureTools({ gitPath: "/custom/git" });
		fail("/custom/git --version", "killed");
		expect((await detect("git")).path).toBe("/usr/bin/git");
		expect(warned("Failed to validate Git: killed")).toBe(true);
	});

	it("takes the first working Homebrew git on macOS", async () => {
		machine.mac = true;
		fail(`${file("/opt/homebrew/bin/git")} --version`);
		answer(`${file("/usr/local/bin/git")} --version`, "git version 2.46.0");
		expect(await detect("git")).toMatchObject({ path: "/usr/local/bin/git", source: "homebrew" });
	});

	it("keeps an unusual version string whole", async () => {
		onPath("git", "/usr/bin/git", "custom build");
		expect((await detect("git")).version).toBe("custom build");
	});

	it("asks where.exe, then the usual folders, on Windows", async () => {
		machine.windows = true;
		machine.where.set("git", "C:\\Git\\cmd\\git.exe");
		answer("C:\\Git\\cmd\\git.exe --version", "git version 2.47.0.windows.1");
		expect(await detect("git")).toMatchObject({
			path: "C:\\Git\\cmd\\git.exe",
			version: "2.47.0",
			message: "Using Windows Git: C:\\Git\\cmd\\git.exe",
		});

		fail("C:\\Git\\cmd\\git.exe --version");
		machine.winPaths.set("git", ["C:\\Old\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"]);
		answer("C:\\Program Files\\Git\\cmd\\git.exe --version", "git version 2.45.2");
		expect((await detect("git")).path).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
	});

	it("falls back to the bare name when git is nowhere", async () => {
		machine.windows = true;
		expect(await detect("git")).toEqual({
			found: false,
			source: "fallback",
			message: 'Git not found in standard locations. Using fallback "git".',
		});
	});
});

describe("GitHub CLI", () => {
	it("uses the configured gh and reads its version", async () => {
		configureTools({ githubCLIPath: "/custom/gh" });
		answer("/custom/gh --version", "gh version 2.63.0 (2024-11-27)\nhttps://github.com/cli/cli");
		expect(await detect("gh")).toMatchObject({ path: "/custom/gh", version: "2.63.0", source: "user-config" });
	});

	it("ignores a configured gh from another platform or that does not run", async () => {
		onPath("gh", "/usr/bin/gh", "gh version 2.40.0");
		configureTools({ githubCLIPath: "C:\\gh\\gh.exe" });
		expect((await detect("gh")).path).toBe("/usr/bin/gh");

		configureTools({ githubCLIPath: "/custom/gh" });
		fail("/custom/gh --version");
		expect((await detect("gh")).path).toBe("/usr/bin/gh");
		expect(warned("[GitHub CLI] User-configured path invalid")).toBe(true);
	});

	it("takes the first working Homebrew gh on macOS", async () => {
		machine.mac = true;
		fail(`${file("/opt/homebrew/bin/gh")} --version`, "broken");
		answer(`${file("/usr/local/bin/gh")} --version`, "gh version 2.50.0");
		expect(await detect("gh")).toMatchObject({ path: "/usr/local/bin/gh", source: "homebrew" });
	});

	it("keeps the first line of an unusual version", async () => {
		onPath("gh", "/usr/bin/gh", "gh dev\nmore");
		expect((await detect("gh")).version).toBe("gh dev");
	});

	it("looks in Program Files on Windows", async () => {
		machine.windows = true;
		const x86 = file("C:\\Program Files (x86)\\GitHub CLI\\gh.exe");
		fail(`${file("C:\\Program Files\\GitHub CLI\\gh.exe")} --version`);
		answer(`${x86} --version`, "gh version 2.60.1");
		expect(await detect("gh")).toMatchObject({ path: x86, message: `Using Windows GitHub CLI: ${x86}` });
	});

	it("says where to get gh when it is nowhere", async () => {
		machine.windows = true;
		expect((await detect("gh")).message).toBe(
			"GitHub CLI (gh) not found. Install from https://cli.github.com",
		);
	});
});

describe("GitLab CLI", () => {
	it("uses the configured glab and reads its version", async () => {
		configureTools({ gitlabCLIPath: "/custom/glab" });
		answer("/custom/glab --version", "glab 1.48.0 (a1b2c3)");
		expect(await detect("glab")).toMatchObject({ path: "/custom/glab", version: "1.48.0", source: "user-config" });
	});

	it("ignores a configured glab from another platform or that does not run", async () => {
		onPath("glab", "/usr/bin/glab", "glab 1.40.0");
		configureTools({ gitlabCLIPath: "C:\\glab\\glab.exe" });
		expect((await detect("glab")).path).toBe("/usr/bin/glab");

		configureTools({ gitlabCLIPath: "/custom/glab" });
		fail("/custom/glab --version");
		expect((await detect("glab")).path).toBe("/usr/bin/glab");
		expect(warned("[GitLab CLI] User-configured path invalid")).toBe(true);
	});

	it("takes the first working Homebrew glab on macOS", async () => {
		machine.mac = true;
		fail(`${file("/opt/homebrew/bin/glab")} --version`, 7);
		answer(`${file("/usr/local/bin/glab")} --version`, "glab 1.45.0");
		expect(await detect("glab")).toMatchObject({ path: "/usr/local/bin/glab", source: "homebrew" });
	});

	it("keeps the first line of an unusual version", async () => {
		onPath("glab", "/usr/bin/glab", "glab dev build\nx");
		expect((await detect("glab")).version).toBe("glab dev build");
	});

	it("tries the usual Windows folders", async () => {
		machine.windows = true;
		machine.winPaths.set("glab", ["C:\\bad\\glab.exe", "C:\\Program Files\\glab\\glab.exe"]);
		answer("C:\\Program Files\\glab\\glab.exe --version", "glab 1.47.0");
		expect(await detect("glab")).toMatchObject({
			path: "C:\\Program Files\\glab\\glab.exe",
			message: "Using Windows GitLab CLI: C:\\Program Files\\glab\\glab.exe",
		});
	});

	it("says where to get glab when it is nowhere", async () => {
		machine.windows = true;
		expect((await detect("glab")).message).toBe(
			"GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli",
		);
	});
});

describe("Copilot CLI (a gh extension)", () => {
	it("uses the configured gh when its copilot extension answers", async () => {
		configureTools({ copilotPath: "/custom/gh" });
		answer("/custom/gh copilot --version", "gh copilot version 1.0.5");
		expect(await detect("copilot")).toEqual({
			found: true,
			path: "/custom/gh",
			version: "1.0.5",
			source: "user-config",
			message: "Using user-configured Copilot CLI (gh): /custom/gh",
		});
	});

	it("goes through the detected gh, keeping where gh came from", async () => {
		onPath("gh", "/usr/bin/gh", "gh version 2.63.0");
		answer("/usr/bin/gh copilot --version", Buffer.from("copilot preview\nmore"));

		configureTools({ copilotPath: "C:\\gh\\gh.exe" });
		expect(await detect("copilot")).toMatchObject({
			path: "/usr/bin/gh",
			version: "copilot preview",
			source: "system-path",
			message: "Using Copilot CLI via gh: /usr/bin/gh",
		});
		expect(warned("different platform")).toBe(true);

		configureTools({ copilotPath: "/custom/gh" });
		fail("/custom/gh copilot --version", "unknown command");
		expect((await detect("copilot")).path).toBe("/usr/bin/gh");
		expect(warned("Failed to validate Copilot CLI: unknown command")).toBe(true);
	});

	it("is missing when gh has no copilot extension, or there is no gh", async () => {
		const missing =
			"Copilot CLI not found. Requires GitHub CLI (gh) with copilot extension: gh extension install github/gh-copilot";
		expect((await detect("copilot")).message).toBe(missing);

		onPath("gh", "/usr/bin/gh", "gh version 2.63.0");
		fail("/usr/bin/gh copilot --version", new Error("unknown command \"copilot\""));
		expect(await detect("copilot")).toMatchObject({ found: false, message: missing });
		expect(warned("gh found but copilot extension not available")).toBe(true);
	});
});

describe("Claude CLI", () => {
	const nvm = path.join(machine.home, ".nvm", "versions", "node");
	const localBin = path.join(machine.home, ".local", "bin", "claude");

	it("uses the configured claude and reads its version", async () => {
		configureTools({ claudePath: "/custom/claude" });
		answer("/custom/claude --version", Buffer.from("2.1.3 (Claude Code)\n"));
		expect(await detect("claude")).toEqual({
			found: true,
			path: "/custom/claude",
			version: "2.1.3",
			source: "user-config",
			message: "Using user-configured Claude CLI: /custom/claude",
		});
	});

	it("accepts a configured claude that exists even when --version fails", async () => {
		configureTools({ claudePath: '"/custom/claude"' });
		file("/custom/claude");
		fail("/custom/claude --version");
		expect(await detect("claude")).toMatchObject({ found: true, version: "unknown", path: '"/custom/claude"' });
	});

	it("goes past a configured claude from another platform, insecure, or absent", async () => {
		answer(`${file(localBin)} --version`, "claude 2.0.0");

		configureTools({ claudePath: "C:\\claude\\claude.exe" });
		expect((await detect("claude")).path).toBe(localBin);
		expect(warned("different platform")).toBe(true);

		configureTools({ claudePath: "/gone/claude" });
		expect((await detect("claude")).path).toBe(localBin);
		expect(warned("[Claude CLI] User-configured path invalid")).toBe(true);

		configureTools({ claudePath: "/broken/claude" });
		fail("/broken/claude --version", "segfault");
		expect((await detect("claude")).path).toBe(localBin);
		expect(warned('Validation FAILED for "/broken/claude": segfault')).toBe(true);
	});

	it("refuses a configured Windows path with shell characters before running it", async () => {
		machine.windows = true;
		const winLocal = path.join(machine.home, ".local", "bin", "claude.exe");
		answer(`${file(winLocal)} --version`, "2.0.1");
		configureTools({ claudePath: "C:\\a&calc\\claude.exe" });

		expect((await detect("claude")).path).toBe(winLocal);
		expect(warned("failed security validation")).toBe(true);
		expect(machine.runs.some((line) => line.includes("calc"))).toBe(false);
	});

	it("prefers the newest NVM Node's claude", async () => {
		machine.dirs.set(nvm, [
			{ name: "v18.20.0", dir: true },
			{ name: "v20.11.1", dir: true },
			{ name: ".DS_Store", dir: false },
		]);
		const v18 = file(path.join(nvm, "v18.20.0", "bin", "claude"));
		const v20 = file(path.join(nvm, "v20.11.1", "bin", "claude"));
		answer(`${v18} --version`, "1.0.0");
		answer(`${v20} --version`, "2.0.0");
		answer(`${file(localBin)} --version`, "2.0.0");

		expect(await detect("claude")).toMatchObject({ path: v20, source: "nvm", message: `Using NVM Claude CLI: ${v20}` });
	});

	it("goes on when the NVM folder cannot be read", async () => {
		machine.dirs.set(nvm, { fail: new Error("EACCES") });
		answer(`${file(localBin)} --version`, "2.0.0");
		expect(await detect("claude")).toMatchObject({ path: localBin, source: "system-path" });
		expect(warned("Failed to read NVM versions directory: EACCES")).toBe(true);

		machine.dirs.set(nvm, { fail: "EIO" });
		expect((await detect("claude")).path).toBe(localBin);
		expect(warned("Failed to read NVM versions directory: EIO")).toBe(true);
	});

	it("goes past NVM versions without claude", async () => {
		machine.dirs.set(nvm, [{ name: "v22.0.0", dir: true }]);
		answer(`${file(localBin)} --version`, "2.0.0");
		expect((await detect("claude")).path).toBe(localBin);
	});

	it("uses Homebrew's claude on macOS", async () => {
		machine.mac = true;
		answer(`${file("/opt/homebrew/bin/claude")} --version`, "2.0.0");
		expect(await detect("claude")).toMatchObject({ path: "/opt/homebrew/bin/claude", source: "homebrew" });
	});

	it("keeps the first line of a version without a number", async () => {
		answer(`${file(localBin)} --version`, "nightly\nbuild");
		expect((await detect("claude")).version).toBe("nightly");
	});

	it("says where to get claude when it is nowhere", async () => {
		machine.mac = true;
		machine.windows = false;
		expect(await detect("claude")).toEqual({
			found: false,
			source: "fallback",
			message: "Claude CLI not found. Install from https://claude.ai/download",
		});
	});

	describe("on Windows", () => {
		beforeEach(() => {
			machine.windows = true;
		});

		it("finds claude through where.exe last", async () => {
			machine.where.set("claude", "C:\\WinGet\\claude.exe");
			answer("C:\\WinGet\\claude.exe --version", "2.0.0");
			expect(await detect("claude")).toMatchObject({
				path: "C:\\WinGet\\claude.exe",
				message: "Using Windows Claude CLI: C:\\WinGet\\claude.exe",
			});
		});

		it("runs a .cmd through cmd.exe, quoted", async () => {
			setEnv("ComSpec", "C:\\Windows\\system32\\cmd.exe");
			const npmCmd = file(path.join(machine.home, "AppData", "Roaming", "npm", "claude.cmd"));
			answer(`C:\\Windows\\system32\\cmd.exe /d /s /c ""${npmCmd}" --version"`, "2.0.5");

			expect(await detect("claude")).toMatchObject({ path: npmCmd, version: "2.0.5" });
		});

		it("finds cmd.exe from SystemRoot, or C:\\Windows, without ComSpec", async () => {
			setEnv("ComSpec", undefined);
			setEnv("SystemRoot", "D:\\Win");
			machine.where.set("claude", "C:\\npm\\claude.cmd");
			const fromRoot = path.join("D:\\Win", "System32", "cmd.exe");
			answer(`${fromRoot} /d /s /c ""C:\\npm\\claude.cmd" --version"`, "2.0.5");
			expect((await detect("claude")).version).toBe("2.0.5");

			setEnv("SystemRoot", undefined);
			const fallback = path.join("C:\\Windows", "System32", "cmd.exe");
			answer(`${fallback} /d /s /c ""C:\\npm\\claude.cmd" --version"`, "2.0.6");
			expect((await detect("claude")).version).toBe("2.0.6");
		});

		it("never runs an insecure .cmd", async () => {
			machine.where.set("claude", "C:\\x&y\\claude.cmd");
			expect((await detect("claude")).found).toBe(false);
			expect(machine.runs).toEqual([]);
		});

		it("retries an .exe that does not start directly through cmd.exe", async () => {
			setEnv("ComSpec", "C:\\cmd.exe");
			machine.where.set("claude", "C:\\WinGet\\claude.exe");
			fail("C:\\WinGet\\claude.exe --version", "spawn EPERM");
			answer('C:\\cmd.exe /d /s /c ""C:\\WinGet\\claude.exe" --version"', "2.0.7");

			expect((await detect("claude")).version).toBe("2.0.7");
			expect(warned("retrying via cmd.exe: spawn EPERM")).toBe(true);
		});

		it("finds cmd.exe for the retry from SystemRoot, or C:\\Windows, without ComSpec", async () => {
			setEnv("ComSpec", undefined);
			setEnv("SystemRoot", "D:\\Win");
			machine.where.set("claude", "C:\\WinGet\\claude.exe");
			fail("C:\\WinGet\\claude.exe --version", new Error("EPERM"));
			const fromRoot = path.join("D:\\Win", "System32", "cmd.exe");
			answer(`${fromRoot} /d /s /c ""C:\\WinGet\\claude.exe" --version"`, "2.0.8");
			expect((await detect("claude")).version).toBe("2.0.8");

			setEnv("SystemRoot", undefined);
			const fallback = path.join("C:\\Windows", "System32", "cmd.exe");
			answer(`${fallback} /d /s /c ""C:\\WinGet\\claude.exe" --version"`, "2.0.9");
			expect((await detect("claude")).version).toBe("2.0.9");
		});

		it("then through PowerShell (sync), then trusts the file if it exists", async () => {
			setEnv("ComSpec", "C:\\cmd.exe");
			const exe = "C:\\Users\\O'Neil\\claude.exe";
			machine.where.set("claude", exe);
			fail(`${exe} --version`, "EPERM");
			fail(`C:\\cmd.exe /d /s /c ""${exe}" --version"`, new Error("cmd broke"));
			setEnv("SystemRoot", "C:\\Windows");
			const ps = path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const script = Buffer.from(`$r = & 'C:\\Users\\O''Neil\\claude.exe' --version 2>&1; Write-Output $r`, "utf16le").toString("base64");
			answer(`${ps} -NoProfile -NonInteractive -EncodedCommand ${script}`, "2.1.0");

			clearToolCache();
			expect(getToolInfo("claude").version).toBe("2.1.0");
			expect(warned("cmd.exe fallback failed, retrying via PowerShell: cmd broke")).toBe(true);

			// The async check has no PowerShell step: the file on disk is its last word.
			file(exe);
			clearToolCache();
			expect(await getToolPathAsync("claude")).toBe(exe);

			setEnv("SystemRoot", undefined);
			fail(`${path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")} -NoProfile -NonInteractive -EncodedCommand ${script}`);
			clearToolCache();
			expect(getToolInfo("claude")).toMatchObject({ found: true, version: "unknown" });

			fail(`C:\\cmd.exe /d /s /c ""${exe}" --version"`, "cmd exited 1");
			clearToolCache();
			getToolInfo("claude");
			expect(warned("retrying via PowerShell: cmd exited 1")).toBe(true);
		});

		it("goes past a standard install under an insecure home folder", async () => {
			machine.home = "C:\\Users\\A&B";
			try {
				const insecure = file(path.join(machine.home, ".local", "bin", "claude.exe"));
				fail(`${insecure} --version`, "spawn EPERM");
				machine.where.set("claude", "C:\\WinGet\\claude.exe");
				answer("C:\\WinGet\\claude.exe --version", "2.0.0");
				expect((await detect("claude")).path).toBe("C:\\WinGet\\claude.exe");
				expect(machine.runs.some((line) => line.includes("cmd.exe"))).toBe(false);
			} finally {
				machine.home = "/home/u";
			}
		});

		it("never trusts an insecure file whose --version failed", async () => {
			machine.where.set("claude", file("C:\\a&b\\claude.exe"));
			fail("C:\\a&b\\claude.exe --version");
			expect((await detect("claude")).found).toBe(false);
		});

		it("lets the SDK use its own CLI rather than a .cmd", async () => {
			machine.where.set("claude", "C:\\npm\\claude.cmd");
			setEnv("ComSpec", "C:\\cmd.exe");
			answer('C:\\cmd.exe /d /s /c ""C:\\npm\\claude.cmd" --version"', "2.0.0");
			expect(getClaudeCliPathForSdk()).toBeNull();
			clearToolCache();
			expect(await getClaudeCliPathForSdkAsync()).toBeNull();
		});
	});

	it("hands the SDK the detected claude elsewhere", async () => {
		answer(`${file(localBin)} --version`, "2.0.0");
		expect(getClaudeCliPathForSdk()).toBe(localBin);
		expect(await getClaudeCliPathForSdkAsync()).toBe(localBin);
	});
});

describe.each([
	["git", "git version 2.40.0", 'Git not found in standard locations. Using fallback "git".'],
	["gh", "gh version 2.40.0", "GitHub CLI (gh) not found. Install from https://cli.github.com"],
	["glab", "glab 1.40.0", "GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli"],
] as const)("%s, wherever it is", (tool, version, missing) => {
	it("takes the Intel Homebrew copy when there is no Apple Silicon one", async () => {
		machine.mac = true;
		answer(`${file(`/usr/local/bin/${tool}`)} --version`, version);
		expect(await detect(tool)).toMatchObject({ path: `/usr/local/bin/${tool}`, source: "homebrew" });
	});

	it("is missing on Linux when the copy on PATH does not run", async () => {
		machine.onPath.set(tool, `/usr/bin/${tool}`);
		fail(`/usr/bin/${tool} --version`);
		expect(await detect(tool)).toEqual({ found: false, source: "fallback", message: missing });
	});
});

describe("Homebrew Python helper", () => {
	it("tries the next candidate when a validator throws", () => {
		machine.files.add(path.join("/opt/homebrew/bin", "python3.14"));
		const second = file(path.join("/opt/homebrew/bin", "python3"));
		const validate = vi.fn((p: string) => {
			if (p !== second) throw new Error("timeout");
			return { valid: true, message: "ok" };
		});
		expect(findHomebrewPython(validate, "[Test]")).toBe(second);
		expect(warned("[Test] Failed to validate")).toBe(true);
	});

	it("says why it rejects a candidate, and null when none fits", () => {
		file(path.join("/usr/local/bin", "python3"));
		expect(findHomebrewPython(() => ({ valid: false, message: "too old" }), "[Test]")).toBeNull();
		expect(warned("rejected: too old")).toBe(true);
	});
});

describe("NVM version order", () => {
	it("keeps versions that are numerically equal", () => {
		const dir = (name: string) => ({ name, isDirectory: () => true });
		expect(sortNvmVersionDirs([dir("v20.0.0"), dir("v020.0.0"), dir("v21.0.0")])).toEqual([
			"v21.0.0",
			"v20.0.0",
			"v020.0.0",
		]);
	});
});

describe("caching", () => {
	it("detects a tool once, until the cache is cleared", () => {
		onPath("git", "/usr/bin/git", "git version 2.40.0");
		expect(getToolPath("git")).toBe("/usr/bin/git");
		expect(getToolPath("git")).toBe("/usr/bin/git");
		expect(machine.runs).toEqual(["/usr/bin/git --version"]);

		clearToolCache();
		getToolPath("git");
		expect(machine.runs).toHaveLength(2);
	});

	it("re-detects claude on every sync call", () => {
		answer(`${file(path.join(machine.home, ".local", "bin", "claude"))} --version`, "2.0.0");
		getToolPath("claude");
		getToolPath("claude");
		expect(machine.runs).toHaveLength(2);
	});

	it("answers the bare name for a tool it cannot find", async () => {
		expect(getToolPath("gh")).toBe("gh");
		expect(await getToolPathAsync("glab")).toBe("glab");
		expect(warned('gh not found, using fallback: "gh"')).toBe(true);
	});

	it("keeps diagnostics for 30 seconds", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		onPath("gh", "/usr/bin/gh", "gh version 2.0.0");
		getToolInfo("gh");
		now.mockReturnValue(1_029_999);
		getToolInfo("gh");
		expect(machine.runs).toHaveLength(1);
		now.mockReturnValue(1_030_000);
		getToolInfo("gh");
		expect(machine.runs).toHaveLength(2);
	});

	it("runs one async detection for concurrent callers, then answers from the cache", async () => {
		onPath("git", "/usr/bin/git", "git version 2.40.0");
		const both = await Promise.all([getToolPathAsync("git"), getToolPathAsync("git")]);
		expect(both).toEqual(["/usr/bin/git", "/usr/bin/git"]);
		expect(await getToolPathAsync("git")).toBe("/usr/bin/git");
		expect(getToolPath("git")).toBe("/usr/bin/git");
		expect(machine.runs).toEqual(["/usr/bin/git --version"]);
	});

	it("does not cache a detection that a configuration change overtook", async () => {
		onPath("git", "/usr/bin/git", "git version 2.40.0");
		answer("/opt/git --version", "git version 2.47.0");

		const before = getToolPathAsync("git");
		configureTools({ gitPath: "/opt/git" });
		const after = getToolPathAsync("git");

		expect(await before).toBe("/usr/bin/git");
		expect(await after).toBe("/opt/git");
		expect(await getToolPathAsync("git")).toBe("/opt/git");
		expect(machine.runs.filter((line) => line === "/opt/git --version")).toHaveLength(1);
	});

	it("pre-warms claude by default, or the tools asked for", async () => {
		answer(`${file(path.join(machine.home, ".local", "bin", "claude"))} --version`, "2.0.0");
		onPath("git", "/usr/bin/git", "git version 2.40.0");
		onPath("gh", "/usr/bin/gh", "gh version 2.0.0");

		await preWarmToolCache();
		expect(machine.runs).toHaveLength(1);
		await preWarmToolCache(["git", "gh"]);
		getToolPath("git");
		getToolPath("gh");
		expect(machine.runs).toHaveLength(3);
	});

	it("answers an unknown tool with its own name", async () => {
		const unknown = "svn" as CLITool;
		expect(getToolInfo(unknown)).toEqual({ found: false, source: "fallback", message: "Unknown tool: svn" });
		expect(await getToolPathAsync(unknown)).toBe("svn");
	});
});

describe("configuration", () => {
	it("changes only when a path changes, an empty path meaning detect", () => {
		onPath("git", "/usr/bin/git", "git version 2.40.0");
		expect(configureTools({ gitPath: "" })).toBe(false);
		getToolPath("git");
		expect(configureTools({ gitPath: "/opt/git" })).toBe(true);
		expect(configureTools({ gitPath: "/opt/git" })).toBe(false);
		answer("/opt/git --version", "git version 2.47.0");
		expect(getToolPath("git")).toBe("/opt/git");
	});

	it("updates some paths and keeps the others", () => {
		answer("/opt/git --version", "git version 2.47.0");
		answer("/opt/gh --version", "gh version 2.63.0");
		configureTools({ gitPath: "/opt/git" });
		expect(updateToolConfig({ githubCLIPath: "/opt/gh" })).toBe(true);
		expect(getToolPath("git")).toBe("/opt/git");
		expect(getToolPath("gh")).toBe("/opt/gh");
	});

	it("reads the string paths of the app settings", () => {
		answer("/opt/git --version", "git version 2.47.0");
		expect(configureToolsFromSettings({ gitPath: "/opt/git", pythonPath: 3, claudePath: "" })).toBe(true);
		expect(getToolPath("git")).toBe("/opt/git");
		expect(configureToolsFromSettings({ gitPath: "/opt/git" })).toBe(false);
	});
});

describe("isPathFromWrongPlatform", () => {
	it.each([
		[undefined, false],
		["", false],
		["/usr/bin/claude", false],
		["C:\\tools\\claude.exe", true],
		["d:/tools/claude.exe", true],
		["tools\\claude", true],
		["/Users/me/AppData/claude", true],
		["/mnt/Program Files/claude", true],
	])("on Mac or Linux, %s → %s", (p, wrong) => {
		expect(isPathFromWrongPlatform(p)).toBe(wrong);
	});

	it.each([
		["/usr/bin/claude", true],
		["//server/share/claude.exe", false],
		["C:\\tools\\claude.exe", false],
		["tools/claude", false],
	])("on Windows, %s → %s", (p, wrong) => {
		machine.windows = true;
		expect(isPathFromWrongPlatform(p)).toBe(wrong);
	});
});
