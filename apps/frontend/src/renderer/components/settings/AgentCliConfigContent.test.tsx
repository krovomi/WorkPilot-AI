/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCliConfigContent } from "./AgentCliConfigContent";

vi.mock("react-i18next", () => {
	const t = (key: string, options?: Record<string, unknown>) =>
		options ? `${key} ${JSON.stringify(options)}` : key;
	return { useTranslation: () => ({ t }) };
});
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/useProviderModelCatalog", () => ({
	refreshProviderModelCatalog: vi.fn(),
}));
vi.mock("../ui/dialog", () => {
	const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		DialogTitle: Part,
		DialogDescription: Part,
		DialogHeader: Part,
		DialogFooter: Part,
	};
});
const authTerminalProps = vi.fn();
vi.mock("./AuthTerminal", () => ({
	AuthTerminal: (props: Record<string, unknown>) => {
		authTerminalProps(props);
		return <div>terminal</div>;
	},
}));

const KEY = "sections.accounts.providerConfig.agentCli";

async function renderContent(overrides: Record<string, unknown> = {}) {
	const props = {
		tool: "opencode" as const,
		providerName: "OpenCode",
		onActivate: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	await act(async () => {
		render(<AgentCliConfigContent {...props} />);
	});
	return props;
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("AgentCliConfigContent", () => {
	it("shows the installed version and offers the CLI's own login command", async () => {
		vi.stubGlobal("electronAPI", {
			checkAgentCli: vi
				.fn()
				.mockResolvedValue({ tool: "opencode", installed: true, version: "1.19.5" }),
		});
		await renderContent();
		expect(screen.getByTestId("agent-cli-status").textContent).toContain(
			'"version":"1.19.5"',
		);
		expect(screen.getByText("opencode auth login")).toBeTruthy();
		fireEvent.click(screen.getByText(`${KEY}.openTerminal`));
		expect(authTerminalProps).toHaveBeenCalledWith(
			expect.objectContaining({ loginCommand: "opencode auth login" }),
		);
	});

	it("activates the CLI as the default provider and closes", async () => {
		vi.stubGlobal("electronAPI", {
			checkAgentCli: vi.fn().mockResolvedValue({ tool: "pi", installed: true }),
		});
		const props = await renderContent({ tool: "pi", providerName: "pi" });
		await act(async () => {
			fireEvent.click(screen.getByText(`${KEY}.activate`));
		});
		expect(props.onActivate).toHaveBeenCalledWith("pi");
		expect(props.onClose).toHaveBeenCalled();
		expect(toast).toHaveBeenCalled();
	});

	it("offers to install a missing CLI and keeps sign-in and activation disabled", async () => {
		const installAgentCli = vi.fn().mockResolvedValue({
			tool: "gemini-cli",
			success: true,
			status: { tool: "gemini-cli", installed: true, version: "0.9.0" },
		});
		vi.stubGlobal("electronAPI", {
			checkAgentCli: vi
				.fn()
				.mockResolvedValue({ tool: "gemini-cli", installed: false }),
			installAgentCli,
		});
		await renderContent({ tool: "gemini-cli", providerName: "Gemini CLI" });
		expect(screen.getByTestId("agent-cli-status").textContent).toContain(
			'"executable":"gemini"',
		);
		expect(
			(screen.getByText(`${KEY}.activate`) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByText(`${KEY}.openTerminal`).closest("button") as HTMLButtonElement)
				.disabled,
		).toBe(true);
		await act(async () => {
			fireEvent.click(screen.getByText(`${KEY}.install {"name":"Gemini CLI"}`));
		});
		expect(installAgentCli).toHaveBeenCalledWith("gemini-cli");
		expect(
			(screen.getByText(`${KEY}.activate`) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("shows why an install failed", async () => {
		vi.stubGlobal("electronAPI", {
			checkAgentCli: vi
				.fn()
				.mockResolvedValue({ tool: "antigravity", installed: false }),
			installAgentCli: vi.fn().mockResolvedValue({
				tool: "antigravity",
				success: false,
				error: "node_required",
			}),
		});
		await renderContent({ tool: "antigravity", providerName: "Google Antigravity" });
		await act(async () => {
			fireEvent.click(
				screen.getByText(`${KEY}.install {"name":"Google Antigravity"}`),
			);
		});
		expect(
			screen.getByText(
				'navigation:agentCli.install.error.node_required {"name":"Google Antigravity"}',
			),
		).toBeTruthy();
	});
});
