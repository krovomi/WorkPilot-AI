/**
 * @vitest-environment node
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

const projects = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../project-store", () => ({
	projectStore: {
		getProjects: () => projects.paths.map((p) => ({ path: p })),
	},
}));

import {
	argsAllowed,
	DIRECTORY_ARGS,
	installIpcPathPolicy,
	PATH_REFUSED,
	resetIpcPathPolicyForTests,
} from "./ipc-path-policy";
import { forgetUserChosenPaths, rememberUserChosenPath } from "./renderer-path";

/** Parameter names that name a directory the handler acts in. */
const DIRECTORY_PARAM =
	/^(projectPath|projectDir|projectRoot|worktreePath|specDir|specDirPath|rootPath|dirPath)$/;

const MAIN = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : sources(full);
		}
		return entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)
			? [full]
			: [];
	});
}

function channelValue(expression: string): string | null {
	const constant = /^IPC_CHANNELS\.([A-Z0-9_]+)$/.exec(expression);
	if (constant) {
		return (IPC_CHANNELS as Record<string, string>)[constant[1]] ?? null;
	}
	const literal = /^["'`]([^"'`]+)["'`]$/.exec(expression);
	return literal ? literal[1] : null;
}

/** Every `ipcMain.handle/on(channel, (event, a, b) => …)` with its parameter names. */
function handlers(): { where: string; channel: string; params: string[] }[] {
	const found: { where: string; channel: string; params: string[] }[] = [];
	const pattern =
		/ipcMain\.(?:handle|on)\(\s*([^,]+?),\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/gs;
	for (const file of sources(MAIN)) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(pattern)) {
			const channel = channelValue(match[1].trim());
			if (!channel) continue;
			const params = match[2]
				.split(/,(?![^{<]*[}>])/)
				.map((param) => param.trim().split(/[?:\s=]/)[0])
				.filter(Boolean)
				.slice(1);
			const line = text.slice(0, match.index).split("\n").length;
			found.push({
				where: `${path.relative(MAIN, file)}:${line}`,
				channel,
				params,
			});
		}
	}
	return found;
}

describe("DIRECTORY_ARGS covers every directory parameter", () => {
	it("finds the handlers it reads", () => {
		expect(handlers().length).toBeGreaterThan(300);
	});

	it("lists each handler parameter named like a directory", () => {
		const missing = handlers().flatMap(({ where, channel, params }) =>
			params.flatMap((name, index) =>
				DIRECTORY_PARAM.test(name) &&
				!(DIRECTORY_ARGS[channel] ?? []).includes(index)
					? [`${where} ${channel} #${index} ${name}`]
					: [],
			),
		);
		expect(missing).toEqual([]);
	});

	it("lists no channel that has no handler", () => {
		const registered = new Set(handlers().map((h) => h.channel));
		expect(
			Object.keys(DIRECTORY_ARGS).filter((channel) => !registered.has(channel)),
		).toEqual([]);
	});
});

let base: string;
let project: string;
let outside: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "ipc-path-policy-")));
	project = path.join(base, "repo");
	outside = path.join(base, "outside");
	mkdirSync(path.join(project, ".workpilot", "specs", "001"), {
		recursive: true,
	});
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, path.join(project, "link"), "junction");
	projects.paths = [project];
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
	forgetUserChosenPaths();
});

describe("argsAllowed", () => {
	it("lets a registered project and its subfolders through", () => {
		expect(argsAllowed("git:getBranches", [project])).toBe(true);
		expect(
			argsAllowed("agentDecision:getLog", [
				path.join(project, ".workpilot", "specs", "001"),
			]),
		).toBe(true);
	});

	it("refuses a folder outside every project, through .. or a link", () => {
		for (const dir of [
			outside,
			path.join(project, ".."),
			path.join(project, "link"),
			"/",
			"relative/dir",
		]) {
			expect(argsAllowed("git:getBranches", [dir]), dir).toBe(false);
		}
	});

	it("accepts a folder the user picked in a dialog", () => {
		expect(argsAllowed("git:checkStatus", [outside])).toBe(false);
		rememberUserChosenPath(outside);
		expect(argsAllowed("git:checkStatus", [outside])).toBe(true);
	});

	it("checks the listed position only", () => {
		expect(
			argsAllowed("terminal:getSessionsForDate", ["2026-10-24", project]),
		).toBe(true);
		expect(
			argsAllowed("terminal:getSessionsForDate", ["2026-10-24", outside]),
		).toBe(false);
	});

	it("checks the project keys of an object argument on any channel", () => {
		expect(argsAllowed("any:channel", [{ projectPath: project }])).toBe(true);
		expect(argsAllowed("any:channel", [{ projectPath: outside }])).toBe(false);
		expect(argsAllowed("any:channel", [{ project_dir: outside }])).toBe(false);
		expect(argsAllowed("any:channel", [{ other: outside }])).toBe(true);
	});

	it("lets an absent optional argument through", () => {
		expect(argsAllowed("git:getBranches", [])).toBe(true);
		expect(argsAllowed("git:getBranches", [undefined])).toBe(true);
	});
});

describe("installIpcPathPolicy", () => {
	it("keeps the handler from running on a refused argument", async () => {
		resetIpcPathPolicyForTests();
		const registered = new Map<string, (...args: unknown[]) => unknown>();
		const ipc = {
			handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
				registered.set(channel, listener);
			},
			on: vi.fn(),
		};
		installIpcPathPolicy(ipc as never);
		const listener = vi.fn(() => ({ success: true }));
		ipc.handle("git:getBranches", listener);

		const call = registered.get("git:getBranches");
		expect(await call?.({}, outside)).toEqual({
			success: false,
			error: PATH_REFUSED,
		});
		expect(listener).not.toHaveBeenCalled();
		expect(await call?.({}, project)).toEqual({ success: true });
		expect(listener).toHaveBeenCalledWith({}, project);
	});
});
