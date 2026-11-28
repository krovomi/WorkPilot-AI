/**
 * The marketplace's sandbox channel (#369, lot 6): the renderer only chooses
 * whether to ask again; anything else it sends is refused before the backend
 * is asked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const status = vi.hoisted(() => ({
	mcpSandboxStatus: vi.fn(async () => ({
		available: false,
		kind: "missing",
		backend: "bubblewrap",
		reason: "bwrap missing",
	})),
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
}));
// What the real module would start a runner with: never reached here.
vi.mock("../../app-logger", () => ({ appLog: { debug: vi.fn() } }));
vi.mock("../../python-detector", () => ({ parsePythonCommand: vi.fn() }));
vi.mock("../../utils/ensure-python", () => ({ readyPythonPath: vi.fn() }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: vi.fn() }));
vi.mock("../../mcp-security/sandbox-status", async (original) => ({
	...(await original<typeof import("../../mcp-security/sandbox-status")>()),
	mcpSandboxStatus: status.mcpSandboxStatus,
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerMcpSandboxHandlers } from "../mcp-sandbox-handlers";

beforeAll(() => {
	registerMcpSandboxHandlers();
});

beforeEach(() => {
	status.mcpSandboxStatus.mockClear();
});

const call = (request: unknown) =>
	handlers.get(IPC_CHANNELS.MCP_MARKETPLACE_GET_SANDBOX)?.({}, request);

describe("MCP sandbox channel", () => {
	it.each([
		[undefined, false],
		[{}, false],
		[{ refresh: true }, true],
	])("answers the machine's status for %j", async (request, refresh) => {
		expect(await call(request)).toEqual({
			success: true,
			data: { available: false, kind: "missing", backend: "bubblewrap", reason: "bwrap missing" },
		});
		expect(status.mcpSandboxStatus).toHaveBeenCalledWith(refresh);
	});

	it.each([["refresh"], [[]], [{ refresh: "yes" }], [{ refresh: true, command: "bwrap" }]])(
		"refuses %j without asking",
		async (request) => {
			expect(await call(request)).toEqual({ success: false, error: "Invalid request" });
			expect(status.mcpSandboxStatus).not.toHaveBeenCalled();
		},
	);
});
