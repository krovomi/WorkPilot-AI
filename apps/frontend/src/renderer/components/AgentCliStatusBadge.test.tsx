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

function renderBadge() {
	render(
		<TooltipProvider>
			<AgentCliStatusBadge tool="gemini-cli" />
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
