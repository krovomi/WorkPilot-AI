/**
 * @vitest-environment node
 *
 * The marketplace's security services in the running app: stores kept in the
 * app's data, a project's servers read by the main from its own file, and the
 * daily check started a little after start-up, then looked at every hour.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	userData: "",
	env: {} as Record<string, string>,
	projects: [] as { id: string; path: string }[],
	run: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));
vi.mock("../../app-logger", () => ({ appLog: { info: state.info, warn: state.warn } }));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProjects: () => state.projects,
		getProject: (id: string) => state.projects.find((p) => p.id === id),
	},
}));
vi.mock("../../project-env-file", () => ({ readProjectEnv: () => state.env }));
vi.mock("../../ipc-handlers/task/split-merge-watch", () => ({
	offlineStrict: (p: string) => p === "/air",
}));
vi.mock("../installed-watch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../installed-watch")>()),
	runInstalledWatch: (...args: unknown[]) => state.run(...args),
}));

import { loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import { InstalledWatchStore } from "../installed-watch";
import { readMcpPolicy } from "../policy-file";
import { RegistryFactsStore } from "../registry-facts";
import {
	installedWatchStore,
	installGuardDeps,
	marketplaceDataDir,
	projectMcpServers,
	securityStore,
	startMcpInstalledWatch,
	stopMcpInstalledWatch,
	watchDeps,
} from "../runtime";

state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-"));

beforeEach(() => {
	state.projects = [
		{ id: "p1", path: "/projects/p1" },
		{ id: "p2", path: "/air" },
	];
	state.env = { CUSTOM_MCP_SERVERS: JSON.stringify([{ id: "mine", type: "command" }]) };
	state.run.mockReset();
	state.info.mockReset();
	state.warn.mockReset();
});

afterEach(() => {
	stopMcpInstalledWatch();
	vi.useRealTimers();
});

afterAll(() => {
	fs.rmSync(state.userData, { recursive: true, force: true });
});

describe("stores", () => {
	it("keeps one store of each kind in the app's data", () => {
		const dir = marketplaceDataDir();
		expect(dir).toBe(path.join(state.userData, "mcp-marketplace"));
		expect(fs.existsSync(dir)).toBe(true);
		expect(marketplaceDataDir()).toBe(dir);
		expect(securityStore()).toBeInstanceOf(RegistryFactsStore);
		expect(securityStore()).toBe(securityStore());
		expect(installedWatchStore()).toBeInstanceOf(InstalledWatchStore);
		expect(installedWatchStore()).toBe(installedWatchStore());
	});
});

describe("projectMcpServers", () => {
	it("reads a registered project's servers, and nothing for another id", () => {
		expect(projectMcpServers("p1")).toEqual([{ id: "mine", type: "command" }]);
		expect(projectMcpServers("nope")).toEqual([]);
	});
});

describe("watchDeps", () => {
	it("looks at the registered projects through the main's own readers", () => {
		const d = watchDeps();
		expect(d.projects()).toEqual(state.projects);
		expect(d.installed({ id: "p1", path: "/projects/p1" })).toEqual([{ id: "mine", type: "command" }]);
		expect(d.offline("/air")).toBe(true);
		expect(d.catalog()).toBe(loadMcpCatalog());
		expect(d.facts).toBe(securityStore());
		expect(d.watch).toBe(installedWatchStore());
		d.warn?.("x");
		expect(state.warn).toHaveBeenCalledWith("x");
	});
});

describe("installGuardDeps", () => {
	it("reads the policy file and scores with the main's facts", async () => {
		const d = installGuardDeps();
		expect(d.readPolicy).toBe(readMcpPolicy);
		expect(d.catalog()).toBe(loadMcpCatalog());
		const github = loadMcpCatalog().find((s) => s.id === "github") as McpMarketplaceServer;
		expect(await d.score(github, "/projects/p1")).toBeGreaterThan(0);
	});
});

describe("startMcpInstalledWatch", () => {
	it("looks a little after start-up, then every hour, and logs what it found", async () => {
		vi.useFakeTimers();
		const deps = vi.fn(() => ({}) as never);
		state.run.mockResolvedValueOnce(2).mockResolvedValueOnce(0).mockResolvedValueOnce(null);
		startMcpInstalledWatch(deps);
		startMcpInstalledWatch(deps);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(state.run).toHaveBeenCalledTimes(1);
		expect(state.info).toHaveBeenCalledWith("[MCP watch] 2 new alert(s) on installed servers");
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(state.run).toHaveBeenCalledTimes(3);
		expect(state.info).toHaveBeenCalledTimes(1);
	});

	it("says a failed check in the log and tries again at the next look", async () => {
		vi.useFakeTimers();
		state.run.mockRejectedValueOnce(new Error("disk full")).mockRejectedValueOnce("odd");
		startMcpInstalledWatch(() => ({}) as never);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(state.warn).toHaveBeenNthCalledWith(1, "[MCP watch] The check failed: disk full");
		expect(state.warn).toHaveBeenNthCalledWith(2, "[MCP watch] The check failed: odd");
	});

	it("does not start a check while one is running", async () => {
		vi.useFakeTimers();
		let finish: (n: number) => void = () => {};
		state.run.mockImplementation(() => new Promise<number>((resolve) => (finish = resolve)));
		startMcpInstalledWatch(() => ({}) as never);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		await vi.advanceTimersByTimeAsync(60 * 60_000 - 2 * 60_000);
		expect(state.run).toHaveBeenCalledTimes(1);
		finish(0);
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(state.run).toHaveBeenCalledTimes(2);
		finish(0);
		await vi.advanceTimersByTimeAsync(0);
	});

	it("uses the app's own services by default, and stops", async () => {
		vi.useFakeTimers();
		state.run.mockResolvedValue(0);
		startMcpInstalledWatch();
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(state.run.mock.calls[0][0].watch).toBe(installedWatchStore());
		stopMcpInstalledWatch();
		stopMcpInstalledWatch();
		await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
		expect(state.run).toHaveBeenCalledTimes(1);
	});
});
