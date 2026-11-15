/**
 * @vitest-environment jsdom
 */
/**
 * The MCP overview a person uses to pick the servers of a project and of each
 * agent: project switches, agents' server lists as the build resolves them,
 * adding and removing a server, custom servers and their health.
 */
import type { CustomMcpServer, Project, ProjectEnvConfig } from "@shared/types";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { AgentTools } from "../AgentTools";

type Props = Record<string, unknown>;
const { seen } = vi.hoisted(() => ({ seen: {} as Record<string, Props> }));

vi.mock("../settings/TokenSavingsSettings", () => ({
	TokenSavingsSettings: (props: Props) => {
		seen.tokenSavings = props;
		return null;
	},
}));
vi.mock("../settings/UiUxSettings", () => ({
	UiUxSettings: (props: Props) => {
		seen.uiux = props;
		return null;
	},
}));
vi.mock("../settings/McpPinsSection", () => ({ McpPinsSection: () => null }));
vi.mock("../McpServerSettingsDialog", () => ({
	McpServerSettingsDialog: (props: Props) => {
		seen.serverDialog = props;
		return null;
	},
}));
vi.mock("../CustomMcpDialog", () => ({
	CustomMcpDialog: (props: Props) => {
		seen.customDialog = props;
		return null;
	},
}));

const api = {
	getProjectEnv: vi.fn(),
	updateProjectEnv: vi.fn(),
	checkMcpHealth: vi.fn(),
	testMcpConnection: vi.fn(),
};

const PROJECT = {
	id: "p1",
	name: "Shop",
	path: "/work/shop",
	autoBuildPath: ".workpilot",
} as Project;

const DOCS: CustomMcpServer = {
	id: "docs",
	name: "Docs server",
	type: "command",
	command: "npx",
	args: ["docs-mcp"],
};
const WIKI: CustomMcpServer = {
	id: "wiki",
	name: "Wiki",
	type: "http",
	url: "https://wiki.example/mcp",
	description: "Team wiki pages",
};

function env(over: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig {
	return {
		linearEnabled: false,
		mcpServers: {},
		...over,
	} as ProjectEnvConfig;
}

async function show(config: ProjectEnvConfig | null, project: Project | null = PROJECT) {
	api.getProjectEnv.mockResolvedValue(
		config ? { success: true, data: config } : { success: false },
	);
	act(() =>
		useProjectStore.setState({
			projects: project ? [project] : [],
			selectedProjectId: project?.id ?? null,
		}),
	);
	render(<AgentTools />);
	if (config) await screen.findByText("MCP Server Configuration");
}

function card(label: RegExp) {
	return screen.getByRole("button", { name: label });
}

async function openCard(label: RegExp) {
	await userEvent.click(card(label));
	return card(label).parentElement as HTMLElement;
}

function lastSave() {
	return api.updateProjectEnv.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
	vi.resetAllMocks();
	for (const key of Object.keys(seen)) delete seen[key];
	Object.assign(globalThis.electronAPI, api);
	api.updateProjectEnv.mockResolvedValue({ success: true });
	api.checkMcpHealth.mockImplementation(async (server: CustomMcpServer) => ({
		success: true,
		data: { serverId: server.id, status: "unknown", checkedAt: "now" },
	}));
});

describe("without a usable project", () => {
	it("asks for a project and still lists the agents with what a build gives them", async () => {
		await show(null, null);
		expect(screen.getByText("No Project Selected")).toBeTruthy();
		expect(screen.getByText("Select a project to configure MCP servers")).toBeTruthy();
		expect(api.getProjectEnv).not.toHaveBeenCalled();

		const qa = await openCard(/^QA Reviewer/);
		expect(within(qa).getByText("Context7")).toBeTruthy();
		expect(within(qa).getByText("WorkPilot AI Tools")).toBeTruthy();
		// Optional servers stay off until a project turns them on.
		expect(within(qa).queryByText("Electron")).toBeNull();
		expect(within(qa).queryByText("Linear")).toBeNull();
		expect(within(qa).getByText("Read")).toBeTruthy();
	});

	it("does nothing when a server is added while no project is loaded", async () => {
		await show(null, null);
		const coder = await openCard(/^Coder/);
		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		await userEvent.click(await screen.findByRole("button", { name: /^Jira/ }));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();

		const context7 = within(coder).getByRole("button", { name: /^Context7/ }).parentElement as HTMLElement;
		await userEvent.click(within(context7).getByRole("button", { name: "Remove" }));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();

		await userEvent.click(within(coder).getByRole("button", { name: /^Context7/ }));
		await act(async () => {
			await (seen.serverDialog.onUpdate as (k: string, v: boolean) => Promise<void>)(
				"context7Enabled",
				false,
			);
		});
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});

	it("tells an uninitialised project apart and reads nothing for it", async () => {
		await show(null, { ...PROJECT, autoBuildPath: "" });
		expect(screen.getByText("Project Not Initialized")).toBeTruthy();
		expect(api.getProjectEnv).not.toHaveBeenCalled();
	});
});

