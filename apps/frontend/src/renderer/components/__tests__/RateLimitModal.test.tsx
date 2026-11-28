/**
 * @vitest-environment jsdom
 */
/**
 * The dialog shown when a terminal's Claude session hits its usage limit:
 * when usage comes back, switching the terminal to another account, adding an
 * account, the auto-switch setting, and the upgrade link.
 */
import type { RateLimitInfo } from "@shared/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { useAuthStore } from "../../stores/auth-store";
import { useClaudeProfileStore } from "../../stores/claude-profile-store";
import { RateLimitModal } from "../RateLimitModal";
import { Toaster } from "../ui/toaster";

const PROFILES = [
	{ id: "work", name: "Work", isDefault: true, createdAt: new Date() },
	{ id: "home", name: "Home", isDefault: false, createdAt: new Date(), description: "Personal plan" },
	{ id: "spare", name: "Spare", isDefault: false, createdAt: new Date() },
];

const api = {
	getClaudeProfiles: vi.fn(),
	getAutoSwitchSettings: vi.fn(),
	updateAutoSwitchSettings: vi.fn(),
	saveClaudeProfile: vi.fn(),
	switchClaudeProfile: vi.fn(),
};

function info(over: Partial<RateLimitInfo> = {}): RateLimitInfo {
	return {
		terminalId: "term-1",
		resetTime: "Dec 17 at 6am",
		detectedAt: new Date(),
		profileId: "work",
		...over,
	};
}

function profiles(list: typeof PROFILES = PROFILES, activeProfileId = list[0]?.id) {
	api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: list, activeProfileId } });
}

async function show(over: Partial<RateLimitInfo> = {}) {
	render(
		<>
			<RateLimitModal />
			<Toaster />
		</>,
	);
	act(() => useAuthStore.getState().rateLimit_showModal(info(over)));
	return screen.findByRole("dialog");
}

const NAME_FIELD = "Account name (e.g., Work, Personal)";

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	profiles();
	api.getAutoSwitchSettings.mockResolvedValue({ success: true, data: { autoSwitchOnRateLimit: false } });
	api.updateAutoSwitchSettings.mockResolvedValue({ success: true });
	api.saveClaudeProfile.mockResolvedValue({ success: true, data: { id: "new" } });
	api.switchClaudeProfile.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
	vi.spyOn(window, "open").mockImplementation(() => null);
	act(() => {
		useAuthStore.setState({
			rateLimit_isModalOpen: false,
			rateLimit_info: null,
			rateLimit_hasPending: false,
			rateLimit_pendingType: null,
		});
		useClaudeProfileStore.setState({ profiles: [], activeProfileId: "default", isSwitching: false });
	});
});

