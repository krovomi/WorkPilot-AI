/**
 * The REA badge's main side: which `rea-agents` release `rea` on PATH leads
 * to (read from its package.json, never by running it), and an install that
 * asks npm for the pinned release only, without install scripts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../env-utils", () => ({
	getAugmentedEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
	clearNpmPrefixCache: vi.fn(),
}));
vi.mock("../platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../platform")>();
	return {
		...actual,
		findExecutable: vi.fn(() => null),
		getPathDelimiter: vi.fn(() => ":"),
	};
});
vi.mock("../node-installs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../node-installs")>();
	// The real home of whoever runs the tests is never read.
	return { ...actual, managedNodeInstalls: vi.fn(() => []) };
});
vi.mock("./agent-cli-install", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./agent-cli-install")>();
	return {
		...actual,
		readHost: vi.fn(),
		runStep: vi.fn(),
		refreshWindowsPath: vi.fn(async () => undefined),
	};
});

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { nodeSatisfies, REA_PIN, REA_SPEC, type ReaStatus } from "../../shared/types/rea";
import { findExecutable } from "../platform";
import {
	busyCliTools,
	type InstallHost,
	readHost,
	runStep,
} from "./agent-cli-install";
import {
	checkRea,
	installedReaVersion,
	installRea,
	pickManagedNode,
	planReaInstall,
	type ReaNode,
	readReaStatus,
	registerReaHandlers,
} from "./rea-handlers";

const linux: InstallHost = {
	platform: "linux",
	npm: "/usr/bin/npm",
	nodeVersion: "22.23.4",
	homeDir: "/home/me",
};

let root: string;

function writePackage(dir: string, version: string, name = "rea-agents"): string {
	const entry = path.join(dir, name, "scripts", "rea.mjs");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "", "utf-8");
	fs.writeFileSync(
		path.join(dir, name, "package.json"),
		JSON.stringify({ name, version }),
		"utf-8",
	);
	return entry;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-badge-"));
	vi.mocked(findExecutable).mockReturnValue(null);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	vi.mocked(readHost).mockReset();
	vi.mocked(runStep).mockReset();
	busyCliTools.clear();
});

describe("nodeSatisfies", () => {
	it("reads ^ within the major and >= from the minimum on", () => {
		expect(nodeSatisfies("22.23.4", REA_PIN.node)).toBe(true);
		expect(nodeSatisfies("v22.30.0", REA_PIN.node)).toBe(true);
		expect(nodeSatisfies("22.23.3", REA_PIN.node)).toBe(false);
		expect(nodeSatisfies("23.5.0", REA_PIN.node)).toBe(false);
		expect(nodeSatisfies("24.22.1", REA_PIN.node)).toBe(true);
		expect(nodeSatisfies("27.0.0", REA_PIN.node)).toBe(true);
		expect(nodeSatisfies("20.19.0", REA_PIN.node)).toBe(false);
		expect(nodeSatisfies("not a version", REA_PIN.node)).toBe(false);
		expect(nodeSatisfies("22.23.4", ["~22.0.0"])).toBe(false);
	});
});

describe("installedReaVersion", () => {
	it("follows the npm symlink to the package", () => {
		const entry = writePackage(path.join(root, "lib", "node_modules"), "6.9.0");
		const link = path.join(root, "bin", "rea");
		fs.mkdirSync(path.dirname(link));
		let launcher = link;
		try {
			fs.symlinkSync(entry, link);
		} catch {
			launcher = entry; // Windows without the symlink right: the link's target
		}
		expect(installedReaVersion(launcher)).toBe("6.9.0");
	});

	it("reads the package beside a Windows rea.cmd", () => {
		writePackage(path.join(root, "npm", "node_modules"), "6.8.0");
		const launcher = path.join(root, "npm", "rea.cmd");
		fs.writeFileSync(launcher, "@node ...", "utf-8");
		expect(installedReaVersion(launcher)).toBe("6.8.0");
	});

	it("ignores another package called rea", () => {
		writePackage(path.join(root, "npm", "node_modules"), "6.9.0", "rea-agents");
		fs.writeFileSync(
			path.join(root, "npm", "node_modules", "rea-agents", "package.json"),
			JSON.stringify({ name: "not-rea", version: "6.9.0" }),
			"utf-8",
		);
		const launcher = path.join(root, "npm", "rea.cmd");
		fs.writeFileSync(launcher, "", "utf-8");
		expect(installedReaVersion(launcher)).toBeUndefined();
	});
});

describe("readReaStatus", () => {
	const env = { PATH: "/usr/bin" };

	it("needs a Node.js the release accepts before anything else", () => {
		expect(readReaStatus({ ...linux, nodeVersion: null }, env).state).toBe("node_missing");
		const old = readReaStatus({ ...linux, nodeVersion: "20.19.0" }, env);
		expect(old).toMatchObject({ state: "node_too_old", nodeVersion: "20.19.0" });
		expect(findExecutable).not.toHaveBeenCalled();
	});

	it("says absent without rea on PATH, and ignores a Windows rea under WSL", () => {
		expect(readReaStatus(linux, env)).toEqual({
			state: "absent",
			pinned: REA_PIN.version,
			nodeVersion: "22.23.4",
		});
		vi.mocked(findExecutable).mockReturnValue("/mnt/c/Users/me/AppData/Roaming/npm/rea");
		expect(readReaStatus(linux, env).state).toBe("absent");
	});

	it("is ready only at the pinned version", () => {
		writePackage(path.join(root, "npm", "node_modules"), REA_PIN.version);
		const launcher = path.join(root, "npm", "rea.cmd");
		fs.writeFileSync(launcher, "", "utf-8");
		vi.mocked(findExecutable).mockReturnValue(launcher);
		expect(readReaStatus(linux, env)).toMatchObject({
			state: "ready",
			installedVersion: REA_PIN.version,
		});
	});

	it("reports another version as present but not run", () => {
		writePackage(path.join(root, "npm", "node_modules"), "7.0.0");
		const launcher = path.join(root, "npm", "rea.cmd");
		fs.writeFileSync(launcher, "", "utf-8");
		vi.mocked(findExecutable).mockReturnValue(launcher);
		expect(readReaStatus(linux, env)).toMatchObject({
			state: "other_version",
			installedVersion: "7.0.0",
		});
	});

	it("reports a rea that leads to no rea-agents package as another version", () => {
		const launcher = path.join(root, "rea");
		fs.writeFileSync(launcher, "", "utf-8");
		vi.mocked(findExecutable).mockReturnValue(launcher);
		const status = readReaStatus(linux, env);
		expect(status.state).toBe("other_version");
		expect(status.installedVersion).toBeUndefined();
	});

	it("checkRea turns a failing host read into an answer", async () => {
		vi.mocked(readHost).mockRejectedValueOnce(new Error("boom"));
		await expect(checkRea()).resolves.toMatchObject({ state: "absent", error: "boom" });
	});
});

describe("a Node.js from a version manager", () => {
	// Under WSL the app inherits nvm's default alias (26.10.0) while the
	// user's terminal switched to 27.0.0-alpha: REA said « too old ».
	const wsl: InstallHost = { ...linux, nodeVersion: "26.10.0" };
	const install = (version: string, manager = "nvm") => ({
		path: `/home/me/.nvm/versions/node/v${version}/bin/node`,
		version: version.split(/[.-]/).slice(0, 3).map(Number) as [number, number, number],
		manager,
	});

	it("keeps the PATH's Node.js when REA accepts it", async () => {
		const readVersion = vi.fn();
		await expect(
			pickManagedNode(linux, {}, [install("27.0.0")], readVersion),
		).resolves.toBeUndefined();
		expect(readVersion).not.toHaveBeenCalled();
	});

	it("takes the newest accepted release, a prerelease included", async () => {
		const answers: Record<string, string> = {
			[install("27.0.0-alpha.0.1.0").path]: "27.0.0",
			[install("26.10.0").path]: "26.10.0",
		};
		const node = await pickManagedNode(
			wsl,
			{},
			[install("27.0.0-alpha.0.1.0"), install("26.10.0")],
			async (path) => answers[path] ?? null,
		);
		expect(node).toEqual({
			path: install("27.0.0-alpha.0.1.0").path,
			version: "27.0.0",
			manager: "nvm",
		});
		expect(nodeSatisfies("27.0.0-alpha.1", REA_PIN.node)).toBe(true);
	});

	it("believes the binary, not its directory name, and skips Windows under WSL", async () => {
		const liar = install("30.0.0");
		const windows = { ...install("26.12.1"), path: "/mnt/c/nvm/v26.12.1/node.exe" };
		const readVersion = vi.fn(async (path: string) => (path === liar.path ? "18.0.0" : "26.12.1"));
		await expect(pickManagedNode(wsl, {}, [liar, windows], readVersion)).resolves.toBeUndefined();
		expect(readVersion).toHaveBeenCalledTimes(1);
	});

	it("is ready with the rea npm wrote beside that Node.js", () => {
		const bin = path.join(root, "v27", "bin");
		const entry = writePackage(path.join(bin, "node_modules"), REA_PIN.version);
		const node: ReaNode = { path: path.join(bin, "node"), version: "27.0.0", manager: "nvm" };
		expect(readReaStatus(wsl, { PATH: "/usr/bin" }, node)).toEqual({
			state: "ready",
			pinned: REA_PIN.version,
			installedVersion: REA_PIN.version,
			nodeVersion: "27.0.0",
			nodeManager: "nvm",
		});
		expect(fs.existsSync(entry)).toBe(true);
		const bare: ReaNode = { ...node, path: path.join(root, "v28", "bin", "node") };
		expect(readReaStatus(wsl, { PATH: "/usr/bin" }, bare)).toMatchObject({
			state: "absent",
			nodeManager: "nvm",
		});
		expect(readReaStatus(wsl, { PATH: "/usr/bin" })).toMatchObject({
			state: "node_too_old",
			nodeVersion: "26.10.0",
		});
	});

	it("installs with that Node.js's own npm, without a shell", () => {
		const prefix = path.join(root, "v27");
		const npmCli = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
		fs.mkdirSync(path.dirname(npmCli), { recursive: true });
		fs.writeFileSync(npmCli, "", "utf-8");
		const node: ReaNode = {
			path: path.join(prefix, "bin", "node"),
			version: "27.0.0",
			manager: "nvm",
		};
		expect(planReaInstall({ ...wsl, platform: "win32" }, node)).toEqual({
			method: "npm",
			command: node.path,
			args: [npmCli, "install", "-g", "--ignore-scripts", REA_SPEC],
			shell: false,
		});
		expect(planReaInstall(wsl, { ...node, path: path.join(root, "none", "node") })).toBeNull();
	});
});

describe("installRea", () => {
	const ready: ReaStatus = { state: "ready", pinned: REA_PIN.version };

	it("asks npm for the pinned release, without install scripts", () => {
		expect(planReaInstall(linux)).toEqual({
			method: "npm",
			command: "/usr/bin/npm",
			args: ["install", "-g", "--ignore-scripts", REA_SPEC],
			shell: false,
		});
		expect(REA_SPEC).toBe(`rea-agents@${REA_PIN.version}`);
		expect(REA_SPEC).not.toMatch(/latest|\^|~|>/);
		expect(planReaInstall({ ...linux, platform: "win32", npm: "C:\\nodejs\\npm.cmd" })?.shell).toBe(
			true,
		);
	});

	it("refuses without npm or a Node.js the release accepts", async () => {
		expect(planReaInstall({ ...linux, npm: null })).toBeNull();
		expect(planReaInstall({ ...linux, nodeVersion: "18.0.0" })).toBeNull();
		vi.mocked(readHost).mockResolvedValue({ ...linux, npm: null });
		await expect(installRea(async () => ready)).resolves.toEqual({
			success: false,
			error: "node_required",
		});
		expect(runStep).not.toHaveBeenCalled();
	});

	it("installs then checks", async () => {
		vi.mocked(readHost).mockResolvedValue(linux);
		vi.mocked(runStep).mockResolvedValue({ ok: true, output: "added 1 package" });
		await expect(installRea(async () => ready)).resolves.toEqual({
			success: true,
			status: ready,
		});
	});

	it("retries into ~/.local when the global prefix is not writable", async () => {
		vi.mocked(readHost).mockResolvedValue(linux);
		vi.mocked(runStep)
			.mockResolvedValueOnce({ ok: false, output: "npm ERR! code EACCES" })
			.mockResolvedValueOnce({ ok: true, output: "" });
		await installRea(async () => ready);
		expect(vi.mocked(runStep).mock.calls[1][0].args).toEqual([
			"install",
			"-g",
			"--prefix",
			"/home/me/.local",
			"--ignore-scripts",
			REA_SPEC,
		]);
	});

	it("says when npm failed, or when the pinned release is still not what rea leads to", async () => {
		vi.mocked(readHost).mockResolvedValue(linux);
		vi.mocked(runStep).mockResolvedValueOnce({ ok: false, output: "network down" });
		await expect(installRea(async () => ready)).resolves.toMatchObject({
			success: false,
			error: "failed",
			detail: "network down",
		});
		vi.mocked(runStep).mockResolvedValueOnce({ ok: true, output: "done" });
		const other: ReaStatus = { state: "other_version", pinned: REA_PIN.version };
		await expect(installRea(async () => other)).resolves.toMatchObject({
			success: false,
			error: "not_on_path",
			status: other,
		});
	});

	it("runs one install at a time", async () => {
		busyCliTools.add("rea");
		await expect(installRea(async () => ready)).resolves.toEqual({
			success: false,
			error: "busy",
		});
	});
});

describe("registerReaHandlers", () => {
	it("registers both channels, which take no argument", () => {
		registerReaHandlers();
		const channels = vi.mocked(ipcMain.handle).mock.calls.map((call) => call[0]);
		expect(channels).toEqual([IPC_CHANNELS.REA_CHECK, IPC_CHANNELS.REA_INSTALL]);
	});
});