describe("project servers", () => {
	it("counts the enabled servers and names the project", async () => {
		await show(env({ linearEnabled: true, mcpServers: { electronEnabled: true } }));
		expect(screen.getByText("4 servers enabled")).toBeTruthy();
		expect(screen.getByText(/^for Shop · /)).toBeTruthy();
	});

	it("turns Context7 off, hiding its key field, and saves only that change", async () => {
		await show(env());
		expect(screen.getByPlaceholderText("Context7 API key (optional)")).toBeTruthy();
		await userEvent.click(screen.getByRole("switch", { name: "Context7" }));
		expect(lastSave()).toEqual({ mcpServers: { context7Enabled: false } });
		expect(screen.getByRole("switch", { name: "Context7" }).getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(screen.queryByPlaceholderText("Context7 API key (optional)")).toBeNull();
	});

	it("puts a switch back when the save is refused or throws", async () => {
		await show(env());
		const context7 = () => screen.getByRole("switch", { name: "Context7" });

		api.updateProjectEnv.mockResolvedValueOnce({ success: false, error: "read-only" });
		await userEvent.click(context7());
		await waitFor(() => expect(context7().getAttribute("aria-checked")).toBe("true"));

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.updateProjectEnv.mockRejectedValueOnce(new Error("disk full"));
		await userEvent.click(screen.getByRole("switch", { name: "Electron" }));
		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: "Electron" }).getAttribute("aria-checked"),
			).toBe("false"),
		);
	});

	it("leaves the next project's settings alone when a save on the previous one fails late", async () => {
		await show(env());
		let fail: (error: Error) => void = () => undefined;
		api.updateProjectEnv.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
		await userEvent.click(screen.getByRole("switch", { name: "Context7" }));

		const other = { ...PROJECT, id: "p2", name: "Blog" };
		api.getProjectEnv.mockResolvedValue({ success: true, data: env({ linearEnabled: true }) });
		act(() => useProjectStore.setState({ projects: [PROJECT, other], selectedProjectId: "p2" }));
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: "Linear" }).hasAttribute("disabled")).toBe(false),
		);

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await act(async () => fail(new Error("disk full")));
		expect(screen.getByText("MCP Server Configuration")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "Context7" }).getAttribute("aria-checked")).toBe("true");
	});

	it("puts nothing back once the project is gone", async () => {
		await show(env());
		let refuse: (value: unknown) => void = () => undefined;
		api.updateProjectEnv.mockReturnValueOnce(new Promise((resolve) => { refuse = resolve; }));
		await userEvent.click(screen.getByRole("switch", { name: "Context7" }));
		api.getProjectEnv.mockResolvedValue({ success: false });
		act(() =>
			useProjectStore.setState({
				projects: [PROJECT, { ...PROJECT, id: "p2" }],
				selectedProjectId: "p2",
			}),
		);
		await waitFor(() => expect(screen.queryByText("MCP Server Configuration")).toBeNull());
		await act(async () => refuse({ success: false }));
		expect(screen.queryByText("MCP Server Configuration")).toBeNull();
	});

	it("saves the Context7 key trimmed on blur, and nothing when it did not change", async () => {
		await show(env({ mcpServers: { context7ApiKey: "old" } }));
		const key = screen.getByPlaceholderText("Context7 API key (optional)");
		await userEvent.click(key);
		await userEvent.tab();
		expect(api.updateProjectEnv).not.toHaveBeenCalled();

		await userEvent.clear(key);
		await userEvent.type(key, "  ctx-new  ");
		await userEvent.tab();
		expect(lastSave()).toEqual({ mcpServers: { context7ApiKey: "ctx-new" } });
	});

	it("keeps Linear off until the Linear integration is on", async () => {
		await show(env());
		const linear = screen.getByRole("switch", { name: "Linear" });
		expect(linear.hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("Requires Linear integration (see Linear settings)")).toBeTruthy();
	});

	it("turns Linear and the browser servers on and off", async () => {
		await show(env({ linearEnabled: true }));
		await userEvent.click(screen.getByRole("switch", { name: "Linear" }));
		expect(lastSave()).toEqual({ mcpServers: { linearMcpEnabled: false } });
		await userEvent.click(screen.getByRole("switch", { name: "Puppeteer" }));
		expect(lastSave()).toEqual({
			mcpServers: { linearMcpEnabled: false, puppeteerEnabled: true },
		});
		await userEvent.click(screen.getByRole("switch", { name: "Chrome DevTools" }));
		await userEvent.click(screen.getByRole("switch", { name: "Electron" }));
		expect(lastSave()).toEqual({
			mcpServers: {
				linearMcpEnabled: false,
				puppeteerEnabled: true,
				chromeDevtoolsEnabled: true,
				electronEnabled: true,
			},
		});
		expect(
			screen.getByRole("switch", { name: "WorkPilot AI Tools" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("saves the rtk and ui-ux-pro-max toggles under their own keys", async () => {
		await show(env({ tokenSavings: { rtkEnabled: false }, uiux: {} } as Partial<ProjectEnvConfig>));
		expect(seen.tokenSavings.projectPath).toBe("/work/shop");
		await act(async () => {
			await (seen.tokenSavings.onUpdate as (k: string, v: boolean) => Promise<void>)(
				"rtkEnabled",
				true,
			);
		});
		expect(lastSave()).toEqual({ tokenSavings: { rtkEnabled: true } });
		await act(async () => {
			await (seen.uiux.onUpdate as (k: string, v: boolean) => Promise<void>)("enabled", false);
		});
		expect(lastSave()).toEqual({ uiux: { enabled: false } });
	});
});

describe("an agent's servers", () => {
	it("lists only the optional servers the project turned on, as the build does", async () => {
		await show(env({ linearEnabled: true, mcpServers: { electronEnabled: true } }));
		const qa = await openCard(/^QA Reviewer/);
		expect(within(qa).getByText("Linear")).toBeTruthy();
		expect(within(qa).getByText("Electron")).toBeTruthy();
		expect(within(qa).queryByText("Puppeteer")).toBeNull();
		expect(within(card(/^QA Reviewer/)).getByText("4 MCP")).toBeTruthy();
	});

	it("names the verifier and its own verification server", async () => {
		await show(env({ mcpServers: { chromeDevtoolsEnabled: true } }));
		const verifier = await openCard(/^Verifier/);
		expect(within(verifier).getByText("WorkPilot Verify")).toBeTruthy();
		expect(within(verifier).getByText("Chrome DevTools")).toBeTruthy();
	});

	it("adds a server from the dialog, searched by its translated description", async () => {
		await show(env());
		const coder = await openCard(/^Coder/);
		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		const dialog = await screen.findByRole("dialog", { name: "Add MCP Server to Coder" });
		expect(within(dialog).getByText("Testing & QA")).toBeTruthy();
		expect(within(within(dialog).getByRole("button", { name: /^Jira/ })).getByText("Setup required")).toBeTruthy();
		expect(within(within(dialog).getByRole("button", { name: /^Puppeteer/ })).queryByText("Setup required")).toBeNull();

		await userEvent.type(within(dialog).getByPlaceholderText("Search MCP servers…"), "confluence");
		expect(within(dialog).queryByRole("button", { name: /^Puppeteer/ })).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: /^Jira/ }));

		expect(lastSave()).toEqual({ agentMcpOverrides: { coder: { add: ["jira"] } } });
		expect(screen.queryByRole("dialog")).toBeNull();
		const row = within(coder).getByRole("button", { name: /^Jira/ });
		expect(within(row).getByText("added")).toBeTruthy();
	});

	it("says when no server matches the search, and clears the search on close", async () => {
		await show(env());
		const coder = await openCard(/^Coder/);
		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		const search = await screen.findByPlaceholderText("Search MCP servers…");
		await userEvent.type(search, "zzz");
		expect(screen.getByText("No servers match your search.")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		expect((await screen.findByPlaceholderText("Search MCP servers…") as HTMLInputElement).value).toBe("");
	});

	it("takes an added server off the add list, dropping the empty override", async () => {
		await show(env({ agentMcpOverrides: { coder: { add: ["sentry"] } } }));
		const coder = await openCard(/^Coder/);
		const sentry = within(coder).getByRole("button", { name: /^Sentry/ }).parentElement as HTMLElement;
		await userEvent.click(within(sentry).getByRole("button", { name: "Remove" }));
		expect(lastSave()).toEqual({ agentMcpOverrides: {} });
		expect(within(coder).queryByText("Sentry")).toBeNull();
	});

	it("removes a default server, shows it struck through and restores it", async () => {
		await show(env({ agentMcpOverrides: { planner: { add: ["github"] } } }));
		const coder = await openCard(/^Coder/);
		const context7 = within(coder).getByRole("button", { name: /^Context7/ }).parentElement as HTMLElement;
		await userEvent.click(within(context7).getByRole("button", { name: "Remove" }));
		expect(lastSave()).toEqual({
			agentMcpOverrides: { planner: { add: ["github"] }, coder: { remove: ["context7"] } },
		});
		expect(within(coder).getByText("(removed)")).toBeTruthy();
		// The build's own tools cannot be removed.
		const tools = within(coder).getByRole("button", { name: /^WorkPilot AI Tools/ }).parentElement as HTMLElement;
		expect(within(tools).queryByRole("button", { name: "Remove" })).toBeNull();

		await userEvent.click(within(coder).getByRole("button", { name: "Restore" }));
		expect(lastSave()).toEqual({ agentMcpOverrides: { planner: { add: ["github"] } } });
		expect(within(coder).queryByText("(removed)")).toBeNull();
	});

	it("adds each removed default to the agent's remove list", async () => {
		await show(env({ agentMcpOverrides: { qa_fixer: { remove: ["context7"] } } }));
		const researcher = await openCard(/^Spec Researcher/);
		const row = within(researcher).getByRole("button", { name: /^Context7/ }).parentElement as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
		expect(lastSave()).toEqual({
			agentMcpOverrides: { qa_fixer: { remove: ["context7"] }, spec_researcher: { remove: ["context7"] } },
		});
	});

	it("restores a removed server from the add dialog too", async () => {
		await show(env({ agentMcpOverrides: { coder: { remove: ["context7"], add: ["slack"] } } }));
		const coder = await openCard(/^Coder/);
		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		const dialog = await screen.findByRole("dialog");
		const restore = within(dialog).getByText("Restore").parentElement as HTMLElement;
		await userEvent.click(within(restore).getByRole("button", { name: /^Context7/ }));
		expect(lastSave()).toEqual({ agentMcpOverrides: { coder: { add: ["slack"] } } });
	});

	it("opens a built-in server's settings from its row, translated", async () => {
		await show(env());
		const coder = await openCard(/^Coder/);
		const row = within(coder).getByRole("button", { name: /^Context7/ }).parentElement as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Configure this server" }));
		expect(seen.serverDialog.open).toBe(true);
		expect(seen.serverDialog.serverName).toBe("Context7");
		expect(seen.serverDialog.serverDescription).toMatch(/^Documentation lookup for libraries/);

		await act(async () => {
			await (seen.serverDialog.onUpdate as (k: string, v: boolean) => Promise<void>)(
				"context7Enabled",
				false,
			);
		});
		expect(lastSave()).toEqual({ mcpServers: { context7Enabled: false } });
		act(() => (seen.serverDialog.onOpenChange as (o: boolean) => void)(true));
		expect(seen.serverDialog.open).toBe(true);
		act(() => (seen.serverDialog.onOpenChange as (o: boolean) => void)(false));
		expect(seen.serverDialog.open).toBe(false);
		expect(seen.serverDialog.serverName).toBe("");
	});

	it("shows an unknown server id as it is, and says when an agent has neither servers nor tools", async () => {
		await show(env({ agentMcpOverrides: { coder: { add: ["legacy-mcp"] } } }));
		const coder = await openCard(/^Coder/);
		expect(within(coder).getByText("legacy-mcp")).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: /^Utility/ }));
		const commit = await openCard(/^Commit Message/);
		expect(within(commit).getByText("No MCP servers")).toBeTruthy();
		expect(within(commit).getByText("Text-only (no tools)")).toBeTruthy();
		await userEvent.click(card(/^Commit Message/));
		expect(within(commit).queryByText("No MCP servers")).toBeNull();
	});

	it("folds and unfolds a category", async () => {
		await show(env());
		expect(screen.getByRole("button", { name: /^Coder/ })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /^Build/ }));
		expect(screen.queryByRole("button", { name: /^Coder/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /^Build/ }));
		expect(screen.getByRole("button", { name: /^Coder/ })).toBeTruthy();
	});
});

