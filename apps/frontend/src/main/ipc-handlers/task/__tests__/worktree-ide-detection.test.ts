/**
 * @vitest-environment node
 *
 * Detecting installed IDEs and terminals, and opening a folder in one, on
 * each OS. The machine is stood in for: the OS by `getCurrentOS`, the
 * system folders (/Applications, /usr/share/applications, C:\Program
 * Files…) by a small table, the commands by recorded calls. What is checked
 * is what reaches the OS: the folder always as an argument of an argv,
 * never inside a command line, cmd.exe only with a quoted line, and a
 * missing launcher reported, not thrown.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sys = vi.hoisted(() => ({
	os: "linux" as "linux" | "darwin" | "win32",
	/** Fake system paths: a folder lists its entries, a file has its content. */
	files: new Map<string, string[] | string>(),
	home: "/home/tester",
	exec: (_cmd: string): string => {
		throw new Error("not found");
	},
	execFileFails: new Set<string>(),
	execFileCalls: [] as Array<[string, string[], unknown]>,
	spawnCalls: [] as Array<[string, string[], Record<string, unknown>]>,
	openPath: [] as string[],
}));

/** A path of the real disk this test made, as opposed to the faked system. */
const isReal = (p: string) => p.startsWith(tmpdir()) || p.startsWith(process.cwd());

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		existsSync: (p: string) => (isReal(String(p)) ? fs.existsSync(p) : sys.files.has(String(p))),
		readdirSync: (p: string, ...rest: unknown[]) => {
			if (isReal(String(p))) return (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
			const entry = sys.files.get(String(p));
			if (!Array.isArray(entry)) throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
			return entry;
		},
		readFileSync: (p: string, ...rest: unknown[]) => {
			if (isReal(String(p))) return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
			const entry = sys.files.get(String(p));
			if (typeof entry !== "string") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return entry;
		},
	};
});
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => sys.home,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		exec: (cmd: string, _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
			try {
				cb(null, { stdout: sys.exec(cmd), stderr: "" });
			} catch (error) {
				cb(error);
			}
		},
		execFile: (file: string, args: string[], opts: unknown, cb?: (e: unknown, r?: unknown) => void) => {
			const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r?: unknown) => void;
			sys.execFileCalls.push([file, args, typeof opts === "function" ? undefined : opts]);
			if (sys.execFileFails.has(file)) done(new Error(`${file}: not installed`));
			else done(null, { stdout: "", stderr: "" });
		},
		spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
			sys.spawnCalls.push([file, args, opts]);
			return { unref: () => undefined };
		},
	};
});
vi.mock("electron", () => ({
	shell: {
		openPath: async (p: string) => {
			sys.openPath.push(p);
			return "";
		},
	},
}));
vi.mock("../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../platform")>()),
	getCurrentOS: () => sys.os,
}));

import {
	detectInstalledTools,
	detectLinuxApps,
	detectMacApps,
	detectWindowsApps,
	IDE_DETECTION,
	isAppInstalled,
	isPathSafe,
	openInIDE,
	openInTerminal,
	TERMINAL_DETECTION,
} from "../worktree-ide-terminal";

const DIR = "/work/project";

beforeEach(() => {
	sys.os = "linux";
	sys.files = new Map();
	sys.home = "/home/tester";
	sys.exec = () => {
		throw new Error("not found");
	};
	sys.execFileFails = new Set();
	sys.execFileCalls = [];
	sys.spawnCalls = [];
	sys.openPath = [];
});

