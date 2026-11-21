/**
 * A save of Agent Tools that the project's MCP policy refuses (#369, lot 3):
 * the main wrote nothing, the view puts the previous list back and says why,
 * until a save goes through.
 */
import { render, screen, waitFor } from "@testing-library/react";
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

const config = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks")>()),
	useProjectEnvConfig: () => config.value,
}));

const updateProjectEnv = vi.fn();

config.value = {
	envConfig: { mcpServers: {}, customMcpServers: [SERVER], agentMcpOverrides: {} },
	setEnvConfig: () => undefined,
};

describe("AgentTools and the MCP policy", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(globalThis.electronAPI, {
			updateProjectEnv,
			checkMcpHealth: vi.fn().mockResolvedValue({ success: false }),
			testMcpConnection: vi.fn(),
			getMcpPins: vi.fn().mockResolvedValue({ success: true, data: [] }),
		});
		useProjectStore.setState({
			projects: [{ id: "p1", name: "app", path: "/work/app" }] as never,
			selectedProjectId: "p1",
		});
	});

	it("says why the policy refused a save, until one goes through", async () => {
		updateProjectEnv.mockResolvedValueOnce({
			success: false,
			error: "refused",
			data: { mcpPolicyRefusal: { reason: "customBlocked", serverId: "docs", name: "Docs server" } },
		});
		render(<AgentTools />);
		await screen.findByText("Docs server");

		await userEvent.click(screen.getAllByTitle("Delete")[0]);
		expect(
			await screen.findByText("The project's MCP policy refuses servers outside the catalog (Docs server)."),
		).toBeInTheDocument();

		updateProjectEnv.mockResolvedValueOnce({ success: true });
		await userEvent.click(screen.getAllByTitle("Delete")[0]);
		await waitFor(() =>
			expect(screen.queryByText(/refuses servers outside the catalog/)).toBeNull(),
		);
	});

	it("says nothing of the policy for another failure", async () => {
		updateProjectEnv.mockResolvedValueOnce({ success: false, error: "disk full" });
		render(<AgentTools />);
		await screen.findByText("Docs server");
		await userEvent.click(screen.getAllByTitle("Delete")[0]);
		await waitFor(() => expect(updateProjectEnv).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
