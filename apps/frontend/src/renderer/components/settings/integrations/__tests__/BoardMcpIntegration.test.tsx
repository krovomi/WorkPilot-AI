/** @vitest-environment jsdom */
/**
 * "Use from other apps": each client's state, the one-click add, the snippet
 * for a client the app cannot write, and why it failed.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { BoardMcpClientStatus, BoardMcpStatus } from "../../../../../shared/types";
import { BoardMcpIntegration } from "../BoardMcpIntegration";

const client = (overrides: Partial<BoardMcpClientStatus>): BoardMcpClientStatus => ({
	id: "cursor",
	detected: true,
	state: "absent",
	location: "~/.cursor/mcp.json",
	writable: true,
	snippet: '{"mcpServers":{}}',
	...overrides,
});

const status: BoardMcpStatus = {
	serverName: "workpilot-demo",
	command: "python3",
	args: ["-I"],
	clients: [
		client({}),
		client({ id: "codex", state: "current", location: "~/.codex/config.toml" }),
		client({ id: "windsurf", detected: false, writable: false, snippet: "WINDSURF-SNIPPET" }),
	],
};

const api = { getBoardMcpStatus: vi.fn(), applyBoardMcp: vi.fn() };

beforeEach(() => {
	api.getBoardMcpStatus.mockResolvedValue({ success: true, data: status });
	api.applyBoardMcp.mockResolvedValue({ success: true, data: client({ state: "current" }) });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("BoardMcpIntegration", () => {
	it("adds the server to a client in one click", async () => {
		render(<BoardMcpIntegration projectId="p1" />);
		const row = await screen.findByTestId("board-mcp-cursor");
		fireEvent.click(within(row).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(api.applyBoardMcp).toHaveBeenCalledWith("p1", "cursor", true));
		expect(await within(row).findByText("Added")).toBeInTheDocument();
	});

	it("removes a current entry", async () => {
		render(<BoardMcpIntegration projectId="p1" />);
		const row = await screen.findByTestId("board-mcp-codex");
		expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
		fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
		await waitFor(() => expect(api.applyBoardMcp).toHaveBeenCalledWith("p1", "codex", false));
	});

	it("shows what to paste for a client it cannot write", async () => {
		render(<BoardMcpIntegration projectId="p1" />);
		const row = await screen.findByTestId("board-mcp-windsurf");
		expect(within(row).getByText("Not detected")).toBeInTheDocument();
		expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
		fireEvent.click(within(row).getByText("Show what to paste"));
		expect(within(row).getByText("WINDSURF-SNIPPET")).toBeInTheDocument();
	});

	it("says why a write failed", async () => {
		api.applyBoardMcp.mockResolvedValue({ success: false, error: "config_unreadable" });
		render(<BoardMcpIntegration projectId="p1" />);
		const row = await screen.findByTestId("board-mcp-cursor");
		fireEvent.click(within(row).getByRole("button", { name: "Add" }));
		expect(await within(row).findByText(/could not be read/)).toBeInTheDocument();
	});

	it("says when Python is not ready", async () => {
		api.getBoardMcpStatus.mockResolvedValue({ success: false, error: "python_not_ready" });
		render(<BoardMcpIntegration projectId="p1" />);
		expect(await screen.findByTestId("board-mcp-error")).toHaveTextContent(/Python/);
	});
});
