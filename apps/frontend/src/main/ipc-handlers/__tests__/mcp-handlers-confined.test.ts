/**
 * @vitest-environment node
 *
 * A server that must run confined (#369 lot 5) is never started by the
 * connection test: the main has no OS sandbox. It counts as confined when it
 * says so, or when the project holds a confined server of that id, whatever
 * the renderer sent.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
	spawn: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
	},
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: state.spawn,
}));

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (id === state.project.id ? state.project : undefined),
	},
}));

const DOCS = { id: "docs", name: "Docs", type: "command", command: "npx", args: ["-y", "docs-mcp"] };
const STORED = { ...DOCS, confine: { hosts: ["docs.example.com"] } };

describe("the connection test of a confined MCP server", () => {
	beforeEach(async () => {
		state.handlers.clear();
		state.spawn.mockReset();
		state.spawn.mockImplementation(() => {
			throw new Error("spawned");
		});
		state.project.path = mkdtempSync(path.join(tmpdir(), "mcp-confined-"));
		mkdirSync(path.join(state.project.path, ".workpilot"));
		writeFileSync(
			path.join(state.project.path, ".workpilot", ".env"),
			`CUSTOM_MCP_SERVERS=${JSON.stringify([STORED])}\n`,
		);
		const { registerMcpHandlers } = await import("../mcp-handlers");
		registerMcpHandlers();
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
	});

	const test = (server: unknown, projectId?: unknown) =>
		state.handlers.get(IPC_CHANNELS.MCP_TEST_CONNECTION)?.({}, server, projectId);

	it("refuses one the project confines, even sent without its confine", async () => {
		await expect(test(DOCS, "p1")).resolves.toEqual({
			success: true,
			data: {
				serverId: "docs",
				success: false,
				confined: true,
				message: "This server runs confined: only an agent starts it, in the OS sandbox",
			},
		});
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it("refuses one sent confined, with or without a project", async () => {
		const result = (await test({ ...DOCS, id: "other", confine: { hosts: [] } })) as {
			data: { confined?: boolean };
		};
		expect(result.data.confined).toBe(true);
		expect(state.spawn).not.toHaveBeenCalled();
	});

	it("still tests a server nobody confines", async () => {
		const { mustRunConfined } = await import("../mcp-handlers");
		expect(mustRunConfined({ ...DOCS, id: "other" } as never, "p1")).toBe(false);
		expect(mustRunConfined(DOCS as never, "unknown")).toBe(false);
		expect(mustRunConfined(DOCS as never, undefined)).toBe(false);
		await test({ ...DOCS, id: "other" }, "p1");
		expect(state.spawn).toHaveBeenCalled();
	});
});
