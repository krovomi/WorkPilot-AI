/**
 * @vitest-environment jsdom
 */
/**
 * The Copilot CLI badge of the sidebar: each state it shows, the silent
 * install and its terminal fallback, the gh login, and the installation switch.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { CopilotCliStatusBadge } from "../CopilotCliStatusBadge";
import { TooltipProvider } from "../ui/tooltip";

type CopilotStatus =
	| "loading"
	| "installed"
	| "outdated"
	| "not-found"
	| "gh-missing"
	| "error";

const cli = vi.hoisted(() => ({
	copilot: {
		status: "installed" as string,
		versionInfo: null as null | Record<string, unknown>,
		lastChecked: null as Date | null,
		authStatus: null as null | { authenticated: boolean; username?: string },
	},
	refreshCopilot: vi.fn(),
}));

vi.mock("@/contexts/CliStatusContext", () => ({
	useCliStatus: () => ({
		data: { copilot: cli.copilot },
		refreshCopilot: cli.refreshCopilot,
	}),
}));

const api = {
	installCopilotCliSilent: vi.fn(),
	getCopilotCliInstallations: vi.fn(),
	setCopilotCliActivePath: vi.fn(),
	createTerminal: vi.fn(),
	sendTerminalInput: vi.fn(),
	openExternal: vi.fn(),
};

function setCopilot(
	status: CopilotStatus,
	versionInfo: Record<string, unknown> | null = null,
	authStatus: { authenticated: boolean; username?: string } | null = null,
	lastChecked: Date | null = null,
) {
	cli.copilot = { status, versionInfo, authStatus, lastChecked };
}

function renderBadge(
	props: Parameters<typeof CopilotCliStatusBadge>[0] = {},
) {
	return render(
		<TooltipProvider>
			<CopilotCliStatusBadge {...props} />
		</TooltipProvider>,
	);
}

async function openPopover() {
	fireEvent.click(screen.getByRole("button", { name: /Copilot/ }));
	return screen.findByText("Copilot CLI");
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.getCopilotCliInstallations.mockResolvedValue({
		success: true,
		data: { installations: [] },
	});
	api.createTerminal.mockResolvedValue({ success: true });
	useProjectStore.setState({
		projects: [],
		selectedProjectId: null,
		activeProjectId: null,
	});
	useTerminalStore.setState({ terminals: [], activeTerminalId: null });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CopilotCliStatusBadge trigger", () => {
	it("shows the installed version", () => {
		setCopilot("installed", { installed: "1.2.0" });
		renderBadge();
		expect(
			screen.getByRole("button", { name: /Copilot \(1\.2\.0\)/ }),
		).toBeInTheDocument();
	});

	it("labels an update, a missing extension and a missing gh", () => {
		setCopilot("outdated");
		const { unmount } = renderBadge();
		expect(screen.getByRole("button", { name: /Copilot/ })).toHaveTextContent(
			"Update",
		);
		unmount();
		setCopilot("not-found");
		const second = renderBadge();
		expect(screen.getByRole("button", { name: /Copilot/ })).toHaveTextContent(
			"Install",
		);
		second.unmount();
		setCopilot("gh-missing");
		renderBadge();
		const trigger = screen.getByRole("button", { name: /Copilot/ });
		expect(trigger).toHaveTextContent("gh missing");
		expect(trigger.className).toContain("text-destructive");
	});

	it("shows only the icon when collapsed and reports its presence", () => {
		const presence = vi.fn();
		setCopilot("gh-missing");
		renderBadge({ isCollapsed: true, onPresenceChange: presence });
		expect(screen.getByRole("button")).not.toHaveTextContent("Copilot");
		expect(presence).toHaveBeenLastCalledWith("missing");
	});
});

describe("CopilotCliStatusBadge popover", () => {
	it("lists versions, path, the signed-in user and the docs link", async () => {
		setCopilot(
			"installed",
			{ installed: "1.2.0", ghVersion: "2.60.0", path: "/usr/bin/gh" },
			{ authenticated: true, username: "octo" },
			new Date(2026, 10, 14, 8, 0),
		);
		renderBadge();
		await openPopover();
		expect(screen.getByText("Installed")).toBeInTheDocument();
		expect(screen.getByText("2.60.0")).toBeInTheDocument();
		expect(screen.getByTitle("/usr/bin/gh")).toBeInTheDocument();
		expect(screen.getByText("octo")).toHaveClass("text-success");
		expect(screen.getByText("Last checked:")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Login" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(cli.refreshCopilot).toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: /View GitHub Copilot CLI Docs/ }),
		);
		expect(api.openExternal).toHaveBeenCalledWith(
			"https://docs.github.com/en/copilot/github-copilot-in-the-cli",
		);
	});

	it("names an authenticated account without a username", async () => {
		setCopilot("installed", { installed: "1.2.0" }, { authenticated: true });
		renderBadge();
		await openPopover();
		expect(screen.getByText("Authenticated")).toBeInTheDocument();
	});

	it("explains that gh is required and links to its site", async () => {
		setCopilot("gh-missing", { installed: "1.2.0" }, { authenticated: false });
		renderBadge();
		await openPopover();
		expect(screen.getByText("GitHub CLI not found")).toBeInTheDocument();
		expect(screen.getByText("Requires GitHub CLI (gh)")).toBeInTheDocument();
		// No version block and no login while gh itself is missing.
		expect(screen.queryByText("Copilot:")).toBeNull();
		expect(screen.queryByRole("button", { name: "Login" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "cli.github.com" }));
		expect(api.openExternal).toHaveBeenCalledWith("https://cli.github.com");
	});

	it("words the loading, missing and error states", async () => {
		setCopilot("loading", { installed: "1.2.0" });
		const first = renderBadge();
		await openPopover();
		expect(screen.getByText("Checking...")).toBeInTheDocument();
		expect(screen.queryByText("Copilot:")).toBeNull();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
		first.unmount();
		setCopilot("not-found");
		const second = renderBadge();
		await openPopover();
		expect(screen.getByText("Extension not installed")).toBeInTheDocument();
		second.unmount();
		setCopilot("error");
		renderBadge();
		await openPopover();
		expect(screen.getByText("Error")).toBeInTheDocument();
	});

	it("opens a gh login terminal for a signed-out account", async () => {
		const navigate = vi.fn();
		setCopilot("installed", { installed: "1.2.0" }, { authenticated: false });
		renderBadge({ onNavigateToTerminals: navigate });
		await openPopover();
		expect(screen.getByText("Not authenticated")).toHaveClass(
			"text-destructive",
		);
		fireEvent.click(screen.getByRole("button", { name: "Login" }));
		await waitFor(
			() =>
				expect(api.sendTerminalInput).toHaveBeenCalledWith(
					expect.stringMatching(/^cli-action-/),
					"gh auth login\n",
				),
			{ timeout: 2000 },
		);
		expect(navigate).toHaveBeenCalled();
		expect(useTerminalStore.getState().terminals[0]?.title).toBe("Copilot Auth");
	});

	it("survives a login whose terminal call throws", async () => {
		setCopilot("installed", { installed: "1.2.0" }, { authenticated: false });
		api.createTerminal.mockRejectedValue(new Error("no pty"));
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Login" }));
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
		expect(screen.getByText("Copilot CLI")).toBeInTheDocument();
	});
});

describe("CopilotCliStatusBadge install", () => {
	it("updates silently, then rechecks", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setCopilot("outdated", { installed: "1.0.0" });
		api.installCopilotCliSilent.mockResolvedValue({ success: true });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(cli.refreshCopilot).toHaveBeenCalledTimes(1));
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(cli.refreshCopilot).toHaveBeenCalledTimes(2);
	});

	it("turns a locked package into an actionable message", async () => {
		setCopilot("outdated", { installed: "1.0.0" });
		api.installCopilotCliSilent.mockResolvedValue({
			success: false,
			error: "copilot_pkg_locked: EPERM rename",
		});
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByText(/Update blocked/)).toBeInTheDocument();
		expect(screen.queryByText(/EPERM/)).toBeNull();
	});

	it("shows other silent errors, or a translated fallback", async () => {
		setCopilot("not-found");
		api.installCopilotCliSilent.mockResolvedValueOnce({
			success: false,
			error: "network unreachable",
		});
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("network unreachable")).toBeInTheDocument();
		api.installCopilotCliSilent.mockResolvedValueOnce({ success: false });
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("Installation failed")).toBeInTheDocument();
	});

	it("installs the extension in a terminal of the selected project when gh is missing from the silent path", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		useProjectStore.setState({
			projects: [{ id: "p2", name: "Api", path: "/work/api" } as never],
			selectedProjectId: "p2",
		});
		setCopilot("error");
		api.installCopilotCliSilent.mockResolvedValue({
			success: false,
			error: "gh_missing",
		});
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
		expect(api.createTerminal.mock.calls[0][0]).toMatchObject({
			cwd: "/work/api",
		});
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(api.sendTerminalInput).toHaveBeenCalledWith(
			expect.any(String),
			"gh copilot install\n",
		);
		await act(async () => {
			vi.advanceTimersByTime(15000);
		});
		expect(cli.refreshCopilot).toHaveBeenCalledTimes(2);
		expect(useTerminalStore.getState().terminals[0]?.title).toBe(
			"Copilot Install",
		);
	});

	it("runs gh copilot update in a terminal without the silent IPC", async () => {
		setCopilot("outdated", { installed: "1.0.0" });
		Object.assign(globalThis.electronAPI, { installCopilotCliSilent: undefined });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(
			() =>
				expect(api.sendTerminalInput).toHaveBeenCalledWith(
					expect.any(String),
					"gh copilot update\n",
				),
			{ timeout: 2000 },
		);
		expect(useTerminalStore.getState().terminals[0]?.title).toBe(
			"Copilot Update",
		);
	});

	it("says so when the terminal cannot be opened", async () => {
		setCopilot("not-found");
		Object.assign(globalThis.electronAPI, { installCopilotCliSilent: undefined });
		api.createTerminal.mockResolvedValue({ success: false });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(
			await screen.findByText("Could not open a terminal."),
		).toBeInTheDocument();
	});

	it("shows a thrown install error", async () => {
		setCopilot("not-found");
		api.installCopilotCliSilent.mockRejectedValueOnce(new Error("EACCES"));
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("EACCES")).toBeInTheDocument();
		api.installCopilotCliSilent.mockRejectedValueOnce("raw");
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("Installation failed")).toBeInTheDocument();
	});
});

describe("CopilotCliStatusBadge installation switch", () => {
	const installations = [
		{
			path: "/usr/bin/gh",
			version: "1.2.0",
			ghVersion: "2.60.0",
			source: "apt",
			isActive: true,
		},
		{
			path: "/home/dev/.local/bin/gh",
			version: null,
			source: "manual",
			isActive: false,
		},
	];

	async function pickSecond() {
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		const user = userEvent.setup();
		trigger.focus();
		await user.keyboard("[ArrowDown]");
		// Both paths end in bin/gh: the title keeps the full path apart.
		const [active, other] = await screen.findAllByRole("option");
		expect(active).toHaveTextContent(/^bin\/gh/);
		expect(active).toHaveAttribute("data-disabled");
		expect(active).toHaveTextContent("copilot v1.2.0 (gh 2.60.0) (apt) - Active");
		expect(screen.getByTitle("/home/dev/.local/bin/gh")).toBeInTheDocument();
		expect(other).toHaveTextContent("version unknown (manual)");
		await user.click(other);
		return screen.findByText("Switch gh CLI installation?");
	}

	beforeEach(() => {
		api.getCopilotCliInstallations.mockResolvedValue({
			success: true,
			data: { installations },
		});
		setCopilot("installed", { installed: "1.2.0" });
	});

	it("switches after confirmation and reloads the list", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.setCopilotCliActivePath.mockResolvedValue({ success: true });
		renderBadge();
		await openPopover();
		await pickSecond();
		expect(screen.getByText("/home/dev/.local/bin/gh")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		await waitFor(() =>
			expect(api.setCopilotCliActivePath).toHaveBeenCalledWith(
				"/home/dev/.local/bin/gh",
			),
		);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(cli.refreshCopilot).toHaveBeenCalled();
		expect(api.getCopilotCliInstallations).toHaveBeenCalledTimes(2);
	});

	it("shows a refusal, a translated fallback and a thrown error", async () => {
		api.setCopilotCliActivePath
			.mockResolvedValueOnce({ success: false, error: "not a gh binary" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("denied"))
			.mockRejectedValueOnce("EPERM");
		renderBadge();
		await openPopover();
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByText("not a gh binary")).toBeInTheDocument();
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(
			await screen.findByText("Could not switch the CLI installation."),
		).toBeInTheDocument();
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByText("denied")).toBeInTheDocument();
		// A rejection that is not an Error is worded, not shown raw.
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(
			await screen.findByText("Could not switch the CLI installation."),
		).toBeInTheDocument();
		expect(screen.queryByText("EPERM")).toBeNull();
	});

	it("says switching is unavailable without the IPC, and cancels cleanly", async () => {
		Object.assign(globalThis.electronAPI, { setCopilotCliActivePath: undefined });
		renderBadge();
		await openPopover();
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByText("Switch gh CLI installation?")).toBeNull(),
		);
		await pickSecond();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(
			await screen.findByText(
				"Switching the CLI installation is not available.",
			),
		).toBeInTheDocument();
	});

	it("hides the selector when the lookup fails", async () => {
		api.getCopilotCliInstallations.mockResolvedValueOnce({ success: false });
		const first = renderBadge();
		await openPopover();
		await waitFor(() =>
			expect(api.getCopilotCliInstallations).toHaveBeenCalled(),
		);
		expect(screen.queryByText("Switch Installation")).toBeNull();
		first.unmount();
		api.getCopilotCliInstallations.mockRejectedValueOnce(new Error("x"));
		renderBadge();
		await openPopover();
		await waitFor(() =>
			expect(api.getCopilotCliInstallations).toHaveBeenCalledTimes(2),
		);
		expect(screen.queryByRole("combobox")).toBeNull();
	});
});