describe("app discovery", () => {
	it("macOS: reads Spotlight's list, or the Applications folder when Spotlight fails", async () => {
		sys.exec = () => "/Applications/Visual Studio Code.app\n/Applications/iTerm.app\nnot-an-app\n";
		expect([...(await detectMacApps())]).toEqual(["visual studio code", "iterm"]);

		sys.exec = () => {
			throw new Error("mdfind: timeout");
		};
		sys.files.set("/Applications", ["Warp.app", "notes.txt"]);
		expect([...(await detectMacApps())]).toEqual(["warp"]);

		sys.files.set("/Applications", "not a folder");
		expect([...(await detectMacApps())]).toEqual([]);
		sys.files.delete("/Applications");
		expect([...(await detectMacApps())]).toEqual([]);
	});

	it("Windows: reads the registry's programs, or the program folders", async () => {
		sys.exec = () => JSON.stringify([{ DisplayName: "Cursor" }, { DisplayName: null }]);
		expect([...(await detectWindowsApps())]).toEqual(["cursor"]);
		sys.exec = () => JSON.stringify({ DisplayName: "single" });
		expect([...(await detectWindowsApps())]).toEqual([]);

		sys.exec = () => "not json";
		const saved = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = "C:\\Users\\t\\AppData\\Local";
		sys.files.set("C:\\Program Files", ["JetBrains", "Git"]);
		sys.files.set("C:\\Program Files (x86)", "broken");
		sys.files.set("C:\\Users\\t\\AppData\\Local", ["Programs"]);
		expect([...(await detectWindowsApps())]).toEqual(["jetbrains", "git", "programs"]);
		delete process.env.LOCALAPPDATA;
		sys.files.clear();
		expect([...(await detectWindowsApps())]).toEqual([]);
		if (saved !== undefined) process.env.LOCALAPPDATA = saved;
	});

	it("Linux: reads .desktop files and their Name=, and the binary folders", async () => {
		sys.files.set("/usr/share/applications", ["code.desktop", "kitty.desktop", "README"]);
		sys.files.set("/usr/share/applications/code.desktop", "[Desktop Entry]\nName=Visual Studio Code\n");
		sys.files.set("/home/tester/.local/share/applications", "broken");
		sys.files.set("/usr/bin", ["Zed", "git"]);
		sys.files.set("/snap/bin", "broken");
		const apps = await detectLinuxApps();
		expect([...apps]).toEqual(["code", "visual studio code", "kitty", "zed", "git"]);
	});
});

describe("isAppInstalled", () => {
	it("finds an app by name in the cache, by path, or by a glob's folder", async () => {
		sys.files.set("/usr/bin", ["kate"]);
		await detectLinuxApps().then(async () => {
			// Fill the cache the way detection does.
			sys.os = "linux";
			await detectInstalledTools();
		});
		expect(isAppInstalled(["Kate"], [], "linux")).toEqual({ installed: true, foundPath: "" });

		sys.files.set("/opt/editor/bin", []);
		expect(isAppInstalled(["nothing"], ["/opt/editor/bin"], "linux")).toEqual({
			installed: true,
			foundPath: "/opt/editor/bin",
		});
		sys.files.set("/opt/JetBrains", []);
		expect(isAppInstalled([], ["/opt/JetBrains*"], "linux").installed).toBe(true);
		sys.files.set("/home/tester/apps/x", []);
		expect(isAppInstalled([], ["~/apps/x"], "linux").foundPath).toBe("/home/tester/apps/x");
		expect(isAppInstalled([], ["/opt/missing"], "linux")).toEqual({ installed: false, foundPath: "" });
	});

	it("skips a path that climbs out after expansion", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const saved = process.env.USERNAME;
		process.env.USERNAME = "..";
		sys.files.set("C:\\Users\\..\\x", []);
		expect(isAppInstalled([], ["C:\\Users\\%USERNAME%\\x"], "win32").installed).toBe(false);
		expect(warn).toHaveBeenCalled();
		if (saved === undefined) delete process.env.USERNAME;
		else process.env.USERNAME = saved;
		expect(isPathSafe("../etc")).toBe(false);
		expect(isPathSafe("/usr/bin")).toBe(true);
		warn.mockRestore();
	});
});