describe("custom servers", () => {
	it("checks each server's health on load and names its state", async () => {
		api.checkMcpHealth.mockImplementation(async (server: CustomMcpServer) =>
			server.id === "docs"
				? {
						success: true,
						data: { serverId: "docs", status: "healthy", message: "Responding", checkedAt: "now" },
					}
				: { success: false, error: "no handler" },
		);
		await show(env({ customMcpServers: [DOCS, WIKI] }));
		expect(await screen.findByText("Responding")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Server is responding" })).toBeTruthy();
		// A refused check is "unknown", never a spinner that never stops.
		expect(await screen.findByText("Health check failed")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Status unknown" })).toBeTruthy();
	});

	it("words a health check that throws, and shows what a server runs before any check", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let fail: (error: Error) => void = () => undefined;
		api.checkMcpHealth.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
		await show(env({ customMcpServers: [{ ...DOCS, args: undefined }] }));
		expect(screen.getByRole("img", { name: "Checking..." })).toBeTruthy();
		await act(async () => fail(new Error("spawn failed")));
		expect(await screen.findByText("Health check failed")).toBeTruthy();
	});

	it("tests a connection and shows the answer, its time and its state", async () => {
		await show(env({ customMcpServers: [WIKI] }));
		expect(screen.getByText("https://wiki.example/mcp")).toBeTruthy();
		let answer: (value: unknown) => void = () => undefined;
		api.testMcpConnection.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
		await userEvent.click(screen.getByRole("button", { name: /Test/ }));
		expect(screen.getByRole("button", { name: /Test/ }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("img", { name: "Checking..." })).toBeTruthy();
		await act(async () =>
			answer({
				success: true,
				data: { serverId: "wiki", success: true, message: "3 tools", responseTime: 42 },
			}),
		);
		expect(screen.getByText("3 tools")).toBeTruthy();
		expect(screen.getByText("42ms")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Server is responding" })).toBeTruthy();

		api.testMcpConnection.mockResolvedValueOnce({
			success: true,
			data: { serverId: "wiki", success: false, message: "401 Unauthorized" },
		});
		await userEvent.click(screen.getByRole("button", { name: /Test/ }));
		expect(await screen.findByText("401 Unauthorized")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Server is not responding" })).toBeTruthy();
	});

	it("words a connection test that is refused or throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await show(env({ customMcpServers: [WIKI] }));
		api.testMcpConnection.mockResolvedValueOnce({ success: false, error: "no handler" });
		await userEvent.click(screen.getByRole("button", { name: /Test/ }));
		expect(await screen.findByText("Connection test failed")).toBeTruthy();

		api.checkMcpHealth.mockResolvedValue({
			success: true,
			data: { serverId: "wiki", status: "needs_auth", message: "Token needed", checkedAt: "now" },
		});
		api.testMcpConnection.mockRejectedValueOnce(new Error("timeout"));
		await userEvent.click(screen.getByRole("button", { name: /Test/ }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Test/ }).hasAttribute("disabled")).toBe(false),
		);
		expect(screen.getByText("Connection test failed")).toBeTruthy();
	});

	it("names a server that needs authentication", async () => {
		api.checkMcpHealth.mockResolvedValue({
			success: true,
			data: { serverId: "wiki", status: "needs_auth", message: "Token needed", checkedAt: "now" },
		});
		await show(env({ customMcpServers: [WIKI] }));
		expect(await screen.findByRole("img", { name: "Authentication required" })).toBeTruthy();
	});

	it("adds the first custom server of a project", async () => {
		await show(env());
		expect(screen.getByText("No custom servers configured. Add one to use with your agents.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /Add Custom Server/ }));
		await act(async () => {
			await (seen.customDialog.onSave as (s: CustomMcpServer) => Promise<void>)(DOCS);
		});
		expect(lastSave()).toEqual({ customMcpServers: [DOCS] });
		expect(await screen.findByText("Docs server")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(lastSave()).toEqual({ customMcpServers: [], agentMcpOverrides: {} });
	});

	it("adds, edits and saves custom servers through their dialog", async () => {
		await show(env({ customMcpServers: [DOCS] }));
		await userEvent.click(screen.getByRole("button", { name: /Add Custom Server/ }));
		expect(seen.customDialog.open).toBe(true);
		expect(seen.customDialog.server).toBeNull();
		// Built-in ids are taken too: a custom "github" would start the built-in one.
		expect(seen.customDialog.existingIds).toEqual(expect.arrayContaining(["github", "brain", "docs"]));
		await act(async () => {
			await (seen.customDialog.onSave as (s: CustomMcpServer) => Promise<void>)(WIKI);
		});
		expect(lastSave()).toEqual({ customMcpServers: [DOCS, WIKI] });

		act(() => (seen.customDialog.onOpenChange as (o: boolean) => void)(false));
		await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
		expect(seen.customDialog.server).toEqual(DOCS);
		const renamed = { ...DOCS, name: "Docs" };
		await act(async () => {
			await (seen.customDialog.onSave as (s: CustomMcpServer) => Promise<void>)(renamed);
		});
		expect(lastSave()).toEqual({ customMcpServers: [renamed, WIKI] });
	});

	it("deletes a server and takes it off every agent it was added to", async () => {
		await show(
			env({
				customMcpServers: [DOCS, WIKI],
				agentMcpOverrides: {
					coder: { add: ["docs"] },
					planner: { add: ["docs", "wiki"] },
					qa_fixer: { remove: ["context7"] },
				},
			}),
		);
		const docsRow = screen.getByText("Docs server").closest(".group") as HTMLElement;
		await userEvent.click(within(docsRow).getByRole("button", { name: "Delete" }));
		expect(lastSave()).toEqual({
			customMcpServers: [WIKI],
			agentMcpOverrides: { planner: { add: ["wiki"] }, qa_fixer: { remove: ["context7"] } },
		});
		expect(screen.queryByText("Docs server")).toBeNull();
	});

	it("is offered to an agent under Custom, and its row opens its own editor", async () => {
		const bare: CustomMcpServer = { id: "bare", name: "Bare", type: "http" };
		await show(env({ customMcpServers: [DOCS, WIKI, bare], agentMcpOverrides: { coder: { add: ["docs"] } } }));
		const coder = await openCard(/^Coder/);
		await userEvent.click(within(coder).getByRole("button", { name: /^Docs server/ }));
		expect(seen.customDialog.open).toBe(true);
		expect(seen.customDialog.server).toEqual(DOCS);
		expect(seen.serverDialog.open).toBe(false);
		act(() => (seen.customDialog.onOpenChange as (o: boolean) => void)(false));

		await userEvent.click(within(coder).getByRole("button", { name: /Add Server/ }));
		const dialog = await screen.findByRole("dialog");
		const custom = within(dialog).getByText("Custom").parentElement as HTMLElement;
		expect(within(custom).getByRole("button", { name: /^Wiki.*Team wiki pages/ })).toBeTruthy();
		expect(within(custom).getByRole("button", { name: /^Bare$/ })).toBeTruthy();
		await userEvent.type(within(dialog).getByPlaceholderText("Search MCP servers…"), "wiki pages");
		expect(within(dialog).getByRole("button", { name: /^Wiki/ })).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: /^Jira/ })).toBeNull();
	});
});
