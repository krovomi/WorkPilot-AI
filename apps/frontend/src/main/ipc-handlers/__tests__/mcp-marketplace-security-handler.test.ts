/**
 * The marketplace's security channel (#369): the renderer names a catalog
 * server, the main scores it; a bad request is refused with its reason, any
 * other failure with a fixed message.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-security-handler-"));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const serverSecurity = vi.fn();
const getProject = vi.fn((_id: string) => ({ path: "/projects/p1" }) as { path: string } | undefined);

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => userData) },
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProject: (id: string) => getProject(id) },
}));

vi.mock("../../mcp-security/server-security", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../mcp-security/server-security")>();
	return { ...real, serverSecurity: (...args: unknown[]) => serverSecurity(...args) };
});

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { RegistryFactsStore } from "../../mcp-security/registry-facts";
import { McpSecurityRequestError } from "../../mcp-security/server-security";
import { registerMcpMarketplaceHandlers } from "../mcp-marketplace-handlers";
import { offlineStrict } from "../task/split-merge-watch";

const call = (request: unknown) =>
	handlers.get(IPC_CHANNELS.MCP_MARKETPLACE_GET_SECURITY)?.({}, request) as Promise<{
		success: boolean;
		data?: unknown;
		error?: string;
	}>;

beforeAll(() => {
	registerMcpMarketplaceHandlers();
});

beforeEach(() => {
	serverSecurity.mockReset();
});

afterAll(() => {
	fs.rmSync(userData, { recursive: true, force: true });
});

describe("mcpMarketplace:getSecurity", () => {
	it("returns the score, with the store kept in the app's data", async () => {
		serverSecurity.mockResolvedValue({ score: 80 });
		const result = await call({ serverId: "github" });
		expect(result).toEqual({ success: true, data: { score: 80 } });
		const [request, deps] = serverSecurity.mock.calls[0];
		expect(request).toEqual({ serverId: "github" });
		expect(deps.store).toBeInstanceOf(RegistryFactsStore);
		expect(deps.offline).toBe(offlineStrict);
		expect(deps.projectPath("p1")).toBe("/projects/p1");
		getProject.mockReturnValueOnce(undefined);
		expect(deps.projectPath("p2")).toBeUndefined();

		await call({ serverId: "github" });
		expect(serverSecurity.mock.calls[1][1].store).toBe(deps.store);
		expect(fs.existsSync(path.join(userData, "mcp-marketplace"))).toBe(true);
	});

	it("says why a request is refused", async () => {
		serverSecurity.mockRejectedValue(new McpSecurityRequestError("Unknown catalog server"));
		expect(await call({ serverId: "x" })).toEqual({
			success: false,
			error: "Unknown catalog server",
		});
	});

	it("hides the detail of any other failure", async () => {
		serverSecurity.mockRejectedValue(new Error("disk /secret/path"));
		expect(await call({ serverId: "x" })).toEqual({
			success: false,
			error: "Failed to score the server",
		});
	});
});