describe("RateLimitModal", () => {
	it("renders nothing without a rate limit", () => {
		const { container } = render(<RateLimitModal />);
		expect(container).toBeEmptyDOMElement();
		expect(api.getClaudeProfiles).not.toHaveBeenCalled();
	});

	it("says when usage comes back, on which account, and closes", async () => {
		const user = userEvent.setup();
		profiles(PROFILES, "home");
		const dialog = await show({ profileId: undefined });
		expect(within(dialog).getByText("AI Usage Limit Reached")).toBeInTheDocument();
		expect(await screen.findByText(/\(Profile: Home\)/)).toBeInTheDocument();
		expect(screen.getByText("Resets Dec 17 at 6am")).toBeInTheDocument();
		expect(screen.getByText("Your usage will be restored at this time")).toBeInTheDocument();
		const closes = screen.getAllByRole("button", { name: "Close" });
		await user.click(closes[closes.length - 1]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(useAuthStore.getState().rateLimit_hasPending).toBe(true);
	});

	it("does not name the default account, nor a reset it does not know", async () => {
		await show({ resetTime: "" });
		await screen.findByText("Switch Account");
		expect(screen.queryByText(/Profile:/)).toBeNull();
		expect(screen.queryByText(/^Resets/)).toBeNull();
	});

	it("offers to add an account when there is only one", async () => {
		profiles([PROFILES[0]]);
		await show();
		expect(await screen.findByText("Use Another Account")).toBeInTheDocument();
		expect(screen.getByText(/Add another AI provider subscription/)).toBeInTheDocument();
		expect(screen.getByText("Connect an AI provider account:")).toBeInTheDocument();
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
	});

	it("pre-selects the suggested account and keeps the one the user picks instead", async () => {
		const user = userEvent.setup();
		await show({ suggestedProfileId: "home" });
		expect(await screen.findByText(/Recommended:/)).toHaveTextContent("Recommended: Home has more capacity");
		const picker = screen.getByRole("button", { name: /^Home/ });
		expect(screen.getByText("Personal plan")).toBeInTheDocument();
		await user.click(picker);
		const menu = await screen.findByRole("menu");
		// The limited account is not offered.
		expect(within(menu).queryByRole("menuitem", { name: /Work/ })).toBeNull();
		expect(within(within(menu).getByRole("menuitem", { name: /Home/ })).getByLabelText("Recommended")).toBeInTheDocument();
		await user.click(within(menu).getByRole("menuitem", { name: /Spare/ }));
		// A re-render (here, the profiles loading again) must not undo the pick.
		act(() => useClaudeProfileStore.setState({ profiles: [...PROFILES] }));
		expect(await screen.findByRole("button", { name: /^Spare/ })).toBeInTheDocument();
		expect(screen.queryByText("Personal plan")).toBeNull();
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(1);
		expect(api.getAutoSwitchSettings).toHaveBeenCalledTimes(1);
	});

	it("waits for a pick when nothing is suggested", async () => {
		await show();
		expect(await screen.findByText(/You have other AI provider subscriptions/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Select account/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Switch" })).toBeDisabled();
	});

	it("switches the terminal to the picked account and clears the pending limit", async () => {
		const user = userEvent.setup();
		let finish!: (value: { success: boolean }) => void;
		api.switchClaudeProfile.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await show({ suggestedProfileId: "home" });
		await screen.findByText(/Recommended:/);
		await user.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByRole("button", { name: "Switching..." })).toBeDisabled();
		expect(api.switchClaudeProfile).toHaveBeenCalledWith("term-1", "home");
		await act(async () => finish({ success: true }));
		await waitFor(() => expect(useAuthStore.getState().rateLimit_hasPending).toBe(false));
		expect(useAuthStore.getState().rateLimit_isModalOpen).toBe(false);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(useClaudeProfileStore.getState().activeProfileId).toBe("home");
	});

	it("says when the switch did not happen and keeps the limit pending", async () => {
		const user = userEvent.setup();
		api.switchClaudeProfile.mockResolvedValueOnce({ success: false });
		await show({ suggestedProfileId: "home" });
		await screen.findByText(/Recommended:/);
		await user.click(screen.getByRole("button", { name: "Switch" }));
		expect(await screen.findByText("Failed to switch account")).toBeInTheDocument();
		expect(useAuthStore.getState().rateLimit_hasPending).toBe(true);
	});

	it("tells that it already switched to the suggested account", async () => {
		await show({ suggestedProfileId: "home", autoSwitchEnabled: true });
		expect(await screen.findByText("Auto-switching to Home")).toBeInTheDocument();
		expect(screen.getByText(/restart with your other account/)).toBeInTheDocument();
		expect(screen.queryByText(/^Resets/)).toBeNull();
		expect(screen.queryByText("Switch Account")).toBeNull();
		expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
	});

	it("turns auto-switch on, and says so and keeps it off when saving is refused or fails", async () => {
		const user = userEvent.setup();
		await show();
		const toggle = await screen.findByRole("switch", { name: "Auto-switch on rate limit" });
		await user.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		expect(api.updateAutoSwitchSettings).toHaveBeenCalledWith({ enabled: true, autoSwitchOnRateLimit: true });

		api.updateAutoSwitchSettings
			.mockResolvedValueOnce({ success: false, error: "locked" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("disk"));
		for (let attempt = 1; attempt <= 3; attempt++) {
			await user.click(toggle);
			await waitFor(() => expect(screen.getAllByText("Failed to save the auto-switch setting")).toHaveLength(1));
			await waitFor(() => expect(toggle).toBeEnabled());
			expect(toggle).toBeChecked();
		}
		expect(api.updateAutoSwitchSettings).toHaveBeenCalledTimes(4);
	});

	it("shows auto-switch as saved, and opens even when it cannot be read", async () => {
		api.getAutoSwitchSettings.mockResolvedValueOnce({ success: true, data: { autoSwitchOnRateLimit: true } });
		await show();
		await waitFor(() => expect(screen.getByRole("switch", { name: "Auto-switch on rate limit" })).toBeChecked());
		act(() => useAuthStore.getState().rateLimit_hideModal());
		api.getAutoSwitchSettings.mockRejectedValueOnce(new Error("locked"));
		act(() => useAuthStore.getState().rateLimit_showModal(info()));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		act(() => useAuthStore.getState().rateLimit_hideModal());
		api.getAutoSwitchSettings.mockResolvedValueOnce({ success: false });
		act(() => useAuthStore.getState().rateLimit_showModal(info()));
		await waitFor(() => expect(api.getAutoSwitchSettings).toHaveBeenCalledTimes(3));
		expect(screen.getByRole("switch", { name: "Auto-switch on rate limit" })).toBeChecked();
	});

	it("hides the auto-switch setting when every other account is the limited one", async () => {
		profiles([PROFILES[0], { ...PROFILES[0] }]);
		await show();
		await screen.findByText("Switch Account");
		expect(screen.queryByRole("switch")).toBeNull();
	});

	it("adds an account by name, then closes and explains how to sign it in", async () => {
		const user = userEvent.setup();
		await show();
		const name = await screen.findByPlaceholderText(NAME_FIELD);
		expect(screen.getByText("Add another account:")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
		await user.type(name, "  Side Gig {Enter}");
		await waitFor(() =>
			expect(api.saveClaudeProfile).toHaveBeenCalledWith(
				expect.objectContaining({ name: "Side Gig", configDir: "~/.claude-profiles/side-gig", isDefault: false }),
			),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// Radix also reads the toast out in a live region for a moment, so the
		// texts can be there twice.
		expect(
			(await screen.findAllByText('Profile "Side Gig" has been created.')).length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText(/Go to Settings > Integrations/).length).toBeGreaterThan(0);
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(2);
	});

	it("says when the account could not be added, refused or failed", async () => {
		const user = userEvent.setup();
		api.saveClaudeProfile
			.mockResolvedValueOnce({ success: false, error: "exists" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("io"));
		await show();
		const name = await screen.findByPlaceholderText(NAME_FIELD);
		await user.type(name, "Dup");
		for (let attempt = 1; attempt <= 3; attempt++) {
			await user.click(screen.getByRole("button", { name: "Add" }));
			await waitFor(() => expect(api.saveClaudeProfile).toHaveBeenCalledTimes(attempt));
			expect(await screen.findByText("Failed to add profile")).toBeInTheDocument();
			await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toBeEnabled());
		}
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.clear(name);
		await user.keyboard("{Enter}");
		expect(api.saveClaudeProfile).toHaveBeenCalledTimes(3);
	});

	it("focuses the new account field from the account menu, in any language", async () => {
		const user = userEvent.setup();
		await i18n.changeLanguage("fr");
		await show();
		await user.click(await screen.findByRole("button", { name: /Sélectionner|compte/i }));
		const items = await screen.findAllByRole("menuitem");
		await user.click(items[items.length - 1]);
		await waitFor(() => expect(screen.getByPlaceholderText(/Nom du compte/)).toHaveFocus());
	});

	it("gives the focus back to the menu button after a pick", async () => {
		const user = userEvent.setup();
		await show();
		const picker = await screen.findByRole("button", { name: /Select account/ });
		await user.click(picker);
		await user.click(await screen.findByRole("menuitem", { name: /Spare/ }));
		await waitFor(() => expect(screen.getByRole("button", { name: /^Spare/ })).toHaveFocus());
	});

	it("opens the upgrade page in a new window", async () => {
		await show();
		fireEvent.click(screen.getByRole("button", { name: "Upgrade subscription (opens in new window)" }));
		expect(window.open).toHaveBeenCalledWith("https://claude.ai/upgrade", "_blank");
	});

	it("forgets the pick and the typed name when closed", async () => {
		const user = userEvent.setup();
		await show();
		await user.type(await screen.findByPlaceholderText(NAME_FIELD), "Draft");
		await user.click(screen.getByRole("button", { name: /Select account/ }));
		await user.click(await screen.findByRole("menuitem", { name: /Spare/ }));
		act(() => useAuthStore.getState().rateLimit_hideModal());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		act(() => useAuthStore.getState().rateLimit_showModal(info()));
		expect(await screen.findByPlaceholderText(NAME_FIELD)).toHaveValue("");
		expect(screen.getByRole("button", { name: /Select account/ })).toBeInTheDocument();
	});
});
