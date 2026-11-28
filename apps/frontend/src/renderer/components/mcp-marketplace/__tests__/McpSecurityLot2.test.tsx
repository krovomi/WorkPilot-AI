/** @vitest-environment jsdom */
/**
 * What the marketplace shows of the security of installed servers and of the
 * project's install policy (#369, lot 2): alerts on the installed list, a
 * server outside the catalog marked not verifiable, acknowledging; the policy
 * above the catalog, a card whose install it refuses, and a refusal from the
 * main said in the app's language.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import type { McpPolicyState } from "../../../../shared/types/mcp-policy";
import type { McpInstalledWatchView } from "../../../../shared/types/mcp-security";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { McpErrorNotice } from "../McpErrorNotice";
import { McpInstalledList } from "../McpInstalledList";
import { McpMarketplace } from "../McpMarketplace";
import { McpPolicyBanner } from "../McpPolicyNotice";
import { McpServerCard } from "../McpServerCard";
import { entry, type MainApi, resetWorld, selectProject } from "./mcp-world";

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

const WATCH: McpInstalledWatchView = {
	lastRun: "2026-11-20T10:00:00.000Z",
	servers: [
		{
			serverId: "gitlab",
			status: "watched",
			checkedAt: "2026-11-20T10:00:00.000Z",
			alerts: [
				{
					id: "vuln:GHSA-1",
					kind: "newVulnerability",
					values: { id: "GHSA-1", summary: "Remote code execution", version: "1.2.0" },
					detectedAt: "2026-11-20T10:00:00.000Z",
				},
				{ id: "deprecated:1.2.0", kind: "deprecated", detectedAt: "2026-11-20T10:00:00.000Z" },
				{
					id: "maintainers:mallory",
					kind: "maintainerAdded",
					values: { names: "mallory" },
					detectedAt: "2026-11-20T10:00:00.000Z",
				},
			],
		},
		{ serverId: "mine", status: "unverifiable", alerts: [] },
		{ serverId: "git", status: "pending", alerts: [] },
		{ serverId: "github", status: "remote", alerts: [] },
		{ serverId: "watched-no-date", status: "watched", alerts: [] },
	],
};

function installedWorld(watchProjectId = "p1") {
	useMcpMarketplaceStore.setState({
		projectId: "p1",
		catalog: [entry("gitlab"), entry("git"), entry("github")],
		installed: [
			{ id: "gitlab", name: "GitLab", type: "command", command: "npx" },
			{ id: "mine", name: "Mine", type: "command", command: "node" },
			{ id: "git", name: "Git", type: "command", command: "uvx" },
			{ id: "github", name: "GitHub", type: "http", url: "https://x" },
			{ id: "watched-no-date", name: "Quiet", type: "command", command: "npx" },
			{ id: "unlisted", name: "Unlisted", type: "command", command: "npx" },
		],
		installedWatch: WATCH,
		watchProjectId,
	});
}

describe("alerts on installed servers", () => {
	it("shows each server's alerts and where its check stands", () => {
		installedWorld();
		render(<McpInstalledList />);
		expect(screen.getByTestId("mcp-watch-alert-badge")).toHaveTextContent("3 alerts");
		expect(screen.getByText("Security alerts")).toBeInTheDocument();
		expect(
			screen.getByText(/New advisory for version 1\.2\.0: GHSA-1, Remote code execution/),
		).toBeInTheDocument();
		expect(screen.getByText(/New maintainer: mallory\./)).toBeInTheDocument();
		expect(screen.getByText(/The publisher deprecated or withdrew this package\./)).toBeInTheDocument();
		expect(screen.getAllByText(/^Found /)).toHaveLength(3);
		expect(screen.getByText(/^Checked daily; last reading /)).toBeInTheDocument();
		expect(screen.getByText("Not verifiable")).toHaveAttribute(
			"title",
			"Not a catalog server: it is never checked on the network.",
		);
		expect(screen.getByText("Not a catalog server: it is never checked on the network.")).toBeInTheDocument();
		expect(screen.getByText("Will be read by the next daily check.")).toBeInTheDocument();
		expect(screen.getByText("Runs on its vendor's servers: no package to check.")).toBeInTheDocument();
		expect(screen.getAllByTestId("mcp-watch-details")).toHaveLength(5);
	});

	it("says the alerts in French too", async () => {
		installedWorld();
		await i18n.changeLanguage("fr");
		render(<McpInstalledList />);
		expect(screen.getByTestId("mcp-watch-alert-badge")).toHaveTextContent("3 alertes");
		expect(screen.getByText("Non vérifiable")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Acquitter" })).toBeInTheDocument();
	});

	it("says strict offline mode for a project whose servers are not checked", () => {
		installedWorld();
		useMcpMarketplaceStore.setState({
			installedWatch: { servers: [{ serverId: "git", status: "offline", alerts: [] }] },
		});
		render(<McpInstalledList />);
		expect(
			screen.getByText("Strict offline mode: this project's servers are not checked."),
		).toBeInTheDocument();
	});

	it("acknowledges a server's alerts and reads them again", async () => {
		installedWorld();
		render(<McpInstalledList />);
		fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
		await waitFor(() => expect(api.acknowledgeMcpAlerts).toHaveBeenCalledWith({ serverId: "gitlab" }));
		await waitFor(() => expect(api.getMcpInstalledWatch).toHaveBeenCalledWith({ projectId: "p1" }));
		await waitFor(() => expect(screen.queryByText("Security alerts")).toBeNull());
	});

	it("shows nothing of another project's alerts", () => {
		installedWorld("p2");
		render(<McpInstalledList />);
		expect(screen.queryByTestId("mcp-watch-details")).toBeNull();
	});
});

function withPolicy(policy: McpPolicyState, projectId = "p1") {
	useMcpMarketplaceStore.setState({ policy, policyProjectId: projectId });
}

describe("the install policy", () => {
	it("says what an active policy allows", () => {
		withPolicy({
			state: "active",
			policy: {
				allowedServers: ["github", "sentry"],
				minScore: 60,
				confineBelow: 75,
				blockCustomServers: true,
			},
		});
		render(<McpPolicyBanner projectId="p1" />);
		expect(screen.getByText(/^Servers with a security score under 75/)).toBeInTheDocument();
		expect(screen.getByText(/^This project has an MCP policy/)).toBeInTheDocument();
		expect(screen.getByText("Allowed catalog servers: github, sentry.")).toBeInTheDocument();
		expect(screen.getByText("Lowest security score: 60.")).toBeInTheDocument();
		expect(screen.getByText("Servers outside the catalog are refused.")).toBeInTheDocument();
	});

	it("says a policy that allows no catalog server, or nothing more", () => {
		withPolicy({ state: "active", policy: { allowedServers: [], blockCustomServers: false } });
		const { unmount } = render(<McpPolicyBanner projectId="p1" />);
		expect(screen.getByText("No catalog server is allowed.")).toBeInTheDocument();
		unmount();
		withPolicy({ state: "active", policy: { blockCustomServers: false } });
		render(<McpPolicyBanner projectId="p1" />);
		expect(screen.queryByText(/^Allowed catalog servers/)).toBeNull();
		expect(screen.queryByText(/^Lowest security score/)).toBeNull();
		expect(screen.queryByText(/^Servers with a security score under/)).toBeNull();
		expect(screen.queryByText("Servers outside the catalog are refused.")).toBeNull();
	});

	it("says an invalid policy, and why", () => {
		withPolicy({
			state: "invalid",
			reason: "schema",
			field: "minscore",
			policy: { allowedServers: [], blockCustomServers: true },
		});
		const { unmount } = render(<McpPolicyBanner projectId="p1" />);
		expect(screen.getByRole("alert")).toHaveTextContent(/is invalid: no server can be installed/);
		expect(screen.getByText("Unknown or wrong field: minscore.")).toBeInTheDocument();
		unmount();
		withPolicy({ state: "invalid", reason: "outsideProject", policy: { blockCustomServers: true } });
		render(<McpPolicyBanner projectId="p1" />);
		expect(screen.getByText("The file, or its folder, links outside the project.")).toBeInTheDocument();
	});

	it("shows nothing without a policy, or for another project", () => {
		withPolicy({ state: "none" });
		const { container, unmount } = render(<McpPolicyBanner projectId="p1" />);
		expect(container).toBeEmptyDOMElement();
		unmount();
		withPolicy({ state: "invalid", reason: "notJson", policy: { blockCustomServers: true } }, "p2");
		const other = render(<McpPolicyBanner projectId="p1" />);
		expect(other.container).toBeEmptyDOMElement();
		other.unmount();
		const none = render(<McpPolicyBanner projectId={null} />);
		expect(none.container).toBeEmptyDOMElement();
	});

	it("keeps the Install button of a server the policy refuses, disabled, and says why", () => {
		selectProject("p1");
		withPolicy({ state: "active", policy: { allowedServers: ["github"], blockCustomServers: false } });
		useMcpMarketplaceStore.setState({ catalog: [entry("gitlab")] });
		render(<McpServerCard server={entry("gitlab")} />);
		expect(screen.getByTestId("mcp-policy-refusal")).toHaveTextContent(
			"The project's MCP policy does not allow GitLab.",
		);
		expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
	});

	it("counts the minimum score only once the main has read it", async () => {
		selectProject("p1");
		withPolicy({ state: "active", policy: { minScore: 99, blockCustomServers: false } });
		useMcpMarketplaceStore.setState({ catalog: [entry("gitlab")] });
		render(<McpServerCard server={entry("gitlab")} />);
		expect(screen.queryByTestId("mcp-policy-refusal")).toBeNull();
		expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();

		api.getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: {
				serverId: "gitlab",
				score: 60,
				level: "medium",
				dimensions: [],
				alerts: [],
				checked: true,
				checkedAt: "2026-11-20T10:00:00.000Z",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Show details" }));
		await waitFor(() =>
			expect(screen.getByTestId("mcp-policy-refusal")).toHaveTextContent(
				"GitLab has a security score of 60; the project's MCP policy needs 99 or more.",
			),
		);
		expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
	});

	it("says the main's refusal in the app's language", async () => {
		useMcpMarketplaceStore.setState({
			error: {
				key: "policyRefused",
				name: "Mine",
				policy: { reason: "customBlocked", serverId: "mine", name: "Mine" },
			},
		});
		const { unmount } = render(<McpErrorNotice />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The project's MCP policy refuses servers outside the catalog (Mine).",
		);
		unmount();
		await i18n.changeLanguage("fr");
		render(<McpErrorNotice />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"La politique MCP du projet refuse les serveurs hors catalogue (Mine).",
		);
	});
});

describe("the marketplace", () => {
	it("reads the policy and the alerts of the project, and again on Refresh", async () => {
		selectProject("p1");
		api.getMcpInstallPolicy.mockResolvedValue({
			success: true,
			data: { state: "invalid", reason: "notJson", policy: { blockCustomServers: true } },
		});
		render(<McpMarketplace />);
		await waitFor(() => expect(screen.getByText("The file is not valid JSON.")).toBeInTheDocument());
		expect(api.getMcpInstalledWatch).toHaveBeenCalledWith({ projectId: "p1" });
		api.getMcpInstallPolicy.mockClear();
		api.getMcpInstalledWatch.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(api.getMcpInstallPolicy).toHaveBeenCalledWith({ projectId: "p1" }));
		expect(api.getMcpInstalledWatch).toHaveBeenCalledWith({ projectId: "p1" });
	});
});
