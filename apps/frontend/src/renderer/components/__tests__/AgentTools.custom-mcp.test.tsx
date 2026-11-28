/**
 * A custom MCP server of the project is checked and tested by the main
 * process for that project: the renderer names the project, the main reads
 * the server's stored values.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomMcpServer } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { AgentTools } from "../AgentTools";

const SERVER: CustomMcpServer = {
	id: "docs",
	name: "Docs server",
	type: "http",
	url: "https://mcp.example.test/sse",
} as CustomMcpServer;

// One object for every render, as the hook's state is.
const config = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks")>()),
	useProjectEnvConfig: () => config.value,
}));

const checkMcpHealth = vi.fn();
const testMcpConnection = vi.fn();

config.value = {
	envConfig: { mcpServers: {}, customMcpServers: [SERVER], agentMcpOverrides: {} },
	setEnvConfig: () => undefined,
};

describe("AgentTools custom MCP servers", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		checkMcpHealth.mockResolvedValue({
			success: true,
			data: { serverId: "docs", status: "healthy", checkedAt: "2026-11-15T00:00:00Z" },
		});
		testMcpConnection.mockResolvedValue({
			success: true,
			data: { serverId: "docs", success: true, message: "Connected" },
		});
		Object.assign(globalThis.electronAPI, {
			checkMcpHealth,
			testMcpConnection,
			getMcpPins: vi.fn().mockResolvedValue({ success: true, data: [] }),
		});
		useProjectStore.setState({
			projects: [{ id: "p1", name: "app", path: "/work/app" }] as never,
			selectedProjectId: "p1",
		});
	});

	it("checks and tests a custom server for the selected project", async () => {
		render(<AgentTools />);

		await waitFor(() => expect(checkMcpHealth).toHaveBeenCalledWith(SERVER, "p1"));

		const card = (await screen.findByText("Docs server")).closest("div.rounded-lg, div[class*='border']");
		const scope = card instanceof HTMLElement ? within(card.parentElement ?? card) : screen;
		await userEvent.click(scope.getAllByRole("button", { name: /Test/ })[0]);

		await waitFor(() => expect(testMcpConnection).toHaveBeenCalledWith(SERVER, "p1"));
		expect(await screen.findByText("Connected")).toBeInTheDocument();
	});

	it("says a confined server is not tested here (#369 lot 5)", async () => {
		testMcpConnection.mockResolvedValue({
			success: true,
			data: { serverId: "docs", success: false, confined: true, message: "English from main" },
		});
		render(<AgentTools />);
		await screen.findByText("Docs server");
		await userEvent.click(screen.getAllByRole("button", { name: /Test/ })[0]);
		expect(
			await screen.findByText(
				"Not tested: this server runs confined, and only an agent starts it, in the OS sandbox.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("English from main")).toBeNull();
	});

	it("says a test that got no answer failed", async () => {
		testMcpConnection.mockResolvedValue({ success: false, error: "ipc refused" });
		render(<AgentTools />);
		await screen.findByText("Docs server");
		await userEvent.click(screen.getAllByRole("button", { name: /Test/ })[0]);
		expect(await screen.findByText("Connection test failed")).toBeInTheDocument();
	});

	it("marks a server whose check fails as unknown", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		checkMcpHealth.mockRejectedValue(new Error("ipc down"));
		render(<AgentTools />);

		await waitFor(() => expect(checkMcpHealth).toHaveBeenCalled());
		expect(await screen.findByText("Health check failed")).toBeInTheDocument();
	});

	it("checks without a project when none is selected", async () => {
		useProjectStore.setState({ selectedProjectId: null });
		render(<AgentTools />);
		await waitFor(() => expect(checkMcpHealth).toHaveBeenCalledWith(SERVER, undefined));
		await screen.findByText("Docs server");
		await userEvent.click(screen.getAllByRole("button", { name: /Test/ })[0]);
		await waitFor(() => expect(testMcpConnection).toHaveBeenCalledWith(SERVER, undefined));
	});
});