describe("detectInstalledTools", () => {
	it("Linux: lists the IDEs found by path or by `which`, and always a system terminal", async () => {
		sys.files.set("/usr/share/code", []);
		sys.exec = (cmd) => {
			if (cmd === "which cursor") return "/usr/bin/cursor\n";
			throw new Error("not found");
		};
		const tools = await detectInstalledTools();
		const ids = tools.ides.map((t) => t.id);
		expect(ids).toContain("vscode");
		expect(ids).toContain("cursor");
		expect(tools.ides.find((t) => t.id === "vscode")?.path).toBe("/usr/share/code");
		expect(tools.terminals[0]).toEqual({
			id: "system",
			name: "System Terminal",
			path: "",
			installed: true,
		});
	});

	it("macOS: finds apps through Spotlight and keeps the system terminal first", async () => {
		sys.os = "darwin";
		sys.exec = (cmd) => {
			if (cmd.startsWith("mdfind")) return "/Applications/Visual Studio Code.app\n/Applications/Warp.app\n";
			throw new Error("not found");
		};
		sys.files.set("/System/Applications/Utilities/Terminal.app", []);
		const tools = await detectInstalledTools();
		expect(tools.ides.map((t) => t.id)).toContain("vscode");
		expect(tools.terminals.map((t) => t.id)).toEqual(
			expect.arrayContaining(["system", "terminal", "warp"]),
		);
		expect(tools.terminals.filter((t) => t.id === "system")).toHaveLength(1);
	});

	it("Windows: asks `where` for a command", async () => {
		sys.os = "win32";
		const asked: string[] = [];
		sys.exec = (cmd) => {
			asked.push(cmd);
			if (cmd === "where code.cmd") return "C:\\code.cmd";
			throw new Error("not found");
		};
		const tools = await detectInstalledTools();
		expect(asked.some((c) => c.startsWith("powershell"))).toBe(true);
		expect(tools.ides.map((t) => t.id)).toContain("vscode");
		expect(asked).toContain("where code.cmd");
	});
});

describe("openInIDE", () => {
	let launcherDir = "";
	beforeEach(() => {
		launcherDir = mkdtempSync(path.join(tmpdir(), "ide-launcher-"));
	});
	afterEach(() => rmSync(launcherDir, { recursive: true, force: true }));

	it("runs a custom launcher from settings with the folder as its only argument", async () => {
		const launcher = path.join(launcherDir, "my-ide");
		writeFileSync(launcher, "", "utf-8");
		expect(await openInIDE(DIR, "custom", launcher)).toEqual({ success: true });
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual([expect.stringContaining("my-ide"), [DIR]]);
		expect(await openInIDE(DIR, "custom", "code --evil")).toEqual({
			success: false,
			error: "Invalid custom IDE path",
		});
	});

	it("refuses an unknown IDE and one that has no command on this OS", async () => {
		expect(await openInIDE(DIR, "nope" as never)).toEqual({ success: false, error: "Unknown IDE: nope" });
		const [noLinux] = Object.entries(IDE_DETECTION).filter(
			([id, c]) => id !== "custom" && c && !c.commands.linux,
		);
		expect(noLinux).toBeDefined();
		expect(await openInIDE(DIR, noLinux[0] as never)).toEqual({
			success: false,
			error: `IDE ${noLinux[0]} is not supported on linux`,
		});
	});

	it("macOS: opens the .app bundle with `open -a`, else its command", async () => {
		sys.os = "darwin";
		sys.files.set("/Applications/Visual Studio Code.app", []);
		expect(await openInIDE(DIR, "vscode")).toEqual({ success: true });
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual([
			"open",
			["-a", "Visual Studio Code", DIR],
		]);
		sys.files.clear();
		await openInIDE(DIR, "vscode");
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual(["code", [DIR]]);
	});

	it("Windows: runs a .cmd launcher through cmd.exe with a quoted line, and refuses a folder quotes cannot protect", async () => {
		sys.os = "win32";
		expect(await openInIDE("C:\\Repos\\app", "vscode")).toEqual({ success: true });
		const [file, args, opts] = sys.spawnCalls.at(-1) ?? [];
		expect(file).toBe("cmd.exe");
		expect(args).toEqual(["/d", "/s", "/c", '"code.cmd "C:\\Repos\\app""']);
		expect(opts).toMatchObject({ windowsVerbatimArguments: true, detached: true });

		expect(await openInIDE('C:\\Repos\\a" & calc & "', "vscode")).toEqual({
			success: false,
			error: "This folder path cannot be opened with Visual Studio Code",
		});
		const [plainExe] = Object.entries(IDE_DETECTION).filter(
			([id, c]) => id !== "custom" && c?.commands.win32 && !/\.(cmd|bat)$/.test(c.commands.win32),
		);
		await openInIDE("C:\\Repos\\app", plainExe[0] as never);
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual([
			plainExe[1]?.commands.win32,
			["C:\\Repos\\app"],
		]);
	});

	it("reports a launcher that fails", async () => {
		sys.execFileFails.add("code");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await openInIDE(DIR, "vscode")).toEqual({ success: false, error: "code: not installed" });
		error.mockRestore();
	});
});

