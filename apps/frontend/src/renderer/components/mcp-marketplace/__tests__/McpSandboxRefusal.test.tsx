/** @vitest-environment jsdom */
/**
 * A server that must run confined, on a machine without an OS sandbox
 * (#369, lot 6): the installed list, the policy banner and Agent Tools say
 * it does not start here, and "Why?" names what is missing, in English and
 * French. Nothing is said while the sandbox works, nor for a server that is
 * not confined; the machine is asked once for every view, and "Check again"
 * asks the main to probe again.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import type { CustomMcpServer } from "../../../../shared/types";
import type { McpSandboxStatus } from "../../../../shared/types/mcp-sandbox";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { useMcpSandboxStore } from "../../../stores/mcp-sandbox-store";
import { McpInstalledList } from "../McpInstalledList";
import { McpPolicyBanner } from "../McpPolicyNotice";
import { McpConfinedRefusal, McpPolicySandboxLine } from "../McpSandboxRefusal";
import { type MainApi, resetWorld } from "./mcp-world";

let api: MainApi;

const CONFINED: CustomMcpServer = {
	id: "docs",
	name: "Docs",
	type: "command",
	command: "npx",
	args: ["-y", "docs-mcp"],
	confine: { hosts: ["api.example.com"] },
};
const FREE: CustomMcpServer = { id: "free", name: "Free", type: "command", command: "npx" };

function machine(status: Partial<McpSandboxStatus>) {
	const full: McpSandboxStatus = {
		available: false,
		kind: "missing",
		backend: "bubblewrap",
		reason: "bubblewrap (bwrap) is not installed: install it with `sudo apt install bubblewrap`",
		...status,
	};
	api.getMcpSandboxStatus.mockResolvedValue({ success: true, data: full });
	return full;
}

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("en");
});

describe("McpConfinedRefusal", () => {
	it("says a confined server does not start here, and why", async () => {
		machine({});
		render(<McpConfinedRefusal server={CONFINED} />);
		expect(await screen.findByRole("note")).toHaveTextContent(
			"Not started on this machine: this server must run confined, in the OS sandbox, and there is none here. It is never started without it.",
		);
		const why = screen.getByTestId("mcp-sandbox-why");
		expect(why).toHaveTextContent("Why?");
		expect(why).toHaveTextContent(
			"The sandbox program (bubblewrap) is not installed on this machine.",
		);
		expect(why).toHaveTextContent("sudo apt install bubblewrap");
		expect(api.getMcpSandboxStatus).toHaveBeenCalledWith({ refresh: false });
	});

	it.each([
		["off", null, "The OS sandbox is turned off (WORKPILOT_SANDBOX=off)."],
		["unsupported", null, "no OS sandbox WorkPilot can use yet (Windows, for now)"],
		["refused", "seatbelt", "The sandbox program (seatbelt) is installed, but the system refused"],
		["unknown", null, "WorkPilot could not check this machine's OS sandbox."],
	] as const)("names a sandbox %s", async (kind, backend, text) => {
		machine({ kind, backend, reason: null });
		render(<McpConfinedRefusal server={CONFINED} />);
		expect(await screen.findByTestId("mcp-sandbox-why")).toHaveTextContent(text);
	});

	it("says it in French", async () => {
		await i18n.changeLanguage("fr");
		machine({ kind: "missing" });
		render(<McpConfinedRefusal server={CONFINED} />);
		expect(await screen.findByRole("note")).toHaveTextContent(
			"Non lancé sur cette machine : ce serveur doit tourner confiné",
		);
		expect(screen.getByTestId("mcp-sandbox-why")).toHaveTextContent(
			"Le programme du bac à sable (bubblewrap) n'est pas installé sur cette machine.",
		);
		expect(screen.getByText("Pourquoi ?")).toBeInTheDocument();
	});

	it("says nothing while the sandbox works", async () => {
		render(<McpConfinedRefusal server={CONFINED} />);
		await waitFor(() => expect(api.getMcpSandboxStatus).toHaveBeenCalled());
		await waitFor(() => expect(useMcpSandboxStore.getState().checking).toBe(false));
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});

	it("says nothing, and asks nothing, for a server that is not confined", () => {
		machine({});
		const { container } = render(
			<>
				<McpConfinedRefusal server={FREE} />
				<McpConfinedRefusal
					server={{ id: "web", name: "Web", type: "http", url: "https://x.test/mcp" }}
				/>
			</>,
		);
		expect(container).toBeEmptyDOMElement();
		expect(api.getMcpSandboxStatus).not.toHaveBeenCalled();
	});

	it("asks the machine once for every server, and again on demand", async () => {
		machine({});
		render(
			<>
				<McpConfinedRefusal server={CONFINED} />
				<McpConfinedRefusal server={{ ...CONFINED, id: "docs-2" }} />
			</>,
		);
		expect(await screen.findAllByRole("note")).toHaveLength(2);
		expect(api.getMcpSandboxStatus).toHaveBeenCalledTimes(1);

		// Installed since: checking again clears every notice.
		api.getMcpSandboxStatus.mockResolvedValue({
			success: true,
			data: { available: true, kind: "available", backend: "bubblewrap", reason: null },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
		await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
		expect(api.getMcpSandboxStatus).toHaveBeenLastCalledWith({ refresh: true });
	});

	it("says nothing when the main cannot answer", async () => {
		api.getMcpSandboxStatus.mockResolvedValueOnce({ success: false, error: "x" });
		render(<McpConfinedRefusal server={CONFINED} />);
		await waitFor(() => expect(useMcpSandboxStore.getState().asked).toBe(true));
		await waitFor(() => expect(useMcpSandboxStore.getState().checking).toBe(false));
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});

describe("useMcpSandboxStore", () => {
	it("forgets nothing on a failure, and asks once at a time", async () => {
		api.getMcpSandboxStatus.mockRejectedValueOnce(new Error("bridge"));
		await act(() => useMcpSandboxStore.getState().load());
		expect(useMcpSandboxStore.getState().status).toBeNull();
		// Asked already: a second plain load does not ask again.
		await act(() => useMcpSandboxStore.getState().load());
		expect(api.getMcpSandboxStatus).toHaveBeenCalledTimes(1);

		let release!: () => void;
		api.getMcpSandboxStatus.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ success: true, data: machine({}) });
				}),
		);
		const first = useMcpSandboxStore.getState().load(true);
		await useMcpSandboxStore.getState().load(true);
		expect(api.getMcpSandboxStatus).toHaveBeenCalledTimes(2);
		release();
		await act(() => first);
		expect(useMcpSandboxStore.getState().status?.kind).toBe("missing");
	});
});

describe("where a confined server shows", () => {
	it("in the installed list, under the server", async () => {
		machine({});
		useMcpMarketplaceStore.setState({
			projectId: "p1",
			catalog: [],
			installed: [CONFINED, FREE],
			agentOverrides: {},
		});
		render(<McpInstalledList />);
		expect(await screen.findAllByRole("note")).toHaveLength(1);
	});

	it("in the policy banner, when the policy confines servers", async () => {
		machine({ kind: "unsupported", backend: null, reason: null });
		useMcpMarketplaceStore.setState({
			policyProjectId: "p1",
			policy: { state: "active", policy: { confineBelow: 75, blockCustomServers: false } },
		});
		render(<McpPolicyBanner projectId="p1" />);
		expect(await screen.findByTestId("mcp-policy-sandbox")).toHaveTextContent(
			"On this machine, the servers this policy confines do not start: there is no OS sandbox here.",
		);
	});

	it("not in a policy banner that confines nothing", async () => {
		machine({});
		useMcpMarketplaceStore.setState({
			policyProjectId: "p1",
			policy: { state: "active", policy: { minScore: 60, blockCustomServers: false } },
		});
		render(<McpPolicyBanner projectId="p1" />);
		expect(await screen.findByText("Lowest security score: 60.")).toBeInTheDocument();
		expect(screen.queryByTestId("mcp-policy-sandbox")).not.toBeInTheDocument();
		expect(api.getMcpSandboxStatus).not.toHaveBeenCalled();
	});

	it("the banner line says nothing while the sandbox works", async () => {
		render(<McpPolicySandboxLine />);
		await waitFor(() => expect(api.getMcpSandboxStatus).toHaveBeenCalled());
		await waitFor(() => expect(useMcpSandboxStore.getState().checking).toBe(false));
		expect(screen.queryByTestId("mcp-policy-sandbox")).not.toBeInTheDocument();
	});
});
