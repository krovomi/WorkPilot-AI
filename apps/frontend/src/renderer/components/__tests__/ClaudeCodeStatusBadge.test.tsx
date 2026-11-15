/**
 * @vitest-environment jsdom
 */
/**
 * The Claude Code badge of the sidebar: what it shows for each CLI state, and
 * what its install, version switch and installation switch actually do.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { ClaudeCodeStatusBadge } from "../ClaudeCodeStatusBadge";
import { TooltipProvider } from "../ui/tooltip";

type ClaudeStatus = "loading" | "installed" | "outdated" | "not-found" | "error";

const cli = vi.hoisted(() => ({
	claude: {
		status: "installed" as string,
		versionInfo: null as null | Record<string, unknown>,
		lastChecked: null as Date | null,
	},
	refreshClaude: vi.fn(),
}));

vi.mock("@/contexts/CliStatusContext", () => ({
	useCliStatus: () => ({
		data: { claude: cli.claude },
		refreshClaude: cli.refreshClaude,
	}),
}));

const api = {
	installClaudeCodeSilent: vi.fn(),
	getClaudeCodeVersions: vi.fn(),
	getClaudeCodeInstallations: vi.fn(),
	setClaudeCodeActivePath: vi.fn(),
	createTerminal: vi.fn(),
	sendTerminalInput: vi.fn(),
	openExternal: vi.fn(),
};

function setClaude(
	status: ClaudeStatus,
	versionInfo: Record<string, unknown> | null = null,
	lastChecked: Date | null = null,
) {
	cli.claude = { status, versionInfo, lastChecked };
}

function renderBadge(props: Parameters<typeof ClaudeCodeStatusBadge>[0] = {}) {
	return render(
		<TooltipProvider>
			<ClaudeCodeStatusBadge {...props} />
		</TooltipProvider>,
	);
}

async function openPopover() {
	fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
	return screen.findByText("Claude Code CLI");
}

async function chooseOption(trigger: HTMLElement, name: RegExp | string) {
	const user = userEvent.setup();
	trigger.focus();
	await user.keyboard("[ArrowDown]");
	const option = await screen.findByRole("option", { name });
	await user.click(option);
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.getClaudeCodeVersions.mockResolvedValue({
		success: true,
		data: { versions: ["2.1.0", "2.0.5", "v1.9.0"] },
	});
	api.getClaudeCodeInstallations.mockResolvedValue({
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

describe("ClaudeCodeStatusBadge trigger", () => {
	it("shows the installed version on the trigger", () => {
		setClaude("installed", { installed: "2.1.0" });
		renderBadge();
		expect(
			screen.getByRole("button", { name: /Claude Code \(2\.1\.0\)/ }),
		).toBeInTheDocument();
	});

	it("hides an unknown version and labels the update", () => {
		setClaude("outdated", { installed: "unknown" });
		renderBadge();
		const trigger = screen.getByRole("button", { name: /Claude Code/ });
		expect(trigger).toHaveTextContent(/^Claude CodeUpdate$/);
		expect(trigger.className).toContain("text-warning");
	});

	it("asks to install when the CLI is missing or broken", () => {
		setClaude("not-found");
		const { unmount } = renderBadge();
		expect(screen.getByRole("button", { name: /Claude Code/ })).toHaveTextContent(
			"Install",
		);
		unmount();
		setClaude("error");
		renderBadge();
		const trigger = screen.getByRole("button", { name: /Claude Code/ });
		expect(trigger).toHaveTextContent("Install");
		expect(trigger.className).toContain("text-destructive");
	});

	it("shows only the icon when the sidebar is collapsed", () => {
		setClaude("installed", { installed: "2.1.0" });
		renderBadge({ isCollapsed: true });
		expect(screen.getByRole("button")).not.toHaveTextContent("Claude Code");
	});

	it("reports where the CLI tools panel should place it", () => {
		const presence = vi.fn();
		setClaude("loading");
		const { rerender } = renderBadge({ onPresenceChange: presence });
		expect(presence).not.toHaveBeenCalled();
		setClaude("not-found");
		rerender(
			<TooltipProvider>
				<ClaudeCodeStatusBadge onPresenceChange={presence} />
			</TooltipProvider>,
		);
		expect(presence).toHaveBeenLastCalledWith("missing");
		setClaude("installed", { installed: "2.1.0" });
		rerender(
			<TooltipProvider>
				<ClaudeCodeStatusBadge onPresenceChange={presence} />
			</TooltipProvider>,
		);
		expect(presence).toHaveBeenLastCalledWith("installed");
	});
});

describe("ClaudeCodeStatusBadge popover", () => {
	it("lists the installed, latest and path details and refreshes on demand", async () => {
		setClaude(
			"installed",
			{ installed: "2.1.0", latest: "2.1.0", path: "/usr/local/bin/claude" },
			new Date(2026, 10, 14, 9, 30),
		);
		renderBadge();
		await openPopover();
		expect(screen.getByText("Installed")).toBeInTheDocument();
		expect(screen.getAllByText("2.1.0").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByTitle("/usr/local/bin/claude")).toBeInTheDocument();
		expect(screen.getByText(/Last checked/)).toBeInTheDocument();
		// No install button when it is up to date.
		expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(cli.refreshClaude).toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: /View Claude Code Changelog/ }),
		);
		expect(api.openExternal).toHaveBeenCalledWith(
			"https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
		);
	});

	it("hides an unknown latest version and disables refresh while checking", async () => {
		setClaude("loading", { installed: "2.1.0", latest: "unknown" });
		renderBadge();
		await openPopover();
		expect(screen.getAllByText("Checking Claude Code...").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Latest/)).toBeNull();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
	});

	it("says when the version list cannot be loaded", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.getClaudeCodeVersions.mockResolvedValue({ success: false });
		renderBadge();
		await openPopover();
		expect(await screen.findByText("Failed to load versions")).toBeInTheDocument();
	});

	it("says when the version list call throws", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.getClaudeCodeVersions.mockRejectedValue(new Error("ipc down"));
		renderBadge();
		await openPopover();
		expect(await screen.findByText("Failed to load versions")).toBeInTheDocument();
	});

	it("does not ask for versions when Claude is not installed", async () => {
		setClaude("not-found", null);
		renderBadge();
		await openPopover();
		expect(screen.getByText("Not installed")).toBeInTheDocument();
		expect(api.getClaudeCodeVersions).not.toHaveBeenCalled();
		expect(screen.queryByText("Switch Version")).toBeNull();
	});
});

describe("ClaudeCodeStatusBadge install", () => {
	it("updates silently and rechecks the version", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setClaude("outdated", { installed: "2.0.0", latest: "2.1.0" });
		api.installClaudeCodeSilent.mockResolvedValue({ success: true });
		renderBadge();
		await openPopover();
		expect(screen.getByText("Update available")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(cli.refreshClaude).toHaveBeenCalledTimes(1));
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(cli.refreshClaude).toHaveBeenCalledTimes(2);
		expect(api.createTerminal).not.toHaveBeenCalled();
	});

	it("shows a silent install error instead of opening a terminal", async () => {
		setClaude("outdated", { installed: "2.0.0" });
		api.installClaudeCodeSilent.mockResolvedValue({
			success: false,
			error: "npm exited with 1",
		});
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByText("npm exited with 1")).toBeInTheDocument();
		expect(api.createTerminal).not.toHaveBeenCalled();
	});

	it("falls back to a generic message when the silent install gives no reason", async () => {
		setClaude("error");
		api.installClaudeCodeSilent.mockResolvedValue({ success: false });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("Installation failed")).toBeInTheDocument();
	});

	it("installs in a new internal terminal of the active project when silent install is unavailable", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const navigate = vi.fn();
		useProjectStore.setState({
			projects: [
				{ id: "p1", name: "Demo", path: "/work/demo" } as never,
			],
			activeProjectId: "p1",
		});
		setClaude("not-found");
		api.installClaudeCodeSilent.mockResolvedValue({
			success: false,
			error: "silent_install_unavailable: not installed",
		});
		renderBadge({ onNavigateToTerminals: navigate });
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
		const options = api.createTerminal.mock.calls[0][0];
		expect(options).toMatchObject({ cwd: "/work/demo", projectPath: "/work/demo" });
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		const terminal = useTerminalStore.getState().terminals[0];
		expect(terminal).toMatchObject({ id: options.id, title: "Claude Code Install" });
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(api.sendTerminalInput).toHaveBeenCalledWith(
			options.id,
			"claude install --force latest\n",
		);
		await act(async () => {
			vi.advanceTimersByTime(30000);
		});
		expect(cli.refreshClaude).toHaveBeenCalledTimes(3);
	});

	it("names the terminal for an update and uses the home folder without a project", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setClaude("outdated", { installed: "2.0.0" });
		api.installClaudeCodeSilent = undefined as never;
		Object.assign(globalThis.electronAPI, { installClaudeCodeSilent: undefined });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
		expect(api.createTerminal.mock.calls[0][0]).toMatchObject({ cwd: "." });
		await waitFor(() =>
			expect(useTerminalStore.getState().terminals[0]?.title).toBe(
				"Claude Code Update",
			),
		);
		api.installClaudeCodeSilent = vi.fn();
	});

	it("explains when no terminal can be opened", async () => {
		setClaude("not-found");
		Object.assign(globalThis.electronAPI, { installClaudeCodeSilent: undefined });
		api.createTerminal.mockResolvedValue({ success: false, error: "no pty" });
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(
			await screen.findByText(/Could not open a terminal/),
		).toBeInTheDocument();
	});

	it("shows the error thrown by the install call", async () => {
		setClaude("not-found");
		api.installClaudeCodeSilent.mockRejectedValue(new Error("EACCES"));
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("EACCES")).toBeInTheDocument();
	});

	it("words a non-Error throw as a failed installation", async () => {
		setClaude("not-found");
		api.installClaudeCodeSilent.mockRejectedValue("boom");
		renderBadge();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		expect(await screen.findByText("Installation failed")).toBeInTheDocument();
	});
});

describe("ClaudeCodeStatusBadge version switch", () => {
	it("marks the current version, confirms, then installs the chosen one in a terminal", async () => {
		setClaude("installed", { installed: "v2.1.0" });
		renderBadge();
		await openPopover();
		await waitFor(() => expect(api.getClaudeCodeVersions).toHaveBeenCalled());
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		await chooseOption(trigger, /2\.0\.5/);
		expect(
			await screen.findByText("Switch to version 2.0.5?"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Open Terminal & Switch" }));
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
		await waitFor(
			() =>
				expect(api.sendTerminalInput).toHaveBeenCalledWith(
					expect.any(String),
					"claude install --force 2.0.5\n",
				),
			{ timeout: 2000 },
		);
		expect(useTerminalStore.getState().terminals[0]?.title).toBe(
			"Claude Code 2.0.5",
		);
	});

	it("disables the installed version in the list", async () => {
		setClaude("installed", { installed: "2.1.0" });
		renderBadge();
		await openPopover();
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		const user = userEvent.setup();
		trigger.focus();
		await user.keyboard("[ArrowDown]");
		const current = await screen.findByRole("option", { name: /2\.1\.0/ });
		expect(current).toHaveAttribute("data-disabled");
		expect(current).toHaveTextContent("(Current)");
	});

	it("cancels the switch without installing", async () => {
		setClaude("installed", { installed: "2.1.0" });
		renderBadge();
		await openPopover();
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		await chooseOption(trigger, /1\.9\.0/);
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByText(/Switch to version/)).toBeNull(),
		);
		expect(api.createTerminal).not.toHaveBeenCalled();
	});

	it("explains a version switch that cannot open a terminal", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.createTerminal.mockResolvedValue({ success: false });
		renderBadge();
		await openPopover();
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		await chooseOption(trigger, /2\.0\.5/);
		fireEvent.click(
			await screen.findByRole("button", { name: "Open Terminal & Switch" }),
		);
		expect(
			await screen.findByText(/Could not open a terminal/),
		).toBeInTheDocument();
	});

	it("shows the error thrown while switching versions", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.createTerminal.mockRejectedValue(new Error("pty crashed"));
		renderBadge();
		await openPopover();
		const trigger = await screen.findByRole("combobox");
		await waitFor(() => expect(trigger).not.toBeDisabled());
		await chooseOption(trigger, /2\.0\.5/);
		fireEvent.click(
			await screen.findByRole("button", { name: "Open Terminal & Switch" }),
		);
		expect(await screen.findByText("pty crashed")).toBeInTheDocument();
	});
});

describe("ClaudeCodeStatusBadge installation switch", () => {
	const installations = [
		{
			path: "/usr/local/bin/claude",
			version: "2.1.0",
			source: "npm",
			isActive: true,
		},
		{
			path: "C:\\Users\\dev\\.local\\bin\\claude.exe",
			version: null,
			source: "native",
			isActive: false,
		},
	];

	async function pickSecondInstallation() {
		const [, installTrigger] = await screen.findAllByRole("combobox");
		await waitFor(() => expect(installTrigger).not.toBeDisabled());
		await chooseOption(installTrigger, /bin\/claude\.exe/);
		return screen.findByText("Switch CLI installation?");
	}

	beforeEach(() => {
		api.getClaudeCodeInstallations.mockResolvedValue({
			success: true,
			data: { installations },
		});
	});

	it("lists installations by their last two path parts and switches after confirmation", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setClaude("installed", { installed: "2.1.0" });
		api.setClaudeCodeActivePath.mockResolvedValue({ success: true });
		renderBadge();
		await openPopover();
		expect(await screen.findByText("Switch Installation")).toBeInTheDocument();
		await pickSecondInstallation();
		expect(
			screen.getByText("C:\\Users\\dev\\.local\\bin\\claude.exe"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		await waitFor(() =>
			expect(api.setClaudeCodeActivePath).toHaveBeenCalledWith(
				"C:\\Users\\dev\\.local\\bin\\claude.exe",
			),
		);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(cli.refreshClaude).toHaveBeenCalled();
		expect(api.getClaudeCodeInstallations).toHaveBeenCalledTimes(2);
	});

	it("shows why the switch was refused", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.setClaudeCodeActivePath.mockResolvedValue({
			success: false,
			error: "not executable",
		});
		renderBadge();
		await openPopover();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByText("not executable")).toBeInTheDocument();
	});

	it("shows the error thrown by the switch", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.setClaudeCodeActivePath.mockRejectedValueOnce(new Error("denied"));
		renderBadge();
		await openPopover();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByText("denied")).toBeInTheDocument();
	});

	it("words a refusal without reason and a non-Error throw", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.setClaudeCodeActivePath
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce("EPERM");
		renderBadge();
		await openPopover();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(
			await screen.findByText("Could not switch the CLI installation."),
		).toBeInTheDocument();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		await waitFor(() => expect(api.setClaudeCodeActivePath).toHaveBeenCalledTimes(2));
		expect(
			await screen.findByText("Could not switch the CLI installation."),
		).toBeInTheDocument();
		expect(screen.queryByText("EPERM")).toBeNull();
	});

	it("says path switching is unavailable without the IPC", async () => {
		setClaude("installed", { installed: "2.1.0" });
		Object.assign(globalThis.electronAPI, { setClaudeCodeActivePath: undefined });
		renderBadge();
		await openPopover();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(
			await screen.findByText("Switching the CLI installation is not available."),
		).toBeInTheDocument();
	});

	it("keeps the installation when the switch is cancelled", async () => {
		setClaude("installed", { installed: "2.1.0" });
		renderBadge();
		await openPopover();
		await pickSecondInstallation();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByText("Switch CLI installation?")).toBeNull(),
		);
		expect(api.setClaudeCodeActivePath).not.toHaveBeenCalled();
	});

	it("hides the selector with a single installation and on a failed lookup", async () => {
		setClaude("installed", { installed: "2.1.0" });
		api.getClaudeCodeInstallations.mockResolvedValue({ success: false });
		const { unmount } = renderBadge();
		await openPopover();
		await waitFor(() =>
			expect(api.getClaudeCodeInstallations).toHaveBeenCalled(),
		);
		expect(screen.queryByText("Switch Installation")).toBeNull();
		unmount();
		api.getClaudeCodeInstallations.mockRejectedValue(new Error("x"));
		renderBadge();
		await openPopover();
		await waitFor(() =>
			expect(api.getClaudeCodeInstallations).toHaveBeenCalledTimes(2),
		);
		expect(screen.queryByText("Switch Installation")).toBeNull();
	});
});
