/**
 * @vitest-environment jsdom
 */
/**
 * The dialog shown when a Claude operation (task, roadmap, changelog…) hits a
 * usage limit: what it says, switching account and retrying, adding an
 * account, and the auto-switch setting.
 */
import type { SDKRateLimitInfo } from "@shared/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/auth-store";
import { useClaudeProfileStore } from "../../stores/claude-profile-store";
import { SDKRateLimitModal } from "../SDKRateLimitModal";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

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
	setActiveClaudeProfile: vi.fn(),
	retryWithProfile: vi.fn(),
};

function info(over: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo {
	return {
		source: "task",
		projectId: "proj-1",
		taskId: "task-1",
		profileId: "work",
		detectedAt: new Date(),
		...over,
	};
}

function profiles(list = PROFILES) {
	api.getClaudeProfiles.mockResolvedValue({
		success: true,
		data: { profiles: list, activeProfileId: list[0]?.id },
	});
}

async function show(over: Partial<SDKRateLimitInfo> = {}) {
	render(<SDKRateLimitModal />);
	act(() => useAuthStore.getState().rateLimit_showSDKModal(info(over)));
	return screen.findByRole("dialog");
}

beforeEach(() => {
	vi.resetAllMocks();
	profiles();
	api.getAutoSwitchSettings.mockResolvedValue({
		success: true,
		data: { autoSwitchOnRateLimit: false },
	});
	api.updateAutoSwitchSettings.mockResolvedValue({ success: true });
	api.setActiveClaudeProfile.mockResolvedValue({ success: true });
	api.retryWithProfile.mockResolvedValue({ success: true });
	api.saveClaudeProfile.mockResolvedValue({ success: true, data: { id: "new" } });
	Object.assign(globalThis.electronAPI, api);
	vi.spyOn(window, "open").mockImplementation(() => null);
	act(() => {
		useAuthStore.getState().rateLimit_hideSDKModal();
		useAuthStore.setState({ rateLimit_sdkInfo: null } as never);
		useClaudeProfileStore.setState({ profiles: [], isSwitching: false });
	});
});

describe("SDKRateLimitModal", () => {
	it("renders nothing without a rate limit", () => {
		const { container } = render(<SDKRateLimitModal />);
		expect(container).toBeEmptyDOMElement();
	});

	it("names what was stopped and on which account, in the app's language", async () => {
		await show({ source: "roadmap", resetTime: "6am", limitType: "weekly" });
		expect(await screen.findByText(/\(Profile: Work\)/)).toBeInTheDocument();
		expect(screen.getByText(/Roadmap was interrupted/)).toBeInTheDocument();
		expect(screen.getByText(/The roadmap operation was stopped/)).toBeInTheDocument();
		expect(screen.getByText("Resets 6am")).toBeInTheDocument();
		expect(screen.getByText("Weekly limit - resets in about a week")).toBeInTheDocument();
	});

	it.each([
		["changelog", /Changelog was interrupted/],
		["ideation", /Ideation was interrupted/],
		["title-generator", /Title Generator was interrupted/],
		["other", /Claude was interrupted/],
		// A source this version does not know yet still gets a name.
		["newer-feature", /Claude was interrupted/],
	] as const)("names the %s source", async (source, text) => {
		await show({ source: source as SDKRateLimitInfo["source"], resetTime: "soon" });
		expect(screen.getByText(text)).toBeInTheDocument();
		expect(screen.getByText("Session limit - resets in a few hours")).toBeInTheDocument();
	});

	it("speaks of the user's account when the limited one is not known", async () => {
		profiles([]);
		await show({ profileId: "gone" });
		expect(screen.getByText(/because your account reached/)).toBeInTheDocument();
		expect(screen.getByText(/account \(Default\)/)).toBeInTheDocument();
		expect(screen.getByText(/Add another AI provider account to continue/)).toBeInTheDocument();
		expect(screen.getByText("Connect a Claude account:")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
	});

	it("tells about a swap that already happened, before or after the limit", async () => {
		await show({ wasAutoSwapped: true, swapReason: "proactive", swappedToProfile: { id: "home", name: "Home" } });
		expect(await screen.findByText(/switched from Work to Home before/)).toBeInTheDocument();
		act(() =>
			useAuthStore
				.getState()
				.rateLimit_showSDKModal(
					info({ wasAutoSwapped: true, swappedToProfile: { id: "home", name: "Home" } }),
				),
		);
		expect(await screen.findByText(/Rate limit hit on Work\. Automatically switched to Home/)).toBeInTheDocument();
	});

	it("pre-selects the suggested account and keeps the one the user picks instead", async () => {
		const user = userEvent.setup();
		await show({ suggestedProfile: { id: "home", name: "Home" } });
		expect(await screen.findByText(/Recommended:/)).toHaveTextContent("Recommended: Home has more capacity");
		const picker = screen.getByRole("button", { name: /^Home/ });
		expect(screen.getByText("Personal plan")).toBeInTheDocument();
		await user.click(picker);
		const home = await screen.findByRole("menuitem", { name: /Home/ });
		expect(within(home).getByLabelText("Recommended")).toBeInTheDocument();
		await user.click(await screen.findByRole("menuitem", { name: /Spare/ }));
		// A re-render (here, the profiles loading again) must not undo the pick.
		act(() => useClaudeProfileStore.setState({ profiles: [...PROFILES] }));
		expect(await screen.findByRole("button", { name: /^Spare/ })).toBeInTheDocument();
		expect(api.getAutoSwitchSettings).toHaveBeenCalledTimes(1);
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(1);
	});

	it("switches account, retries, and clears the pending limit", async () => {
		const user = userEvent.setup();
		await show({ suggestedProfile: { id: "home", name: "Home" } });
		await screen.findByText(/Recommended:/);
		await user.click(screen.getByRole("button", { name: /^Retry$/ }));
		await waitFor(() =>
			expect(api.retryWithProfile).toHaveBeenCalledWith({
				source: "task",
				projectId: "proj-1",
				taskId: "task-1",
				profileId: "home",
			}),
		);
		expect(api.setActiveClaudeProfile).toHaveBeenCalledWith("home");
		expect(useAuthStore.getState().rateLimit_hasPending).toBe(false);
	});

	it("keeps the limit pending when the retry is refused or fails", async () => {
		const user = userEvent.setup();
		api.retryWithProfile.mockResolvedValueOnce({ success: false }).mockRejectedValueOnce(new Error("busy"));
		await show({ suggestedProfile: { id: "home", name: "Home" } });
		await screen.findByText(/Recommended:/);
		const retry = screen.getByRole("button", { name: /^Retry$/ });
		await user.click(retry);
		await waitFor(() => expect(api.retryWithProfile).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByRole("button", { name: /^Retry$/ })).toBeEnabled());
		await user.click(screen.getByRole("button", { name: /^Retry$/ }));
		await waitFor(() => expect(api.retryWithProfile).toHaveBeenCalledTimes(2));
		expect(useAuthStore.getState().rateLimit_hasPending).toBe(true);
	});

	it("cannot retry an operation that belongs to no project", async () => {
		const user = userEvent.setup();
		await show({ projectId: undefined, suggestedProfile: { id: "home", name: "Home" } });
		await screen.findByText(/Recommended:/);
		await user.click(screen.getByRole("button", { name: /^Retry$/ }));
		expect(api.setActiveClaudeProfile).not.toHaveBeenCalled();
	});

	it("waits for a pick when nothing is suggested", async () => {
		await show();
		expect(await screen.findByText("Switch to another Claude account and retry the operation:")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Select account/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Retry$/ })).toBeDisabled();
	});

	it("turns auto-switch on and keeps it off when saving fails", async () => {
		const user = userEvent.setup();
		await show();
		const toggle = await screen.findByRole("switch", { name: "Auto-switch & retry on rate limit" });
		await user.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		expect(api.updateAutoSwitchSettings).toHaveBeenCalledWith({ enabled: true, autoSwitchOnRateLimit: true });
		api.updateAutoSwitchSettings.mockRejectedValueOnce(new Error("disk"));
		await user.click(toggle);
		await waitFor(() => expect(toggle).toBeEnabled());
		expect(toggle).toBeChecked();
	});

	it("shows auto-switch as saved, and opens even when it cannot be read", async () => {
		api.getAutoSwitchSettings.mockResolvedValueOnce({ success: true, data: { autoSwitchOnRateLimit: true } });
		await show();
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: "Auto-switch & retry on rate limit" })).toBeChecked(),
		);
		act(() => useAuthStore.getState().rateLimit_hideSDKModal());
		api.getAutoSwitchSettings.mockRejectedValueOnce(new Error("locked"));
		act(() => useAuthStore.getState().rateLimit_showSDKModal(info()));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		act(() => useAuthStore.getState().rateLimit_hideSDKModal());
		api.getAutoSwitchSettings.mockResolvedValueOnce({ success: false });
		act(() => useAuthStore.getState().rateLimit_showSDKModal(info({ taskId: "again" })));
		await waitFor(() => expect(api.getAutoSwitchSettings).toHaveBeenCalledTimes(3));
		expect(screen.getByRole("switch", { name: "Auto-switch & retry on rate limit" })).toBeChecked();
	});

	it("adds an account by name, then closes and explains how to sign it in", async () => {
		const user = userEvent.setup();
		await show();
		const name = await screen.findByPlaceholderText("Account name (e.g., Work, Personal)");
		expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
		await user.type(name, "  Side Gig {Enter}");
		await waitFor(() =>
			expect(api.saveClaudeProfile).toHaveBeenCalledWith(
				expect.objectContaining({ name: "Side Gig", configDir: "~/.claude-profiles/side-gig" }),
			),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ variant: "success", title: 'Profile "Side Gig" has been created.' }),
		);
	});

	it("says when the account could not be added, refused or failed", async () => {
		const user = userEvent.setup();
		api.saveClaudeProfile
			.mockResolvedValueOnce({ success: false, error: "exists" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("io"));
		await show();
		const name = await screen.findByPlaceholderText("Account name (e.g., Work, Personal)");
		await user.type(name, "Dup");
		for (let attempt = 1; attempt <= 3; attempt++) {
			await user.click(screen.getByRole("button", { name: "Add" }));
			await waitFor(() => expect(toast).toHaveBeenCalledTimes(attempt));
			expect(toast).toHaveBeenLastCalledWith(
				expect.objectContaining({ variant: "destructive", title: "Failed to add profile" }),
			);
		}
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.clear(name);
		await user.keyboard("{Enter}");
		expect(api.saveClaudeProfile).toHaveBeenCalledTimes(3);
	});

	it("focuses the new account field from the account menu", async () => {
		const user = userEvent.setup();
		await show();
		await user.click(await screen.findByRole("button", { name: /Select account/ }));
		await user.click(await screen.findByRole("menuitem", { name: /Add new account/ }));
		await waitFor(() =>
			expect(screen.getByPlaceholderText("Account name (e.g., Work, Personal)")).toHaveFocus(),
		);
	});

	it("opens the upgrade page from both buttons and closes", async () => {
		await show();
		fireEvent.click(screen.getByRole("button", { name: /Upgrade to Pro/ }));
		fireEvent.click(screen.getByRole("button", { name: /Upgrade Subscription/ }));
		expect(window.open).toHaveBeenCalledTimes(2);
		expect(window.open).toHaveBeenCalledWith("https://claude.ai/upgrade", "_blank");
		fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
