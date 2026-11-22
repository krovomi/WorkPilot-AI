/**
 * @vitest-environment node
 *
 * ENV_UPDATE applies the project's MCP install policy (#369, lot 2): a custom
 * MCP server added or changed against `.workpilot/mcp-policy.json` is refused
 * with its reason and nothing is written, whatever the renderer showed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedFakeSafeStorage } from "../../../__tests__/helpers/fake-safe-storage";
import { IPC_CHANNELS } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
	globalSettings: {} as Record<string, unknown>,
	backendFetch: vi.fn(),
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) =>
				state.handlers.set(channel, handler),
		},
	};
});

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === state.project.id ? state.project : undefined,
		updateAutoBuildPath: vi.fn(),
	},
}));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => state.globalSettings,
}));

vi.mock("../_backend-fetch", () => ({ backendFetch: state.backendFetch }));

vi.mock("../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

const fake = sharedFakeSafeStorage();

const GIT = { id: "git", name: "Git", type: "command", command: "uvx", args: ["mcp-server-git"] };
const MINE = { id: "mine", name: "Mine", type: "command", command: "node", args: ["server.js"] };

describe("ENV_UPDATE and the MCP install policy", () => {
	beforeEach(async () => {
		fake.reset();
		state.handlers.clear();
		state.project.path = mkdtempSync(path.join(tmpdir(), "env-mcp-policy-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { registerEnvHandlers } = await import("../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	const update = (config: Record<string, unknown>) =>
		state.handlers.get(IPC_CHANNELS.ENV_UPDATE)?.({}, "p1", config);
	const envPath = () => path.join(state.project.path, ".workpilot", ".env");
	const policy = (value: unknown) => {
		mkdirSync(path.join(state.project.path, ".workpilot"), { recursive: true });
		writeFileSync(
			path.join(state.project.path, ".workpilot", "mcp-policy.json"),
			typeof value === "string" ? value : JSON.stringify(value),
		);
	};

	it("installs freely without a policy", async () => {
		await expect(update({ customMcpServers: [MINE] })).resolves.toEqual({ success: true });
		expect(readFileSync(envPath(), "utf-8")).toContain('"id":"mine"');
	});

	it("refuses a server outside the catalog, says why, and writes nothing", async () => {
		policy({ blockCustomServers: true });
		await expect(update({ customMcpServers: [MINE] })).resolves.toEqual({
			success: false,
			error: "The project's MCP policy refuses servers outside the catalog (Mine)",
			data: { mcpPolicyRefusal: { reason: "customBlocked", serverId: "mine", name: "Mine" } },
		});
		expect(existsSync(envPath())).toBe(false);
	});

	it("refuses a catalog server the list leaves out, and lets an allowed one in", async () => {
		policy({ allowedServers: ["gitlab"] });
		const refused = (await update({ customMcpServers: [GIT] })) as { data: unknown };
		expect(refused.data).toEqual({
			mcpPolicyRefusal: { reason: "notAllowed", serverId: "git", name: "Git" },
		});
		policy({ allowedServers: ["git"] });
		await expect(update({ customMcpServers: [GIT] })).resolves.toEqual({ success: true });
	});

	it("keeps a server already there under a policy written after it, and lets it be removed", async () => {
		await update({ customMcpServers: [MINE] });
		policy("{ not json");
		await expect(update({ customMcpServers: [MINE], githubRepo: "o/r" })).resolves.toEqual({
			success: true,
		});
		await expect(update({ customMcpServers: [MINE, GIT] })).resolves.toMatchObject({
			success: false,
			data: { mcpPolicyRefusal: { reason: "policyInvalid", serverId: "git" } },
		});
		await expect(update({ customMcpServers: [] })).resolves.toEqual({ success: true });
		expect(readFileSync(envPath(), "utf-8")).not.toContain('"id":"mine"');
	});

	it("writes a server outside the catalog confined under confineBelow (#369 lot 5)", async () => {
		policy({ confineBelow: 50 });
		const REMOTE = { id: "remote", name: "Remote", type: "http", url: "https://mcp.example.com/mcp" };
		const OWN = { ...MINE, id: "own", confine: { hosts: ["api.example.com"] } };
		await expect(update({ customMcpServers: [MINE, OWN, REMOTE] })).resolves.toEqual({
			success: true,
		});
		const line = readFileSync(envPath(), "utf-8")
			.split("\n")
			.find((l) => l.startsWith("CUSTOM_MCP_SERVERS="));
		expect(JSON.parse(line?.slice("CUSTOM_MCP_SERVERS=".length) ?? "[]")).toEqual([
			{ ...MINE, confine: { hosts: [] } },
			OWN,
			REMOTE,
		]);
	});

	it("checks nothing for an update without servers", async () => {
		policy("{ not json");
		await expect(update({ githubRepo: "o/r" })).resolves.toEqual({ success: true });
	});
});
