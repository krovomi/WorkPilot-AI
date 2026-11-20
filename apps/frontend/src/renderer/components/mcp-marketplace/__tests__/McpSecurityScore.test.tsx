/** @vitest-environment jsdom */
/**
 * The security score of a catalog server: the catalog's score at once, the
 * registry read when the details open (for the selected project), what it
 * found, and why it could not read it.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreServer } from "../../../../shared/mcp-catalog/security-score";
import type { McpMarketplaceServer } from "../../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts, McpSecurityScore } from "../../../../shared/types/mcp-security";
import { formatAppDateTime } from "../../../lib/date-format";
import { McpSecurityBadge, McpSecurityDetails, useMcpServerSecurity } from "../McpSecurityScore";
import { CATALOG, type MainApi, resetWorld } from "./mcp-world";

const local = CATALOG.find((s) => s.transport === "stdio" && s.command === "npx") as McpMarketplaceServer;
const remote = CATALOG.find((s) => s.transport !== "stdio") as McpMarketplaceServer;

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

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

function Harness({ server, projectId = null }: { server: McpMarketplaceServer; projectId?: string | null }) {
	const security = useMcpServerSecurity(server, projectId);
	return <McpSecurityDetails security={security} />;
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("McpSecurityBadge", () => {
	it("names the score and its level", () => {
		const score = scoreServer(local);
		render(<McpSecurityBadge score={score} />);
		const badge = screen.getByTestId("mcp-security-badge");
		expect(badge).toHaveTextContent(`Security ${score.score}`);
		expect(badge).toHaveAttribute("title", `Security score ${score.score}/100: ${score.level}`);
	});
});

describe("McpSecurityDetails", () => {
	it("reads the registry when it shows, then shows what it found", async () => {
		api.getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, { facts: FACTS }),
		});
		render(<Harness server={local} projectId="p1" />);
		expect(screen.getByText("Reading the registry and known vulnerabilities…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
		const alerts = await screen.findByTestId("mcp-security-alerts");
		expect(api.getMcpServerSecurity).toHaveBeenCalledWith({
			serverId: local.id,
			projectId: "p1",
			refresh: false,
		});
		expect(alerts).toHaveTextContent("Maintainers changed: mallory.");
		expect(alerts).toHaveTextContent("GHSA-1: bad");
		expect(
			screen.getByText(`Registry read ${formatAppDateTime(FACTS.checkedAt)}`),
		).toBeInTheDocument();
		expect(screen.getByText(/^Maintainers \d+\/\d+$/)).toBeInTheDocument();
		expect(screen.getByText("New maintainers since the first check: mallory.")).toBeInTheDocument();
		expect(screen.queryByText(/^From the catalog only/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Check again" }));
		await waitFor(() =>
			expect(api.getMcpServerSecurity).toHaveBeenLastCalledWith({
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
		api.getMcpServerSecurity.mockResolvedValue({ success: true, data: low });
		render(<Harness server={local} />);
		expect(await screen.findByText(/^Low score: install it only on projects you trust/)).toBeInTheDocument();
	});

	it("keeps the catalog score and says why when the read fails", async () => {
		api.getMcpServerSecurity.mockResolvedValue({ success: false, error: "Unknown catalog server" });
		render(<Harness server={local} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown catalog server");
		expect(screen.getByText(/^From the catalog only/)).toBeInTheDocument();
		expect(screen.queryByText(/^Maintainers changed/)).toBeNull();
	});

	it("says the registry could not be read when the main gives no reason", async () => {
		api.getMcpServerSecurity.mockResolvedValue({ success: false });
		render(<Harness server={local} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("The registry could not be read.");
	});

	it("shows an error the bridge throws", async () => {
		api.getMcpServerSecurity.mockRejectedValueOnce(new Error("bridge down"));
		render(<Harness server={local} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("bridge down");
	});

	it("shows a thrown value that is not an error", async () => {
		api.getMcpServerSecurity.mockRejectedValueOnce("plain");
		render(<Harness server={local} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("plain");
	});

	it("says why the registry was not read", async () => {
		api.getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, { unchecked: "offline" }),
		});
		render(<Harness server={local} />);
		expect(
			await screen.findByText(/^This project is in strict offline mode/),
		).toBeInTheDocument();
	});

	it("never reads the registry for a remote server", () => {
		render(<Harness server={remote} />);
		expect(api.getMcpServerSecurity).not.toHaveBeenCalled();
		expect(screen.getByText(/^Runs on its vendor's servers/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
	});

	it("drops the answer read for a project the person has left", async () => {
		const forP1 = deferred<{ success: boolean; data?: McpSecurityScore }>();
		const forP2 = deferred<{ success: boolean; data?: McpSecurityScore }>();
		api.getMcpServerSecurity.mockReturnValueOnce(forP1.promise).mockReturnValueOnce(forP2.promise);
		const { rerender } = render(<Harness server={local} projectId="p1" />);
		rerender(<Harness server={local} projectId="p2" />);
		expect(api.getMcpServerSecurity).toHaveBeenLastCalledWith({
			serverId: local.id,
			projectId: "p2",
			refresh: false,
		});

		await act(async () => forP2.resolve({ success: true, data: scoreServer(local, { unchecked: "offline" }) }));
		expect(screen.getByText(/^This project is in strict offline mode/)).toBeInTheDocument();
		await act(async () => forP1.resolve({ success: true, data: scoreServer(local, { facts: FACTS }) }));
		expect(screen.queryByText(/^Maintainers changed/)).toBeNull();
		expect(screen.getByText(/^This project is in strict offline mode/)).toBeInTheDocument();
	});

	it("drops a failure of a read that a later one replaced", async () => {
		const first = deferred<never>();
		let failFirst: (err: unknown) => void = () => undefined;
		const failing = new Promise((_, reject) => {
			failFirst = reject;
		});
		api.getMcpServerSecurity.mockReturnValueOnce(failing).mockReturnValueOnce(first.promise);
		const { rerender } = render(<Harness server={local} projectId="p1" />);
		rerender(<Harness server={local} projectId="p2" />);
		await act(async () => failFirst(new Error("late failure")));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("Reading the registry and known vulnerabilities…")).toBeInTheDocument();
	});

	it("shows the catalog score again for another project until it is read", async () => {
		api.getMcpServerSecurity.mockResolvedValueOnce({ success: true, data: scoreServer(local, { facts: FACTS }) });
		function Badge({ projectId }: { projectId: string }) {
			const security = useMcpServerSecurity(local, projectId);
			return (
				<>
					<button type="button" onClick={() => void security.check()}>
						read
					</button>
					<McpSecurityBadge score={security.score} />
				</>
			);
		}
		const catalogScore = scoreServer(local).score;
		const readScore = scoreServer(local, { facts: FACTS }).score;
		expect(readScore).not.toBe(catalogScore);
		const { rerender } = render(<Badge projectId="p1" />);
		fireEvent.click(screen.getByRole("button", { name: "read" }));
		await waitFor(() =>
			expect(screen.getByTestId("mcp-security-badge")).toHaveTextContent(`Security ${readScore}`),
		);
		rerender(<Badge projectId="p2" />);
		expect(screen.getByTestId("mcp-security-badge")).toHaveTextContent(`Security ${catalogScore}`);
	});
});
