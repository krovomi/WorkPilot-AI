/** @vitest-environment jsdom */
/**
 * A catalog server on its card: what it is, how it runs, its details, and
 * installing it in the selected project for the agents picked in the dialog,
 * or removing it from the project its installed list was read from.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import type { McpMarketplaceServer } from "../../../../shared/types/mcp-marketplace";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { useProjectStore } from "../../../stores/project-store";
import { McpServerCard } from "../McpServerCard";
import { entry, type MainApi, resetWorld, selectProject } from "./mcp-world";

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

function show(server: McpMarketplaceServer) {
	useMcpMarketplaceStore.setState({ catalog: [server] });
	return render(<McpServerCard server={server} />);
}

function openInstall() {
	fireEvent.click(screen.getByRole("button", { name: "Install" }));
	return screen.getByRole("dialog");
}

describe("the card", () => {
	it("shows a community server run on this machine, and its details", async () => {
		selectProject("p1");
		show(entry("gitlab"));
		expect(screen.getByRole("heading", { name: "GitLab" })).toBeInTheDocument();
		expect(
			screen.getByText("Projects, issues, merge requests and pipelines on gitlab.com or self-hosted"),
		).toBeInTheDocument();
		expect(screen.getByText("npx")).toBeInTheDocument();
		expect(screen.getByText("Community")).toBeInTheDocument();
		expect(screen.getByText("@zereight/mcp-gitlab")).toBeInTheDocument();
		expect(screen.getByText("get_merge_request")).toBeInTheDocument();
		expect(screen.getByText("+2")).toBeInTheDocument();
		expect(screen.queryByText("Required configuration:")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Show details" }));
		expect(screen.getByText(/The most complete GitLab MCP server/)).toBeInTheDocument();
		expect(screen.getByText("Required configuration:")).toBeInTheDocument();
		expect(screen.getByText("GitLab token")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Homepage" })).toHaveAttribute(
			"href",
			entry("gitlab").homepage,
		);
		expect(screen.getByTestId("mcp-security-details")).toBeInTheDocument();
		await waitFor(() =>
			expect(api.getMcpServerSecurity).toHaveBeenCalledWith({
				serverId: "gitlab",
				projectId: "p1",
				refresh: false,
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
		expect(screen.queryByTestId("mcp-security-details")).toBeNull();
	});

	it("shows an official remote server, and what a server needs on the machine", () => {
		selectProject("p1");
		const { unmount } = show(entry("github"));
		expect(screen.getByText("http")).toBeInTheDocument();
		expect(screen.getByText("Official")).toBeInTheDocument();
		unmount();

		show({ ...entry("jira"), homepage: "" });
		fireEvent.click(screen.getByRole("button", { name: "Show details" }));
		expect(screen.getByText("Needs uv (uvx) on this machine.")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Homepage" })).toBeNull();
	});

	it("shows a server with few tools and nothing to configure", () => {
		selectProject("p1");
		show({ ...entry("time"), tools: [{ name: "now", description: "" }] });
		expect(screen.getByText("now")).toBeInTheDocument();
		expect(screen.queryByText(/^\+\d/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Show details" }));
		expect(screen.queryByText("Required configuration:")).toBeNull();
	});

	it("speaks the app's language", async () => {
		selectProject("p1");
		await act(() => i18n.changeLanguage("fr"));
		show(entry("gitlab"));
		expect(
			screen.getByText("Projets, issues, merge requests et pipelines sur gitlab.com ou auto-hébergé"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Installer" })).toBeInTheDocument();
	});

	it("cannot install without a project, and says why", () => {
		selectProject(null);
		show(entry("gitlab"));
		const install = screen.getByRole("button", { name: "Install" });
		expect(install).toBeDisabled();
		expect(install).toHaveAttribute("title", "Select a project: servers are installed per project.");
	});

	it("shows an install in progress", () => {
		selectProject("p1");
		useMcpMarketplaceStore.setState({ isInstalling: "gitlab" });
		show(entry("gitlab"));
		expect(screen.getByRole("button", { name: "Installing..." })).toBeDisabled();
	});

	it("removes an installed server from the project it was read from", async () => {
		selectProject("p2");
		useMcpMarketplaceStore.setState({
			projectId: "p1",
			installed: [{ id: "gitlab", name: "GitLab", type: "command" }],
		});
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: { customMcpServers: [{ id: "gitlab", name: "GitLab", type: "command" }] },
		});
		show(entry("gitlab"));
		expect(screen.getByText("Installed")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		await waitFor(() =>
			expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", {
				customMcpServers: [],
				agentMcpOverrides: {},
			}),
		);
		expect(await screen.findByRole("button", { name: "Install" })).toBeInTheDocument();
	});
});

describe("the install dialog", () => {
	it("asks the values, then installs for the agents picked", async () => {
		selectProject("p1", "Shop");
		show(entry("gitlab"));
		const dialog = openInstall();
		expect(within(dialog).getByRole("heading", { name: "Install GitLab" })).toBeInTheDocument();
		expect(
			within(dialog).getByText(
				"The server is added to project Shop. Values are stored in the project's .workpilot/.env.",
			),
		).toBeInTheDocument();
		expect(within(dialog).getByText("Optional")).toBeInTheDocument();
		expect(within(dialog).getByText("Personal access token with the api scope.")).toBeInTheDocument();
		expect(
			within(dialog).getByRole("link", { name: "Where to get GitLab token" }),
		).toHaveAttribute("href", "https://gitlab.com/-/user_settings/personal_access_tokens");

		const confirm = within(dialog).getByRole("button", { name: "Install" });
		expect(confirm).toBeDisabled();
		const token = within(dialog).getByLabelText(/GitLab token/, { selector: "input" });
		expect(token).toHaveAttribute("type", "password");
		fireEvent.change(token, { target: { value: "glpat-fake-token" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Show the value" }));
		expect(token).toHaveAttribute("type", "text");
		fireEvent.click(within(dialog).getByRole("button", { name: "Hide the value" }));
		expect(token).toHaveAttribute("type", "password");
		fireEvent.change(within(dialog).getByLabelText("API URL"), {
			target: { value: "https://gitlab.example.com/api/v4" },
		});
		expect(within(dialog).getByLabelText("API URL")).toHaveAttribute("type", "text");

		expect(within(dialog).getByText("You can change this later in Agent Tools.")).toBeInTheDocument();
		for (const name of ["Planner", "Coder", "QA reviewer"]) {
			fireEvent.click(within(dialog).getByRole("checkbox", { name }));
		}
		expect(within(dialog).getByText("Pick at least one agent.")).toBeInTheDocument();
		expect(confirm).toBeDisabled();
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Coder" }));
		expect(confirm).toBeEnabled();

		fireEvent.click(confirm);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const [projectId, written] = api.updateProjectEnv.mock.calls[0];
		expect(projectId).toBe("p1");
		expect(written.customMcpServers).toEqual([
			expect.objectContaining({
				id: "gitlab",
				env: {
					GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-fake-token",
					GITLAB_API_URL: "https://gitlab.example.com/api/v4",
				},
			}),
		]);
		expect(written.agentMcpOverrides).toEqual({ coder: { add: ["gitlab"], remove: [] } });
		expect(screen.getByText("Installed")).toBeInTheDocument();
	});

	it("names no project while the project list is not read yet", () => {
		selectProject("p1");
		act(() => useProjectStore.setState({ projects: [] }));
		show(entry("time"));
		const dialog = openInstall();
		expect(
			within(dialog).getByText(
				"The server is added to project . Values are stored in the project's .workpilot/.env.",
			),
		).toBeInTheDocument();
	});

	it("offers a server meant for one kind of task to its agents only", () => {
		selectProject("p1");
		show(entry("rea"));
		const dialog = openInstall();
		expect(within(dialog).getAllByRole("checkbox").map((c) => c.id)).toEqual([
			"mcp-agent-rea-analyzer",
		]);
		expect(within(dialog).getByRole("checkbox", { name: "Investigator" })).toBeChecked();
		expect(within(dialog).queryByText("Optional")).toBeNull();
	});

	it("says what the server needs on the machine", () => {
		selectProject("p1");
		show(entry("jira"));
		const dialog = openInstall();
		expect(within(dialog).getByText("Needs uv (uvx) on this machine.")).toBeInTheDocument();
	});

	it("stays open and says why when the install fails, and starts empty when opened again", async () => {
		selectProject("p1");
		api.updateProjectEnv.mockResolvedValue({ success: false, error: "read-only file" });
		show(entry("notion"));
		let dialog = openInstall();
		fireEvent.change(within(dialog).getByLabelText(/Integration token/, { selector: "input" }), { target: { value: "ntn_fake" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
		const alert = await within(dialog).findByRole("alert");
		expect(alert).toHaveTextContent("The project settings could not be saved.");
		expect(alert).toHaveTextContent("read-only file");

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		dialog = openInstall();
		expect(within(dialog).queryByRole("alert")).toBeNull();
		expect(within(dialog).getByLabelText(/Integration token/, { selector: "input" })).toHaveValue("");
	});

	it("closes when the project is no longer selected", () => {
		selectProject("p1");
		show(entry("notion"));
		openInstall();
		selectProject(null);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on Escape", () => {
		selectProject("p1");
		show(entry("notion"));
		const dialog = openInstall();
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows an install in progress", () => {
		selectProject("p1");
		show(entry("time"));
		const dialog = openInstall();
		act(() => useMcpMarketplaceStore.setState({ isInstalling: "time" }));
		expect(within(dialog).getByRole("button", { name: "Installing..." })).toBeDisabled();
	});
});
