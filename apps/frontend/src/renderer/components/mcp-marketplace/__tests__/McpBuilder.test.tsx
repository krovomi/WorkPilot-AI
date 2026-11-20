/** @vitest-environment jsdom */
/**
 * The no-code builder: a server's settings, its tools with their action and
 * parameters, saved to and deleted from the builder's list.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBuilderProject } from "../../../../shared/types/mcp-marketplace";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { McpBuilder } from "../McpBuilder";
import { McpErrorNotice } from "../McpErrorNotice";
import { type MainApi, resetWorld } from "./mcp-world";

let api: MainApi;

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

function project(overrides: Partial<McpBuilderProject> = {}): McpBuilderProject {
	return {
		id: "b1",
		name: "Weather",
		description: "Forecasts",
		icon: "Wrench",
		color: "#112233",
		envVars: [],
		tools: [],
		createdAt: "2026-11-01T10:00:00.000Z",
		updatedAt: "2026-11-01T10:00:00.000Z",
		...overrides,
	};
}

function view() {
	return render(
		<>
			<McpErrorNotice />
			<McpBuilder />
		</>,
	);
}

async function pick(trigger: HTMLElement, option: string) {
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: option }));
}

function savedProject(): McpBuilderProject {
	const call = api.invoke.mock.calls.find(([channel]) => channel === "mcpMarketplace:saveBuilder");
	return call?.[1] as McpBuilderProject;
}

describe("McpBuilder", () => {
	it("waits while the builder's servers are read", () => {
		useMcpMarketplaceStore.setState({ isBuilderLoading: true });
		view();
		expect(screen.getByRole("status", { name: "Loading..." })).toBeInTheDocument();
	});

	it("welcomes the person when there is no server yet", () => {
		view();
		expect(screen.getByRole("heading", { name: "MCP Server Builder" })).toBeInTheDocument();
		expect(screen.getByText("Create a custom MCP server without code.")).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: "New Server" })[1]);
		expect(screen.getByRole("heading", { name: "Untitled Server" })).toBeInTheDocument();
		expect(screen.queryByText("Create a custom MCP server without code.")).toBeNull();
		expect(screen.getByText("No tools yet. Click + to add one.")).toBeInTheDocument();
		expect(screen.getByText("Select a tool to edit its configuration.")).toBeInTheDocument();
	});

	it("edits a new server's settings and saves it to the list", async () => {
		api.invoke.mockResolvedValue({ success: true });
		view();
		fireEvent.click(screen.getAllByRole("button", { name: "New Server" })[0]);
		fireEvent.change(screen.getByLabelText("Server Name"), { target: { value: "Weather" } });
		fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Forecasts" } });
		fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.weather.test" } });
		fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#abcdef" } });
		expect(screen.getByLabelText("Color code")).toHaveValue("#abcdef");
		fireEvent.change(screen.getByLabelText("Color code"), { target: { value: "#123456" } });
		expect(screen.getByRole("heading", { name: "Weather" })).toBeInTheDocument();
		expect(screen.getByText("0 Tools")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		const item = await screen.findByRole("button", { name: "Weather" });
		expect(item).toHaveAttribute("aria-current", "true");
		const saved = savedProject();
		expect(saved).toMatchObject({
			name: "Weather",
			description: "Forecasts",
			baseUrl: "https://api.weather.test",
			color: "#123456",
		});
		expect(saved.updatedAt >= saved.createdAt).toBe(true);
		expect(useMcpMarketplaceStore.getState().builderProjects).toEqual([saved]);
	});

	it("says when the server could not be saved", async () => {
		api.invoke.mockResolvedValue({ success: false, error: "disk full" });
		view();
		fireEvent.click(screen.getAllByRole("button", { name: "New Server" })[0]);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The server could not be saved.");
		expect(alert).toHaveTextContent("disk full");
		expect(screen.getByRole("heading", { name: "Untitled Server" })).toBeInTheDocument();
	});

	it("opens a saved server, and lists a nameless one as untitled", () => {
		useMcpMarketplaceStore.setState({
			builderProjects: [project(), project({ id: "b2", name: "" })],
		});
		view();
		const nameless = screen.getByRole("button", { name: "Untitled Server" });
		expect(nameless).not.toHaveAttribute("aria-current");
		fireEvent.click(screen.getByRole("button", { name: /Weather$/ }));
		expect(screen.getByLabelText("Server Name")).toHaveValue("Weather");
		expect(screen.getByLabelText("Base URL")).toHaveValue("");
		fireEvent.click(nameless);
		expect(screen.getByLabelText("Server Name")).toHaveValue("");
		expect(screen.getByRole("heading", { name: "Untitled Server" })).toBeInTheDocument();
	});

	it("deletes a server, or says why it could not", async () => {
		useMcpMarketplaceStore.setState({ builderProjects: [project()] });
		api.invoke.mockResolvedValueOnce({ success: false, error: "locked" });
		view();
		fireEvent.click(screen.getByRole("button", { name: /Weather$/ }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be deleted.");
		expect(screen.getByLabelText("Server Name")).toHaveValue("Weather");

		api.invoke.mockResolvedValueOnce({ success: true });
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(await screen.findByRole("heading", { name: "MCP Server Builder" })).toBeInTheDocument();
		expect(api.invoke).toHaveBeenLastCalledWith("mcpMarketplace:deleteBuilder", { projectId: "b1" });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: /Weather$/ })).toBeNull();
	});

	it("adds a tool with an HTTP action and edits it", async () => {
		api.invoke.mockResolvedValue({ success: true });
		view();
		fireEvent.click(screen.getAllByRole("button", { name: "New Server" })[0]);
		fireEvent.click(screen.getByRole("button", { name: "Add a tool" }));
		expect(screen.getByRole("heading", { name: "Edit Tool" })).toBeInTheDocument();
		const toolItem = screen.getByRole("button", { name: /Untitled Tool/ });
		expect(toolItem).toHaveAttribute("aria-current", "true");
		expect(within(toolItem).getByText("HTTP Request")).toBeInTheDocument();
		expect(screen.getByText("1 Tools")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Tool Name"), { target: { value: "get_forecast" } });
		const [serverDescription, toolDescription] = screen.getAllByLabelText("Description");
		expect(serverDescription.tagName).toBe("TEXTAREA");
		fireEvent.change(toolDescription, { target: { value: "Forecast of a city" } });
		await pick(screen.getByRole("combobox", { name: "HTTP method" }), "POST");
		fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/forecast" } });
		fireEvent.change(screen.getByLabelText("Body Template"), { target: { value: '{"city": "{{city}}"}' } });
		expect(screen.getByRole("button", { name: /get_forecast/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(savedProject()).toBeDefined());
		expect(savedProject().tools).toEqual([
			expect.objectContaining({
				name: "get_forecast",
				description: "Forecast of a city",
				action: {
					type: "http_request",
					http: { method: "POST", url: "/forecast", bodyTemplate: '{"city": "{{city}}"}' },
				},
			}),
		]);
	});

	it("switches a tool to a transform, and back to HTTP when it had none", async () => {
		useMcpMarketplaceStore.setState({
			builderProjects: [
				project({
					tools: [
						{
							id: "t1",
							name: "shape",
							description: "",
							parameters: [],
							action: { type: "transform" },
						},
						{
							id: "t2",
							name: "steps",
							description: "",
							parameters: [],
							action: { type: "chain", chain: { steps: ["t1"] } },
						},
					],
				}),
			],
		});
		view();
		fireEvent.click(screen.getByRole("button", { name: /Weather$/ }));
		expect(within(screen.getByRole("button", { name: /steps/ })).getByText("Chain")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /shape/ }));
		const template = screen.getByRole("textbox", { name: "Transform Template" });
		expect(template).toHaveValue("");
		fireEvent.change(template, { target: { value: "{{input}}" } });
		expect(template).toHaveValue("{{input}}");
		expect(within(screen.getByRole("button", { name: /shape/ })).getByText("Transform")).toBeInTheDocument();

		await pick(screen.getByRole("combobox", { name: "Action Type" }), "HTTP Request");
		expect(screen.queryByRole("textbox", { name: "Transform Template" })).toBeNull();
		expect(screen.getByRole("combobox", { name: "HTTP method" })).toHaveTextContent("GET");
		expect(screen.getByLabelText("Path")).toHaveValue("");
		expect(screen.getByLabelText("Body Template")).toHaveValue("");
		fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/shape" } });
		expect(screen.getByLabelText("Path")).toHaveValue("/shape");

		await pick(screen.getByRole("combobox", { name: "Action Type" }), "Transform");
		expect(screen.getByRole("textbox", { name: "Transform Template" })).toHaveValue("{{input}}");
	});

	it("removes the tool being edited", () => {
		useMcpMarketplaceStore.setState({
			builderProjects: [
				project({
					tools: [
						{
							id: "t1",
							name: "shape",
							description: "",
							parameters: [],
							action: { type: "http_request", http: { method: "GET", url: "/x" } },
						},
					],
				}),
			],
		});
		view();
		fireEvent.click(screen.getByRole("button", { name: /Weather$/ }));
		fireEvent.click(screen.getByRole("button", { name: /shape/ }));
		fireEvent.click(screen.getByRole("button", { name: "Remove Tool" }));
		expect(screen.queryByRole("button", { name: /shape/ })).toBeNull();
		expect(screen.getByText("No tools yet. Click + to add one.")).toBeInTheDocument();
		expect(screen.getByText("Select a tool to edit its configuration.")).toBeInTheDocument();
	});

	it("adds, edits and removes a tool's parameters", async () => {
		api.invoke.mockResolvedValue({ success: true });
		view();
		fireEvent.click(screen.getAllByRole("button", { name: "New Server" })[0]);
		fireEvent.click(screen.getByRole("button", { name: "Add a tool" }));
		expect(screen.getByText("No parameters defined.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));
		fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));
		const names = screen.getAllByRole("textbox", { name: "Parameter name" });
		expect(names).toHaveLength(2);

		// Typing a name keeps the same field: its row is not rebuilt.
		names[0].focus();
		fireEvent.change(names[0], { target: { value: "c" } });
		fireEvent.change(names[0], { target: { value: "city" } });
		expect(screen.getAllByRole("textbox", { name: "Parameter name" })[0]).toBe(names[0]);
		expect(document.activeElement).toBe(names[0]);

		fireEvent.change(screen.getAllByRole("textbox", { name: "Parameter description" })[0], {
			target: { value: "City name" },
		});
		const types = screen.getAllByRole("combobox", { name: "Parameter type" });
		expect(types[0]).toHaveTextContent("Text");
		await pick(types[1], "Number");
		expect(screen.getAllByRole("combobox", { name: "Parameter type" })[1]).toHaveTextContent("Number");
		fireEvent.change(names[1], { target: { value: "days" } });

		fireEvent.click(screen.getAllByRole("button", { name: "Remove the parameter" })[0]);
		expect(screen.getAllByRole("textbox", { name: "Parameter name" }).map((i) => (i as HTMLInputElement).value)).toEqual([
			"days",
		]);
		expect(screen.getByRole("textbox", { name: "Parameter name" })).toBe(names[1]);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(savedProject()).toBeDefined());
		expect(savedProject().tools[0].parameters).toEqual([
			{ name: "days", type: "number", description: "", required: true },
		]);
	});
});
