/**
 * @vitest-environment node
 *
 * The renderer only holds the mask of a custom MCP server's header values
 * (ENV_GET). A health check or a connection test it asks for uses the value
 * stored for that server in the project's `.env`, and only at the URL it was
 * stored for.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			state.handlers.set(channel, handler),
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === state.project.id ? state.project : undefined,
	},
}));

const STORED = {
	id: "docs",
	name: "Docs",
	type: "http",
	url: "https://mcp.example.com/mcp",
	headers: { Authorization: "Bearer tok_stored", "X-Team": "core" },
};

const MASKED = {
	...STORED,
	headers: { Authorization: `Bearer ${MASKED_SECRET}`, "X-Team": MASKED_SECRET },
};

describe("MCP health check and connection test with stored header values", () => {
	const fetchMock = vi.fn();

	beforeEach(async () => {
		state.handlers.clear();
		state.project.path = mkdtempSync(path.join(tmpdir(), "mcp-handlers-"));
		const dir = path.join(state.project.path, ".workpilot");
		mkdirSync(dir);
		writeFileSync(
			path.join(dir, ".env"),
			`CUSTOM_MCP_SERVERS=${JSON.stringify([STORED])}\n`,
		);
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { registerMcpHandlers } = await import("../mcp-handlers");
		registerMcpHandlers();
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = state.handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args);
	}

	function sentHeaders(): Record<string, string> {
		expect(fetchMock).toHaveBeenCalled();
		return fetchMock.mock.calls[0][1].headers;
	}

	it("checks the server with the stored values", async () => {
		const result = (await invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, MASKED, "p1")) as {
			success: boolean;
			data: { status: string };
		};

		expect(result.success).toBe(true);
		expect(result.data.status).toBe("healthy");
		expect(fetchMock.mock.calls[0][0]).toBe(STORED.url);
		expect(sentHeaders()).toMatchObject(STORED.headers);
	});

	it("tests the connection with the stored values", async () => {
		await invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, MASKED, "p1");

		expect(sentHeaders()).toMatchObject(STORED.headers);
	});

	it("sends a value typed in the dialog as typed", async () => {
		await invoke(
			IPC_CHANNELS.MCP_CHECK_HEALTH,
			{ ...MASKED, headers: { Authorization: "Bearer tok_typed" } },
			"p1",
		);

		expect(sentHeaders().Authorization).toBe("Bearer tok_typed");
	});

	it.each([
		["another URL", { ...MASKED, url: "https://elsewhere.example.com/mcp" }, "p1"],
		["another server", { ...MASKED, id: "other" }, "p1"],
		["no project", MASKED, undefined],
		["an unknown project", MASKED, "nope"],
	])("sends no stored value for %s", async (_label, server, projectId) => {
		await invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server, projectId);

		const headers = sentHeaders();
		expect(JSON.stringify(headers)).not.toContain("stored");
		expect(JSON.stringify(headers)).not.toContain(MASKED_SECRET);
		expect(headers.Authorization).toBeUndefined();
		expect(headers["X-Team"]).toBeUndefined();
	});

	it.each([null, "docs", ["docs"]])("refuses %j as a server", async (server) => {
		for (const channel of [
			IPC_CHANNELS.MCP_CHECK_HEALTH,
			IPC_CHANNELS.MCP_TEST_CONNECTION,
		]) {
			await expect(invoke(channel, server, "p1")).resolves.toEqual({
				success: false,
				error: "Invalid server",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
