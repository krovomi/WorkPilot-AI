/** @vitest-environment jsdom */
/**
 * MCP access to the team server: the token is shown once with each app's
 * entry, listed afterwards by name and prefix only, and revoked from there.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { ServerAccessToken } from "../../../../shared/types/board-mcp";
import { ServerMcpSettings } from "../ServerMcpSettings";

const listed: ServerAccessToken = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Codex laptop",
	prefix: "wpat_abc123",
	scope: "write",
	createdAt: "2026-11-01T10:00:00Z",
	expiresAt: "2027-01-30T10:00:00Z",
	lastUsedAt: null,
};

const TOKEN = "wpat_SECRETsecretSECRETsecretSECRETsecret123";

const serverAuth = {
	listAccessTokens: vi.fn(),
	createAccessToken: vi.fn(),
	revokeAccessToken: vi.fn(),
};

beforeEach(() => {
	serverAuth.listAccessTokens.mockResolvedValue({ success: true, data: [listed] });
	serverAuth.createAccessToken.mockResolvedValue({
		success: true,
		data: {
			...listed,
			id: "22222222-2222-4222-8222-222222222222",
			name: "Gemini",
			scope: "read",
			token: TOKEN,
			mcpUrl: "https://team.example.com/mcp",
		},
	});
	serverAuth.revokeAccessToken.mockResolvedValue({ success: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAuth };
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ServerMcpSettings", () => {
	it("lists tokens by name and prefix, never the token", async () => {
		render(<ServerMcpSettings />);
		const row = await screen.findByTestId(`server-mcp-token-${listed.id}`);
		expect(within(row).getByText("Codex laptop")).toBeInTheDocument();
		expect(within(row).getByText("wpat_abc123…")).toBeInTheDocument();
		expect(within(row).getByText("Read and write")).toBeInTheDocument();
		expect(within(row).getByText(/never used/)).toBeInTheDocument();
	});

	it("creates a read token for 90 days and shows it once with each app's entry", async () => {
		render(<ServerMcpSettings />);
		const create = screen.getByRole("button", { name: "Create a token" });
		expect(create).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Token name"), { target: { value: " Gemini " } });
		fireEvent.click(create);
		await waitFor(() =>
			expect(serverAuth.createAccessToken).toHaveBeenCalledWith("Gemini", "read", 90),
		);
		const panel = await screen.findByTestId("server-mcp-created");
		expect(within(panel).getByText(TOKEN)).toBeInTheDocument();
		const snippet = within(panel).getByTestId("server-mcp-snippet");
		expect(snippet.textContent).toContain("claude mcp add --transport http");

		fireEvent.click(within(panel).getByRole("tab", { name: "Gemini CLI" }));
		const gemini = JSON.parse(within(panel).getByTestId("server-mcp-snippet").textContent ?? "");
		expect(gemini.mcpServers["workpilot-server"]).toEqual({
			httpUrl: "https://team.example.com/mcp",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});

		fireEvent.click(within(panel).getByRole("button", { name: "Done, hide the token" }));
		expect(screen.queryByText(TOKEN)).toBeNull();
	});

	it("revokes a token from the list", async () => {
		render(<ServerMcpSettings />);
		await screen.findByTestId(`server-mcp-token-${listed.id}`);
		serverAuth.listAccessTokens.mockResolvedValue({ success: true, data: [] });
		fireEvent.click(screen.getByRole("button", { name: "Revoke Codex laptop" }));
		await waitFor(() => expect(serverAuth.revokeAccessToken).toHaveBeenCalledWith(listed.id));
		expect(await screen.findByText("No access token yet.")).toBeInTheDocument();
	});

	it("says why the server refused", async () => {
		serverAuth.createAccessToken.mockResolvedValue({
			success: false,
			error: "Missing permission: task.read",
		});
		render(<ServerMcpSettings />);
		fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: "Create a token" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Missing permission: task.read");
		expect(screen.queryByTestId("server-mcp-created")).toBeNull();
	});
});
