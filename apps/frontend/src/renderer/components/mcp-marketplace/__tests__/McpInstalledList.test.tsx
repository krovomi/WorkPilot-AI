/** @vitest-environment jsdom */
/**
 * The project's MCP servers as its agents get them: catalog servers and ones
 * added by hand, how each runs, which agents use it, and removing one.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { McpInstalledList } from "../McpInstalledList";
import { entry, type MainApi, resetWorld } from "./mcp-world";

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

describe("McpInstalledList", () => {
	it("waits while the project's servers are read", () => {
		useMcpMarketplaceStore.setState({ isInstalledLoading: true, projectId: "p1" });
		render(<McpInstalledList />);
		expect(screen.getByRole("status", { name: "Loading..." })).toBeInTheDocument();
		expect(screen.queryByRole("heading")).toBeNull();
	});

	it("asks for a project when none is selected", () => {
		render(<McpInstalledList />);
		expect(
			screen.getByRole("heading", { name: "Select a project: servers are installed per project." }),
		).toBeInTheDocument();
		expect(screen.queryByText(/^Install one from the catalog/)).toBeNull();
	});

	it("says the project has no server yet", () => {
		useMcpMarketplaceStore.setState({ projectId: "p1" });
		render(<McpInstalledList />);
		expect(screen.getByRole("heading", { name: "No MCP server in this project" })).toBeInTheDocument();
		expect(
			screen.getByText("Install one from the catalog, or add your own in Agent Tools."),
		).toBeInTheDocument();
	});

	it("lists catalog and hand-added servers, with the agents that use them", () => {
		useMcpMarketplaceStore.setState({
			projectId: "p1",
			catalog: [entry("notion")],
			installed: [
				{ id: "notion", name: "Notion", type: "command", command: "npx" },
				{ id: "mine", name: "Mine", type: "http", url: "https://mcp.example.test/mcp" },
			],
			agentOverrides: {
				coder: { add: ["notion"] },
				analyzer: { add: ["notion"] },
			},
		});
		render(<McpInstalledList />);
		expect(screen.getByRole("heading", { name: "Notion" })).toBeInTheDocument();
		expect(screen.getByText("npx")).toBeInTheDocument();
		expect(screen.getByText("Used by: Coder, Investigator")).toBeInTheDocument();
		expect(screen.getAllByText("Added by hand")).toHaveLength(1);
		expect(screen.getByRole("heading", { name: /Mine/ })).toBeInTheDocument();
		expect(screen.getByText("http")).toBeInTheDocument();
		expect(screen.getByText("No agent uses it yet: assign it in Agent Tools.")).toBeInTheDocument();
	});

	it("names an agent it has no text for as it is", () => {
		useMcpMarketplaceStore.setState({
			projectId: "p1",
			installed: [{ id: "x", name: "X", type: "command", command: "node" }],
			agentOverrides: { spec_writer: { add: ["x"] } },
		});
		render(<McpInstalledList />);
		expect(screen.getByText("Used by: spec_writer")).toBeInTheDocument();
	});

	it("removes a server from the project", async () => {
		const servers = [
			{ id: "notion", name: "Notion", type: "command" as const, command: "npx" },
			{ id: "keep", name: "Keep", type: "command" as const, command: "node" },
		];
		useMcpMarketplaceStore.setState({ projectId: "p1", installed: servers });
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: { customMcpServers: servers, agentMcpOverrides: { coder: { add: ["notion"] } } },
		});
		render(<McpInstalledList />);
		fireEvent.click(screen.getAllByRole("button", { name: "Uninstall" })[0]);
		await waitFor(() => expect(screen.queryByRole("heading", { name: "Notion" })).toBeNull());
		expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", {
			customMcpServers: [servers[1]],
			agentMcpOverrides: { coder: { add: [], remove: [] } },
		});
		expect(screen.getByRole("heading", { name: /Keep/ })).toBeInTheDocument();
	});
});
