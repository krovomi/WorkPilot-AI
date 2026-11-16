/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpCatalog } from "../../../../shared/mcp-catalog/install";
import { scoreServer } from "../../../../shared/mcp-catalog/security-score";
import type { McpMarketplaceServer } from "../../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../../shared/types/mcp-security";
import { useProjectStore } from "../../../stores/project-store";
import { McpServerCard } from "../McpServerCard";
import { McpSecurityDetails, useMcpServerSecurity } from "../McpSecurityScore";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values && Object.keys(values).length ? `${key}${JSON.stringify(values)}` : key,
		i18n: { language: "en" },
	}),
}));

const catalog = loadMcpCatalog();
const local = catalog.find((s) => s.transport === "stdio" && s.command === "npx") as McpMarketplaceServer;
const remote = catalog.find((s) => s.transport !== "stdio") as McpMarketplaceServer;

const FACTS: McpRegistryFacts = {
	ecosystem: "npm",
	version: "1.0.0",
	lastRelease: new Date().toISOString(),
	maintainers: ["alice", "mallory"],
	firstSeenMaintainers: ["alice"],
	repository: "https://github.com/demo/demo",
	vulnerabilities: [{ id: "GHSA-1", summary: "bad" }],
	checkedAt: "2026-11-15T10:00:00.000Z",
};

const getMcpServerSecurity = vi.fn();

beforeEach(() => {
	getMcpServerSecurity.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { getMcpServerSecurity };
});

afterEach(() => {
	act(() => useProjectStore.setState({ selectedProjectId: null }));
});

function Harness({ server, projectId = null }: { server: McpMarketplaceServer; projectId?: string | null }) {
	const security = useMcpServerSecurity(server, projectId);
	return <McpSecurityDetails security={security} />;
}

describe("McpSecurityDetails", () => {
	it("reads the registry when it shows, then shows the alerts", async () => {
		getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, { facts: FACTS }),
		});
		render(<Harness server={local} projectId="p1" />);
		expect(screen.getByText("mcpMarketplace.security.checking")).toBeTruthy();
		await waitFor(() => expect(screen.getByTestId("mcp-security-alerts")).toBeTruthy());
		expect(getMcpServerSecurity).toHaveBeenCalledWith({
			serverId: local.id,
			projectId: "p1",
			refresh: false,
		});
		expect(screen.getByText(/mcpMarketplace\.security\.alerts\.maintainerChanged/)).toBeTruthy();
		expect(screen.getByText(/mcpMarketplace\.security\.checkedAt/)).toBeTruthy();
		expect(screen.queryByText("mcpMarketplace.security.unchecked.notYet")).toBeNull();

		fireEvent.click(screen.getByText("mcpMarketplace.security.recheck"));
		await waitFor(() =>
			expect(getMcpServerSecurity).toHaveBeenLastCalledWith({
				serverId: local.id,
				projectId: "p1",
				refresh: true,
			}),
		);
	});

	it("warns of a low score", async () => {
		const low = scoreServer(
			{ ...local, official: false, args: [], tools: [{ name: "run_command", description: "" }] },
			{ facts: { ...FACTS, deprecated: true } },
		);
		expect(low.level).toBe("low");
		getMcpServerSecurity.mockResolvedValue({ success: true, data: low });
		render(<Harness server={local} />);
		await waitFor(() => expect(screen.getByText("mcpMarketplace.security.lowScore")).toBeTruthy());
	});

	it("keeps the catalog score and says why when the read fails", async () => {
		getMcpServerSecurity.mockResolvedValue({ success: false, error: "Unknown catalog server" });
		render(<Harness server={local} />);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Unknown catalog server"));
		expect(screen.getByText("mcpMarketplace.security.unchecked.notYet")).toBeTruthy();
	});

	it("shows no error text when the main gives none", async () => {
		getMcpServerSecurity.mockResolvedValue({ success: false });
		render(<Harness server={local} />);
		await waitFor(() => expect(getMcpServerSecurity).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByText("mcpMarketplace.security.checking")).toBeNull());
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows an error the bridge throws", async () => {
		getMcpServerSecurity.mockRejectedValueOnce(new Error("bridge down"));
		render(<Harness server={local} />);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("bridge down"));
	});

	it("shows a thrown value that is not an error", async () => {
		getMcpServerSecurity.mockRejectedValueOnce("plain");
		render(<Harness server={local} />);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("plain"));
	});

	it("says why the registry was not read", async () => {
		getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, { unchecked: "offline" }),
		});
		render(<Harness server={local} />);
		await waitFor(() =>
			expect(screen.getByText("mcpMarketplace.security.unchecked.offline")).toBeTruthy(),
		);
	});

	it("never reads the registry for a remote server", () => {
		render(<Harness server={remote} />);
		expect(getMcpServerSecurity).not.toHaveBeenCalled();
		expect(screen.getByText("mcpMarketplace.security.unchecked.remote")).toBeTruthy();
		expect(screen.queryByText("mcpMarketplace.security.recheck")).toBeNull();
	});
});

describe("McpServerCard", () => {
	it("shows the catalog score at once, and the details when opened", async () => {
		getMcpServerSecurity.mockResolvedValue({ success: true, data: scoreServer(local) });
		act(() => useProjectStore.setState({ selectedProjectId: "p1" }));
		render(<McpServerCard server={local} />);
		expect(screen.getByTestId("mcp-security-badge")).toBeTruthy();
		expect(getMcpServerSecurity).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("mcpMarketplace.showDetails"));
		expect(screen.getByTestId("mcp-security-details")).toBeTruthy();
		await waitFor(() =>
			expect(getMcpServerSecurity).toHaveBeenCalledWith({
				serverId: local.id,
				projectId: "p1",
				refresh: false,
			}),
		);
	});
});
