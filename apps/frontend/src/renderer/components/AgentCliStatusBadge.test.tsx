/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "./ui/tooltip";

const refreshCatalog = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useProviderModelCatalog", () => ({
	refreshProviderModelCatalog: refreshCatalog,
}));
import i18n from "../../shared/i18n";
import { AgentCliStatusBadge } from "./AgentCliStatusBadge";

const checkAgentCli = vi.fn();
const installAgentCli = vi.fn();
const checkCliUpdate = vi.fn();
const updateCli = vi.fn();

function renderBadge(tool: "gemini-cli" | "antigravity" = "gemini-cli") {
	render(
		<TooltipProvider>
			<AgentCliStatusBadge tool={tool} />
		</TooltipProvider>,
	);
}

describe("AgentCliStatusBadge install", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		checkAgentCli.mockReset();
		installAgentCli.mockReset();
		refreshCatalog.mockReset();
		(globalThis as { electronAPI?: unknown }).electronAPI = {
			checkAgentCli,
			installAgentCli,
		};
	});
	afterEach(() => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("offers to install a missing CLI and shows the new version", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: false });
		installAgentCli.mockResolvedValue({
			tool: "gemini-cli",
			success: true,
			method: "npm",
			status: { tool: "gemini-cli", installed: true, version: "0.66.0" },
		});
		renderBadge();
		await screen.findByText("Install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		expect(await screen.findByText("npm install -g @google/gemini-cli@latest")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Install Gemini CLI" }));
		await waitFor(() => expect(installAgentCli).toHaveBeenCalledWith("gemini-cli"));
		expect(await screen.findAllByText(/0\.66\.0/)).not.toHaveLength(0);
		expect(refreshCatalog).toHaveBeenCalledWith("gemini-cli");
	});

	it("shows why an install failed", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: false });
		installAgentCli.mockResolvedValue({
			tool: "gemini-cli",
			success: false,
			error: "node_required",
		});
		renderBadge();
		await screen.findByText("Install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Install Gemini CLI" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Gemini CLI cannot be installed here: install Node.js (nodejs.org) first, then try again.",
		);
	});

	it("offers no install for a CLI already there", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "1.0.0" });
		renderBadge();
		await screen.findByText(/1\.0\.0/);
		expect(screen.queryByText("Install")).not.toBeInTheDocument();
	});
});

describe("AgentCliStatusBadge update", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		checkAgentCli.mockReset();
		checkCliUpdate.mockReset();
		updateCli.mockReset();
		(globalThis as { electronAPI?: unknown }).electronAPI = {
			checkAgentCli,
			installAgentCli,
			checkCliUpdate,
			updateCli,
		};
	});
	afterEach(() => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("flags an outdated CLI and updates it with one click", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.10.0" });
		const upToDate = {
			tool: "gemini-cli",
			installed: true,
			version: "0.12.0",
			latest: "0.12.0",
			isOutdated: false,
		};
		checkCliUpdate
			.mockResolvedValueOnce({ ...upToDate, version: "0.10.0", isOutdated: true })
			.mockResolvedValue(upToDate);
		updateCli.mockResolvedValue({
			tool: "gemini-cli",
			success: true,
			method: "npm",
			status: upToDate,
		});
		renderBadge();
		await screen.findByText("Update");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		expect(await screen.findByText("0.12.0")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(updateCli).toHaveBeenCalledWith("gemini-cli"));
		expect(
			await screen.findByText("Gemini CLI is up to date (0.12.0)."),
		).toBeInTheDocument();
		// The badge checked itself again after the update.
		await waitFor(() => expect(checkAgentCli).toHaveBeenCalledTimes(2));
	});

	it("shows why an update failed, with the command output", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.10.0" });
		checkCliUpdate.mockResolvedValue({
			tool: "gemini-cli",
			installed: true,
			version: "0.10.0",
			latest: "0.12.0",
			isOutdated: true,
		});
		updateCli.mockResolvedValue({
			tool: "gemini-cli",
			success: false,
			error: "failed",
			detail: "npm ERR! code EACCES",
		});
		renderBadge();
		await screen.findByText("Update");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Updating Gemini CLI failed.");
		expect(alert).toHaveTextContent("npm ERR! code EACCES");
	});

	it("still offers the CLI's own updater when no latest version is published", async () => {
		checkAgentCli.mockResolvedValue({ tool: "antigravity", installed: true, version: "1.0.0" });
		checkCliUpdate.mockResolvedValue({
			tool: "antigravity",
			installed: true,
			version: "1.0.0",
			isOutdated: false,
		});
		renderBadge("antigravity");
		fireEvent.click(await screen.findByRole("button", { name: /Antigravity/ }));
		expect(
			await screen.findByRole("button", { name: /Update if needed/ }),
		).toBeInTheDocument();
		// Not flagged: nothing says a newer one exists.
		expect(screen.queryByText("Update")).not.toBeInTheDocument();
	});

	it("offers no update button for a CLI already on the latest release", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.12.0" });
		checkCliUpdate.mockResolvedValue({
			tool: "gemini-cli",
			installed: true,
			version: "0.12.0",
			latest: "0.12.0",
			isOutdated: false,
		});
		renderBadge();
		fireEvent.click(await screen.findByRole("button", { name: /Gemini/ }));
		await waitFor(() => expect(checkCliUpdate).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Update if needed/ }),
		).not.toBeInTheDocument();
	});
});