describe("openInTerminal", () => {
	const withCommands = (os: "linux" | "win32" | "darwin") =>
		Object.entries(TERMINAL_DETECTION).find(
			([id, c]) =>
				!["system", "custom", "iterm2", "warp"].includes(id) && (c?.commands[os]?.length ?? 0) > 0,
		) as [string, { commands: Record<string, string[]> }];

	it("runs a custom terminal from settings, and refuses an invalid one or an unknown terminal", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "term-launcher-"));
		const launcher = path.join(dir, "my-term");
		writeFileSync(launcher, "", "utf-8");
		expect(await openInTerminal(DIR, "custom", launcher)).toEqual({ success: true });
		expect(sys.execFileCalls.at(-1)?.[1]).toEqual([DIR]);
		rmSync(dir, { recursive: true });
		expect(await openInTerminal(DIR, "custom", undefined)).toEqual({
			success: false,
			error: "Invalid custom terminal path",
		});
		expect(await openInTerminal(DIR, "nope" as never)).toEqual({
			success: false,
			error: "Unknown terminal: nope",
		});
	});

	it("opens the folder in the file manager when the terminal has no command here", async () => {
		expect(await openInTerminal(DIR, "iterm2")).toEqual({ success: true });
		expect(sys.openPath).toEqual([DIR]);
	});

	it("macOS: passes the folder to the AppleScript as argv, opens Warp, runs other terminals", async () => {
		sys.os = "darwin";
		await openInTerminal(DIR, "system");
		const [file, args] = sys.execFileCalls.at(-1) ?? [];
		expect(file).toBe("osascript");
		expect(args?.[0]).toBe("-e");
		expect(args?.at(-1)).toBe(DIR);
		expect(String(args?.[1])).not.toContain(DIR);

		await openInTerminal(DIR, "warp");
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual(["open", ["-a", "Warp", DIR]]);

		await openInTerminal(DIR, "terminal");
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual(["open", ["-a", "Terminal", DIR]]);
	});

	it("Windows: opens cmd.exe with a quoted cd, or another terminal with the folder as argument", async () => {
		sys.os = "win32";
		expect(await openInTerminal("C:\\Repos\\app", "system")).toEqual({ success: true });
		expect(sys.spawnCalls.at(-1)?.slice(0, 2)).toEqual([
			"cmd.exe",
			["/d", "/s", "/k", '"cd /d "C:\\Repos\\app""'],
		]);
		expect(await openInTerminal("C:\\Repos\\%PATH%", "system")).toEqual({
			success: false,
			error: "This folder path cannot be opened in cmd.exe",
		});
		const [id, config] = withCommands("win32");
		await openInTerminal("C:\\Repos\\app", id as never);
		const [file, args] = sys.spawnCalls.at(-1) ?? [];
		expect(file).toBe(config.commands.win32[0]);
		expect(args?.at(-1)).toBe("C:\\Repos\\app");
	});

	it("Linux: tries x-terminal-emulator, then gnome-terminal, then xterm started in the folder", async () => {
		await openInTerminal(DIR, "system");
		expect(sys.execFileCalls.map((c) => c[0])).toEqual(["x-terminal-emulator"]);

		sys.execFileCalls = [];
		sys.execFileFails = new Set(["x-terminal-emulator"]);
		await openInTerminal(DIR, "system");
		expect(sys.execFileCalls.map((c) => c[0])).toEqual(["x-terminal-emulator", "gnome-terminal"]);

		sys.execFileCalls = [];
		sys.execFileFails = new Set(["x-terminal-emulator", "gnome-terminal"]);
		await openInTerminal(DIR, "system");
		const xterm = sys.execFileCalls.at(-1);
		expect(xterm?.slice(0, 2)).toEqual(["xterm", ["-e", "bash"]]);
		expect(xterm?.[2]).toMatchObject({ cwd: DIR });

		const [id, config] = withCommands("linux");
		sys.execFileFails = new Set();
		await openInTerminal(DIR, id as never);
		expect(sys.execFileCalls.at(-1)?.slice(0, 2)).toEqual([
			config.commands.linux[0],
			[...config.commands.linux.slice(1), DIR],
		]);
	});

	it("reports a terminal that cannot be started", async () => {
		sys.execFileFails = new Set(["x-terminal-emulator", "gnome-terminal", "xterm"]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await openInTerminal(DIR, "system")).toEqual({
			success: false,
			error: "xterm: not installed",
		});
		error.mockRestore();
	});
});
