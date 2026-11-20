/** @vitest-environment jsdom */
/**
 * The MCP Marketplace page: the catalog it loads, searched, sorted and
 * filtered; the selected project's installed servers; the builder; and what
 * could not be done.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { McpMarketplace } from "../McpMarketplace";
import { CATALOG, entry, type MainApi, resetWorld, selectProject } from "./mcp-world";

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
	api.invoke.mockImplementation(async (channel: string) =>
		channel === "mcpMarketplace:getCatalog"
			? { success: true, data: [entry("notion"), entry("github"), entry("time")] }
			: { success: true, data: [] },
	);
});

afterEach(cleanup);

function cardNames(): string[] {
	return screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
}

describe("McpMarketplace", () => {
	it("loads the catalog and the project's servers, and lists the catalog", async () => {
		selectProject("p1");
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: { customMcpServers: [{ id: "time", name: "Time", type: "command", command: "uvx" }] },
		});
		render(<McpMarketplace />);
		expect(screen.getByRole("heading", { name: "MCP Marketplace" })).toBeInTheDocument();
		await waitFor(() => expect(cardNames()).toEqual(["Notion", "GitHub", "Time"]));
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getCatalog");
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getBuilderProjects");
		expect(api.getProjectEnv).toHaveBeenCalledWith("p1");
		await waitFor(() => expect(screen.getByText("1 installed")).toBeInTheDocument());
		expect(within(screen.getByRole("tab", { name: /Installed/ })).getByText("1")).toBeInTheDocument();
		expect(screen.queryByText("Select a project: servers are installed per project.")).toBeNull();
	});

	it("searches, sorts and filters the catalog", async () => {
		selectProject("p1");
		render(<McpMarketplace />);
		await waitFor(() => expect(cardNames()).toEqual(["Notion", "GitHub", "Time"]));

		fireEvent.click(screen.getByRole("button", { name: "Name A-Z" }));
		expect(screen.getByRole("button", { name: "Name A-Z" })).toHaveAttribute("aria-pressed", "true");
		expect(cardNames()).toEqual(["GitHub", "Notion", "Time"]);
		fireEvent.click(screen.getByRole("button", { name: "Featured" }));
		expect(cardNames()).toEqual(["Notion", "GitHub", "Time"]);

		fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
		expect(cardNames()).toEqual(["Notion"]);
		fireEvent.click(screen.getByRole("button", { name: "All Categories" }));

		fireEvent.change(screen.getByRole("searchbox", { name: "Search MCP servers..." }), {
			target: { value: "zzz-nothing" },
		});
		expect(screen.getByText("No servers found")).toBeInTheDocument();
		expect(screen.getByText("Try adjusting your search or filters.")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("searchbox", { name: "Search MCP servers..." }), {
			target: { value: "git" },
		});
		expect(cardNames()).toEqual(["GitHub"]);
		fireEvent.change(screen.getByRole("searchbox", { name: "Search MCP servers..." }), {
			target: { value: "" },
		});

		const official = screen.getByRole("button", { name: "Official" });
		fireEvent.click(official);
		expect(official).toHaveAttribute("aria-pressed", "true");
		expect(cardNames()).toEqual(
			[entry("notion"), entry("github"), entry("time")].filter((s) => s.official).map((s) => s.name),
		);
		fireEvent.click(official);
		expect(cardNames()).toHaveLength(3);
	});

	it("filters every category the catalog uses", async () => {
		api.invoke.mockImplementation(async (channel: string) =>
			channel === "mcpMarketplace:getCatalog" ? { success: true, data: CATALOG } : { success: true, data: [] },
		);
		render(<McpMarketplace />);
		await waitFor(() => expect(cardNames()).toHaveLength(CATALOG.length));
		for (const category of new Set(CATALOG.map((s) => s.category))) {
			act(() => useMcpMarketplaceStore.getState().setFilters({ category: "all" }));
			const label = i18n.t(`mcpMarketplace.categories.${category.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}`);
			fireEvent.click(screen.getByRole("button", { name: label }));
			expect(cardNames()).toEqual(CATALOG.filter((s) => s.category === category).map((s) => s.name));
		}
	});

	it("says a project is needed to install", async () => {
		render(<McpMarketplace />);
		expect(
			await screen.findByText("Select a project: servers are installed per project."),
		).toBeInTheDocument();
		expect(api.getProjectEnv).not.toHaveBeenCalled();
	});

	it("shows the catalog loading", () => {
		api.invoke.mockReturnValue(new Promise(() => undefined));
		render(<McpMarketplace />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("says the catalog could not be loaded", async () => {
		api.invoke.mockImplementation(async (channel: string) =>
			channel === "mcpMarketplace:getCatalog"
				? { success: false, error: "catalog file missing" }
				: { success: true, data: [] },
		);
		render(<McpMarketplace />);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The catalog could not be loaded.");
		expect(alert).toHaveTextContent("catalog file missing");
	});

	it("reads the servers of the project the person turns to", async () => {
		selectProject("p1");
		render(<McpMarketplace />);
		await waitFor(() => expect(api.getProjectEnv).toHaveBeenCalledWith("p1"));
		selectProject("p2");
		await waitFor(() => expect(api.getProjectEnv).toHaveBeenCalledWith("p2"));
		await waitFor(() => expect(useMcpMarketplaceStore.getState().projectId).toBe("p2"));
	});

	it("reloads everything on Refresh", async () => {
		selectProject("p1");
		render(<McpMarketplace />);
		await waitFor(() => expect(cardNames()).toHaveLength(3));
		api.invoke.mockClear();
		api.getProjectEnv.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(api.getProjectEnv).toHaveBeenCalledWith("p1"));
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getCatalog");
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getBuilderProjects");
	});

	it("opens the installed servers and the builder", async () => {
		selectProject("p1");
		render(<McpMarketplace />);
		await waitFor(() => expect(cardNames()).toHaveLength(3));

		fireEvent.click(screen.getByRole("tab", { name: /Installed/ }));
		expect(screen.getByRole("tab", { name: /Installed/ })).toHaveAttribute("aria-selected", "true");
		expect(
			await screen.findByRole("heading", { name: "No MCP server in this project" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "Builder" }));
		expect(screen.getByRole("heading", { name: "MCP Server Builder" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Catalog" }));
		expect(screen.getByRole("searchbox", { name: "Search MCP servers..." })).toBeInTheDocument();
	});

	it("says when the builder's servers could not be loaded", async () => {
		api.invoke.mockImplementation(async (channel: string) =>
			channel === "mcpMarketplace:getCatalog"
				? { success: true, data: CATALOG }
				: { success: false, error: "builder file unreadable" },
		);
		render(<McpMarketplace />);
		act(() => useMcpMarketplaceStore.getState().setActiveTab("builder"));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Your builder servers could not be loaded.");
		expect(alert).toHaveTextContent("builder file unreadable");
	});
});