describe("AgentCliStatusBadge status", () => {
	const probeAcpAgent = vi.fn();
	const openExternal = vi.fn();

	function setApi() {
		(globalThis as { electronAPI?: unknown }).electronAPI = {
			checkAgentCli,
			installAgentCli,
			checkCliUpdate,
			updateCli,
			probeAcpAgent,
			openExternal,
		};
	}

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		vi.clearAllMocks();
		checkCliUpdate.mockResolvedValue({ tool: "gemini-cli", installed: false, isOutdated: false });
		probeAcpAgent.mockReturnValue(new Promise(() => undefined));
		openExternal.mockResolvedValue(undefined);
		setApi();
	});
	afterEach(() => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		vi.restoreAllMocks();
	});

	it("says it is checking, then reports where the panel should place it", async () => {
		let answer: (value: unknown) => void = () => undefined;
		checkAgentCli.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const onPresenceChange = vi.fn();
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" onPresenceChange={onPresenceChange} />
			</TooltipProvider>,
		);
		const badge = screen.getByRole("button", { name: /Gemini/ });
		fireEvent.focus(badge);
		expect((await screen.findAllByText("Checking Gemini CLI..."))[0]).toBeInTheDocument();
		expect(onPresenceChange).not.toHaveBeenCalled();
		answer({ tool: "gemini-cli", installed: true });
		await waitFor(() => expect(onPresenceChange).toHaveBeenCalledWith("installed"));
	});

	it("names an installed CLI that printed no version", async () => {
		checkAgentCli.mockResolvedValue({ tool: "opencode", installed: true });
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="opencode" />
			</TooltipProvider>,
		);
		const badge = screen.getByRole("button", { name: /OpenCode/ });
		fireEvent.focus(badge);
		expect((await screen.findAllByText("OpenCode CLI installed"))[0]).toBeInTheDocument();
		fireEvent.click(badge);
		expect(await screen.findByText("Installed")).toBeInTheDocument();
		expect(screen.queryByText("Version:")).not.toBeInTheDocument();
	});

	it("shows the version when no update check answers", async () => {
		checkAgentCli.mockResolvedValue({ tool: "opencode", installed: true, version: "1.4.2" });
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="opencode" />
			</TooltipProvider>,
		);
		const badge = await screen.findByRole("button", { name: "OpenCode (1.4.2)" });
		fireEvent.focus(badge);
		expect((await screen.findAllByText("OpenCode CLI (1.4.2)"))[0]).toBeInTheDocument();
		fireEvent.click(badge);
		expect((await screen.findByText("Version:")).nextElementSibling).toHaveTextContent("1.4.2");
		// Not an ACP agent: nothing is asked.
		expect(probeAcpAgent).not.toHaveBeenCalled();
	});

	it("says the check failed, and checks again on refresh", async () => {
		checkAgentCli.mockRejectedValueOnce(new Error("spawn failed"));
		const onPresenceChange = vi.fn();
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" onPresenceChange={onPresenceChange} />
			</TooltipProvider>,
		);
		const badge = screen.getByRole("button", { name: /Gemini/ });
		await waitFor(() => expect(onPresenceChange).toHaveBeenCalledWith("missing"));
		fireEvent.focus(badge);
		expect((await screen.findAllByText("Could not check Gemini CLI"))[0]).toBeInTheDocument();
		fireEvent.click(badge);
		expect(await screen.findByText("Error")).toBeInTheDocument();

		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.66.0" });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByRole("button", { name: "Gemini (0.66.0)" })).toBeInTheDocument();
		expect(checkAgentCli).toHaveBeenCalledTimes(2);
	});

	it("rejects a non-Error failure of the check as text", async () => {
		checkAgentCli.mockRejectedValue("no shell");
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" />
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		expect(await screen.findByText("Error")).toBeInTheDocument();
	});

	it("keeps only the icon when the sidebar is collapsed", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: false });
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" isCollapsed />
			</TooltipProvider>,
		);
		await waitFor(() => expect(checkAgentCli).toHaveBeenCalled());
		expect(screen.queryByText("Gemini")).not.toBeInTheDocument();
		expect(screen.queryByText("Install")).not.toBeInTheDocument();
	});

	it("opens the CLI's documentation", async () => {
		checkAgentCli.mockResolvedValue({ tool: "pi", installed: false });
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="pi" />
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /pi/ }));
		fireEvent.click(await screen.findByRole("button", { name: "View pi (pi.dev) documentation" }));
		expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("pi.dev"));
	});

	it.each([
		["pi", "Mozilla/5.0 (X11; Linux x86_64)", "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest"],
		["antigravity", "Mozilla/5.0 (X11; Linux x86_64)", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
		["antigravity", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "irm https://antigravity.google/cli/install.ps1 | iex"],
	] as const)("shows the command that installs %s (%s)", async (tool, userAgent, command) => {
		vi.spyOn(globalThis.navigator, "userAgent", "get").mockReturnValue(userAgent);
		checkAgentCli.mockResolvedValue({ tool, installed: false });
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool={tool} />
			</TooltipProvider>,
		);
		await screen.findByText("Install");
		fireEvent.click(screen.getAllByRole("button")[0]);
		expect(await screen.findByText(command)).toBeInTheDocument();
	});

	it("says it is installing, then checks again when the install brings no check", async () => {
		checkAgentCli.mockResolvedValueOnce({ tool: "gemini-cli", installed: false });
		let answer: (value: unknown) => void = () => undefined;
		installAgentCli.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" />
			</TooltipProvider>,
		);
		await screen.findByText("Install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Install Gemini CLI" }));
		expect(await screen.findByRole("button", { name: "Installing, please wait…" })).toBeDisabled();
		expect(screen.getByText("Installing…")).toBeInTheDocument();

		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.66.0" });
		answer({ tool: "gemini-cli", success: true, method: "npm" });
		expect(await screen.findByRole("button", { name: "Gemini (0.66.0)" })).toBeInTheDocument();
		expect(refreshCatalog).toHaveBeenCalledWith("gemini-cli");
	});

	it("shows the output of an install that threw, and of one that gave no reason", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: false });
		installAgentCli.mockRejectedValueOnce(new Error("EACCES /usr/lib"));
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" />
			</TooltipProvider>,
		);
		await screen.findByText("Install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Install Gemini CLI" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Installing Gemini CLI failed.");
		expect(alert).toHaveTextContent("EACCES /usr/lib");

		installAgentCli.mockRejectedValueOnce("killed");
		fireEvent.click(await screen.findByRole("button", { name: "Install Gemini CLI" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("killed"));

		installAgentCli.mockResolvedValueOnce({
			tool: "gemini-cli",
			success: false,
			status: { tool: "gemini-cli", installed: false },
		});
		fireEvent.click(await screen.findByRole("button", { name: "Install Gemini CLI" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe("Installing Gemini CLI failed."),
		);
	});
});

describe("AgentCliStatusBadge ACP declaration", () => {
	const probeAcpAgent = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		vi.clearAllMocks();
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "0.66.0" });
		checkCliUpdate.mockResolvedValue({ tool: "gemini-cli", installed: false, isOutdated: false });
		(globalThis as { electronAPI?: unknown }).electronAPI = {
			checkAgentCli,
			installAgentCli,
			checkCliUpdate,
			updateCli,
			probeAcpAgent,
		};
	});
	afterEach(() => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	});

	async function openPopover() {
		render(
			<TooltipProvider>
				<AgentCliStatusBadge tool="gemini-cli" />
			</TooltipProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "Gemini (0.66.0)" }));
	}

	it("lists what the agent declares, and what it does not", async () => {
		probeAcpAgent.mockResolvedValue({
			tool: "gemini-cli",
			declared: {
				protocolVersion: 1,
				loadSession: true,
				images: true,
				audio: false,
				embeddedContext: true,
				mcpHttp: false,
				mcpSse: false,
				authMethods: [],
			},
		});
		await openPopover();
		expect(await screen.findByText("Declared by the agent (ACP initialize):")).toBeInTheDocument();
		expect(screen.getByText("Resume a session").closest("li")).toHaveTextContent("Resume a session");
		expect(screen.getByText(/Audio in prompts/)).toHaveTextContent("Audio in prompts (not declared)");
		expect(probeAcpAgent).toHaveBeenCalledWith("gemini-cli");
	});

	it.each([
		["the agent is not ACP", { tool: "gemini-cli", error: "not_acp" }, "It did not answer as an ACP version 1 agent."],
		["the answer has no reason", { tool: "gemini-cli" }, "Could not ask the agent."],
	])("says why there is no declaration when %s", async (_case, answer, text) => {
		probeAcpAgent.mockResolvedValue(answer);
		await openPopover();
		expect(await screen.findByText(text)).toBeInTheDocument();
	});

	it("says the agent could not be asked when the probe fails", async () => {
		probeAcpAgent.mockRejectedValue(new Error("ipc down"));
		await openPopover();
		expect(await screen.findByText("Could not ask the agent.")).toBeInTheDocument();
	});

	it("drops an answer that comes after the popover closed", async () => {
		let answer: (value: unknown) => void = () => undefined;
		probeAcpAgent.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const error = vi.spyOn(console, "error");
		await openPopover();
		expect(await screen.findByText("Asking the agent what it supports…")).toBeInTheDocument();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByText("Asking the agent what it supports…")).not.toBeInTheDocument(),
		);
		answer({ tool: "gemini-cli", error: "no_answer" });
		await Promise.resolve();
		expect(screen.queryByText("It did not answer initialize in time.")).not.toBeInTheDocument();
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
