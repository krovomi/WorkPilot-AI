/**
 * @vitest-environment jsdom
 */
/**
 * The Claude token dialog: reuse an authenticated account, log in through the
 * browser, or paste a token; and the errors of each path.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvConfigModal } from "../EnvConfigModal";
import { TooltipProvider } from "../ui/tooltip";

const oauth = vi.hoisted(() => ({
	listener: null as null | ((info: { success: boolean }) => void),
}));

const api = {
	checkSourceToken: vi.fn(),
	getClaudeProfiles: vi.fn(),
	updateSourceEnv: vi.fn(),
	invokeClaudeSetup: vi.fn(),
	onTerminalOAuthToken: vi.fn(),
};

const work = {
	id: "work",
	name: "Work",
	oauthToken: "••••",
	email: "dev@example.test",
	isDefault: false,
};
const personal = {
	id: "personal",
	name: "Personal",
	oauthToken: "••••",
	isDefault: true,
};

function renderModal(props: Partial<Parameters<typeof EnvConfigModal>[0]> = {}) {
	const onOpenChange = vi.fn();
	const onConfigured = vi.fn();
	const view = render(
		<TooltipProvider>
			<EnvConfigModal
				open
				onOpenChange={onOpenChange}
				onConfigured={onConfigured}
				projectId="p1"
				{...props}
			/>
		</TooltipProvider>,
	);
	return { ...view, onOpenChange, onConfigured };
}

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.checkSourceToken.mockResolvedValue({
		success: true,
		data: { hasToken: false, sourcePath: "/app/backend" },
	});
	api.getClaudeProfiles.mockResolvedValue({
		success: true,
		data: { profiles: [work, personal, { id: "empty", name: "Empty", isDefault: false }] },
	});
	api.onTerminalOAuthToken.mockImplementation((cb) => {
		oauth.listener = cb;
		return () => {
			oauth.listener = null;
		};
	});
	Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("EnvConfigModal", () => {
	it("uses its own translated title when the caller gives none", async () => {
		renderModal();
		expect(screen.getByText("Claude Authentication Required")).toBeInTheDocument();
		expect(await screen.findByText("Select Account")).toBeInTheDocument();
	});

	it("shows the configured state when a token already exists", async () => {
		api.checkSourceToken.mockResolvedValue({ success: true, data: { hasToken: true } });
		renderModal({ title: "Ideas need Claude", description: "Sign in first" });
		expect(screen.getByText("Ideas need Claude")).toBeInTheDocument();
		expect(await screen.findByText("Token configured successfully")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: "Close" }).some((b) => b.textContent === "Close"),
		).toBe(true);
	});

	it("lists only authenticated accounts and picks the first one", async () => {
		renderModal();
		expect(
			await screen.findByText(
				"You have 2 authenticated Claude accounts. Select one to use:",
			),
		).toBeInTheDocument();
		expect(screen.getByText("dev@example.test")).toBeInTheDocument();
		expect(screen.getByText("(Default)")).toBeInTheDocument();
		expect(screen.queryByText("Empty")).toBeNull();
	});

	it("does not reload when another account is picked", async () => {
		renderModal();
		await screen.findByText("Select Account");
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
		await act(async () => {});
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(1);
		expect(api.checkSourceToken).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Select Account")).toBeInTheDocument();
	});

	it("writes the chosen account into the .env by id, then closes", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.updateSourceEnv.mockResolvedValue({ success: true });
		const { onConfigured, onOpenChange } = renderModal();
		await screen.findByText("Select Account");
		fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
		fireEvent.click(screen.getByRole("button", { name: "Use This Account" }));
		expect(await screen.findByText("Token configured successfully")).toBeInTheDocument();
		expect(api.updateSourceEnv).toHaveBeenCalledWith({ claudeProfileId: "personal" });
		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(onConfigured).toHaveBeenCalled();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows why the account could not be used", async () => {
		api.updateSourceEnv
			.mockResolvedValueOnce({ success: false, error: "env read-only" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("ipc"))
			.mockRejectedValueOnce("raw");
		renderModal();
		await screen.findByText("Select Account");
		for (const message of ["env read-only", "Could not save the token.", "ipc", "An unknown error occurred"]) {
			fireEvent.click(screen.getByRole("button", { name: "Use This Account" }));
			expect(await screen.findByText(message)).toBeInTheDocument();
		}
	});

	it("refuses an account that carries no token", async () => {
		api.getClaudeProfiles.mockResolvedValue({
			success: true,
			data: { profiles: [{ id: "cfg", name: "Config dir", isDefault: true, configDir: "/home/.claude" }] },
		});
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Use This Account" }));
		expect(
			await screen.findByText("The selected account has no valid token."),
		).toBeInTheDocument();
		expect(api.updateSourceEnv).not.toHaveBeenCalled();
	});

	it("starts the browser login and finishes when the terminal reports the token", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
		api.invokeClaudeSetup.mockResolvedValue({ success: true });
		const { onConfigured } = renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Authenticate with Browser" }));
		expect(await screen.findByText("Waiting for authentication...")).toBeInTheDocument();
		expect(api.invokeClaudeSetup).toHaveBeenCalledWith("p1");
		await act(async () => {
			await oauth.listener?.({ success: false });
		});
		expect(screen.getByText("Waiting for authentication...")).toBeInTheDocument();
		await act(async () => {
			await oauth.listener?.({ success: true });
		});
		expect(await screen.findByText("Token configured successfully")).toBeInTheDocument();
		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(onConfigured).toHaveBeenCalled();
	});

	it("offers to add another account next to existing ones", async () => {
		api.invokeClaudeSetup.mockResolvedValue({ success: false, error: "claude not found" });
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Authenticate New Account" }));
		expect(await screen.findByText("claude not found")).toBeInTheDocument();
	});

	it("explains a browser login that cannot start", async () => {
		api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
		api.invokeClaudeSetup
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("pty"))
			.mockRejectedValueOnce("raw");
		renderModal();
		for (const message of ["Could not start the authentication.", "pty", "Could not start the authentication."]) {
			fireEvent.click(await screen.findByRole("button", { name: "Authenticate with Browser" }));
			expect(await screen.findByText(message)).toBeInTheDocument();
		}
	});

	it("needs a project for the browser login", async () => {
		api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
		renderModal({ projectId: undefined });
		fireEvent.click(await screen.findByRole("button", { name: "Authenticate with Browser" }));
		expect(await screen.findByText("Select a project first.")).toBeInTheDocument();
		expect(api.invokeClaudeSetup).not.toHaveBeenCalled();
	});

	it("saves a pasted token and clears it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.updateSourceEnv.mockResolvedValue({ success: true });
		const { onOpenChange } = renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Enter token manually/ }));
		expect(screen.getByText("/app/backend/.env")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Copy the command" }));
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("claude setup-token");
		const input = screen.getByLabelText("Claude Code OAuth Token");
		expect(input).toHaveAttribute("type", "password");
		fireEvent.click(screen.getByRole("button", { name: "Show token" }));
		expect(input).toHaveAttribute("type", "text");
		fireEvent.change(input, { target: { value: "  sk-ant-oat-123  " } });
		fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
		expect(await screen.findByText("Token configured successfully")).toBeInTheDocument();
		expect(api.updateSourceEnv).toHaveBeenCalledWith({ claudeOAuthToken: "sk-ant-oat-123" });
		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows why a pasted token was not saved", async () => {
		api.updateSourceEnv
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("EACCES"));
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Enter token manually/ }));
		fireEvent.change(screen.getByLabelText("Claude Code OAuth Token"), {
			target: { value: "tok" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
		expect(await screen.findByText("Could not save the token.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
		expect(await screen.findByText("EACCES")).toBeInTheDocument();
	});

	it("names the default .env place when the backend gives no path", async () => {
		api.checkSourceToken.mockResolvedValue({ success: true, data: { hasToken: false } });
		api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Enter token manually/ }));
		expect(screen.getByText("auto-claude/.env")).toBeInTheDocument();
	});

	it("reports a failed token check, a thrown one, and closes on cancel", async () => {
		api.checkSourceToken.mockResolvedValueOnce({ success: false, error: "no backend" });
		const first = renderModal();
		expect(await screen.findByText("no backend")).toBeInTheDocument();
		first.unmount();
		api.checkSourceToken.mockResolvedValueOnce({ success: false });
		const second = renderModal();
		expect(await screen.findByText("Could not check the token.")).toBeInTheDocument();
		second.unmount();
		api.checkSourceToken.mockRejectedValueOnce(new Error("down"));
		const { onOpenChange } = renderModal();
		expect(await screen.findByText("down")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
