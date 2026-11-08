/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "./ui/tooltip";

const refreshCatalog = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useProviderModelCatalog", () => ({
	refreshProviderModelCatalog: refreshCatalog,
}));
// Keys come back as-is so the assertions do not depend on translations.
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}));

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
	beforeEach(() => {
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
		await screen.findByText("common:install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		expect(await screen.findByText("npm install -g @google/gemini-cli@latest")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /agentCli.install.button/ }));
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
		await screen.findByText("common:install");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: /agentCli.install.button/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"navigation:agentCli.install.error.node_required",
		);
	});

	it("offers no install for a CLI already there", async () => {
		checkAgentCli.mockResolvedValue({ tool: "gemini-cli", installed: true, version: "1.0.0" });
		renderBadge();
		await screen.findByText(/1\.0\.0/);
		expect(screen.queryByText("common:install")).not.toBeInTheDocument();
	});
});

describe("AgentCliStatusBadge update", () => {
	beforeEach(() => {
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
		await screen.findByText("common:update");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		expect(await screen.findByText("0.12.0")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "common:update" }));
		await waitFor(() => expect(updateCli).toHaveBeenCalledWith("gemini-cli"));
		expect(
			await screen.findByText("navigation:agentCli.update.doneWithVersion"),
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
		await screen.findByText("common:update");
		fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
		fireEvent.click(await screen.findByRole("button", { name: "common:update" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("navigation:agentCli.update.error.failed");
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
			await screen.findByRole("button", { name: /agentCli.update.checkAndUpdate/ }),
		).toBeInTheDocument();
		// Not flagged: nothing says a newer one exists.
		expect(screen.queryByText("common:update")).not.toBeInTheDocument();
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
		expect(screen.queryByRole("button", { name: "common:update" })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /agentCli.update.checkAndUpdate/ }),
		).not.toBeInTheDocument();
	});
});
