/**
 * @vitest-environment jsdom
 */
/**
 * The usage badge of the top bar: what it shows for each provider and state,
 * how it fetches (deduplicated, retried, polled), and the account switch.
 */
import type { ProfileUsageSummary, UsageSnapshot } from "@shared/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageIndicator } from "../UsageIndicator";

const state = vi.hoisted(() => ({
	provider: "anthropic",
	context: null as null | { percentUsed: number; model: string },
}));

vi.mock("../../hooks/useEffectiveUsageProvider", () => ({
	useEffectiveUsageProvider: () => state.provider,
}));
vi.mock("../../hooks/useContextUsage", () => ({
	useContextUsage: () => state.context,
}));

type UsageListener = (snapshot: UsageSnapshot) => void;
type AllListener = (all: { allProfiles: ProfileUsageSummary[] }) => void;

const listeners: { usage: UsageListener[]; all: AllListener[] } = { usage: [], all: [] };

const api = {
	requestUsageUpdate: vi.fn(),
	requestAllProfilesUsage: vi.fn(),
	onUsageUpdated: vi.fn(),
	onAllProfilesUsageUpdated: vi.fn(),
	getClaudeProfiles: vi.fn(),
	setActiveClaudeProfile: vi.fn(),
};

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		profileId: "p1",
		profileName: "Ada Lovelace",
		profileEmail: "ada@example.com",
		sessionPercent: 42.4,
		weeklyPercent: 71,
		fetchedAt: new Date(),
		...over,
	} as UsageSnapshot;
}

function profile(over: Partial<ProfileUsageSummary> = {}): ProfileUsageSummary {
	return {
		profileId: "p2",
		profileName: "Grace Hopper",
		profileEmail: "grace@example.com",
		sessionPercent: 10,
		weeklyPercent: 20,
		isAuthenticated: true,
		isRateLimited: false,
		availabilityScore: 80,
		isActive: false,
		...over,
	} as ProfileUsageSummary;
}

function allProfiles(profiles: ProfileUsageSummary[]) {
	return { success: true, data: { allProfiles: profiles } };
}

function trigger() {
	return screen.getByRole("button", { name: "Usage status" });
}

async function openPopover() {
	fireEvent.click(await screen.findByRole("button", { name: "Usage status" }));
	return screen.findByText("Usage Breakdown");
}

beforeEach(() => {
	vi.resetAllMocks();
	state.provider = "anthropic";
	state.context = null;
	listeners.usage = [];
	listeners.all = [];
	api.requestUsageUpdate.mockResolvedValue({ success: true, data: snapshot() });
	api.requestAllProfilesUsage.mockResolvedValue(allProfiles([]));
	api.onUsageUpdated.mockImplementation((cb: UsageListener) => {
		listeners.usage.push(cb);
		return vi.fn();
	});
	api.onAllProfilesUsageUpdated.mockImplementation((cb: AllListener) => {
		listeners.all.push(cb);
		return vi.fn();
	});
	api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
	api.setActiveClaudeProfile.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("UsageIndicator badge", () => {
	it("loads, then shows the session and weekly percentages", async () => {
		render(<UsageIndicator />);
		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(await screen.findByTitle("Session usage")).toHaveTextContent("42");
		expect(screen.getByTitle("Weekly usage")).toHaveTextContent("71");
		expect(api.requestUsageUpdate).toHaveBeenCalledWith("anthropic");
	});

	it("shows a dash for a weekly window the provider does not report", async () => {
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ weeklyPercent: -1 }),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("Weekly usage")).toHaveTextContent("–");
		await openPopover();
		expect(screen.getByText("N/A")).toBeInTheDocument();
	});

	it("says a provider it cannot track is not supported, without asking for usage", async () => {
		state.provider = "someone-else";
		render(<UsageIndicator />);
		expect(await screen.findByRole("button", { name: "Usage data unavailable" })).toHaveTextContent(
			"N/A",
		);
		expect(api.requestUsageUpdate).not.toHaveBeenCalled();
	});

	it("points OpenAI without data to its billing page, without debug details", async () => {
		state.provider = "openai";
		api.requestUsageUpdate.mockResolvedValue({ success: true, data: null });
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		vi.useRealTimers();
		const badge = screen.getByRole("button", { name: "Usage data unavailable" });
		fireEvent.focus(badge);
		const help = await screen.findAllByText(/billing-enabled organization/);
		expect(help.length).toBeGreaterThan(0);
		expect(screen.queryByText(/Debug detected profiles/)).toBeNull();
		expect(screen.queryByText(/Selected provider/)).toBeNull();
	});

	it("retries an empty answer twice, then gives up without data", async () => {
		api.requestUsageUpdate.mockResolvedValue({ success: false });
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6000);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
		const badge = screen.getByText("N/A").closest("button") as HTMLElement;
		fireEvent.focus(badge);
		expect((await screen.findAllByText(/claude\.ai\/settings/)).length).toBeGreaterThan(0);
	});

	it("ignores an answer for another provider and retries", async () => {
		api.requestUsageUpdate
			.mockResolvedValueOnce({ success: true, data: snapshot({ providerName: "openai" }) })
			.mockResolvedValue({ success: true, data: snapshot({ sessionPercent: 5 }) });
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		vi.useRealTimers();
		expect(screen.getByTitle("Session usage")).toHaveTextContent("5");
	});

	it("retries a request that times out, after a longer pause", async () => {
		api.requestUsageUpdate.mockReturnValue(new Promise<never>(() => undefined));
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000 + 10_000 + 20_000);
		});
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(3);
	});

	it("stops loading when the request fails for another reason", async () => {
		api.requestUsageUpdate.mockRejectedValue(new Error("ipc closed"));
		render(<UsageIndicator />);
		expect(await screen.findByText("N/A")).toBeInTheDocument();
		expect(api.requestUsageUpdate).toHaveBeenCalledTimes(1);
	});

	it("takes pushed snapshots for its provider only", async () => {
		api.requestUsageUpdate.mockResolvedValue({ success: false });
		render(<UsageIndicator />);
		await waitFor(() => expect(listeners.usage.length).toBeGreaterThan(0));
		const push = listeners.usage[listeners.usage.length - 1];
		act(() => push(snapshot({ providerName: "copilot", sessionPercent: 99 })));
		expect(screen.queryByTitle("Session usage")).toBeNull();
		act(() => push(snapshot({ sessionPercent: 12 })));
		expect(screen.getByTitle("Session usage")).toHaveTextContent("12");
	});

	it("rejects pushed snapshots while the provider is not known yet", async () => {
		state.provider = "";
		render(<UsageIndicator />);
		await waitFor(() => expect(listeners.usage.length).toBeGreaterThan(0));
		act(() => listeners.usage[listeners.usage.length - 1](snapshot()));
		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(api.requestUsageUpdate).not.toHaveBeenCalled();
	});

	it("starts over when its provider is switched elsewhere in the app", async () => {
		render(<UsageIndicator />);
		await screen.findByTitle("Session usage");
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ sessionPercent: 64 }),
		});
		act(() => {
			globalThis.dispatchEvent(
				new CustomEvent("providerChanged", { detail: { provider: "openai" } }),
			);
		});
		expect(screen.getByTitle("Session usage")).toHaveTextContent("42");
		act(() => {
			globalThis.dispatchEvent(
				new CustomEvent("providerChanged", { detail: { provider: "anthropic" } }),
			);
		});
		expect(await screen.findByTitle("Session usage")).toHaveTextContent("64");
	});

	it("refreshes every 30 seconds and says when it last did", async () => {
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		const calls = api.requestUsageUpdate.mock.calls.length;
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ sessionPercent: 88 }),
		});
		api.requestAllProfilesUsage.mockResolvedValue(
			allProfiles([profile({ isActive: true, needsReauthentication: true }), profile()]),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(api.requestUsageUpdate.mock.calls.length).toBe(calls + 1);
		fireEvent.click(trigger());
		expect(screen.getByText("Updating...")).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(screen.getByText("0 min ago")).toBeInTheDocument();
		expect(screen.getByTitle("Session usage")).toHaveTextContent("88");
		expect(screen.getByText("Other Accounts")).toBeInTheDocument();
	});

	it("keeps polling when the other accounts cannot be read", async () => {
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		api.requestAllProfilesUsage.mockRejectedValue(new Error("busy"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(31_000);
		});
		expect(screen.getByTitle("Session usage")).toHaveTextContent("42");
	});

	it("does not poll a provider it cannot track", async () => {
		state.provider = "someone-else";
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(api.requestUsageUpdate).not.toHaveBeenCalled();
	});

	it("stops listening when it is removed", async () => {
		const unsubscribe = vi.fn();
		const unsubscribeAll = vi.fn();
		api.onUsageUpdated.mockReturnValue(unsubscribe);
		api.onAllProfilesUsageUpdated.mockReturnValue(unsubscribeAll);
		const view = render(<UsageIndicator />);
		await screen.findByTitle("Session usage");
		fireEvent.mouseEnter(trigger());
		view.unmount();
		expect(unsubscribe).toHaveBeenCalled();
		expect(unsubscribeAll).toHaveBeenCalled();
	});
});

describe("UsageIndicator states", () => {
	it("asks to sign in again when the active account needs it and has no data", async () => {
		api.requestUsageUpdate.mockResolvedValue({ success: false });
		api.requestAllProfilesUsage.mockResolvedValue(
			allProfiles([profile({ isActive: true, needsReauthentication: true })]),
		);
		const opened = vi.fn();
		globalThis.addEventListener("open-app-settings", opened);
		vi.useFakeTimers();
		render(<UsageIndicator />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(screen.getByText("Re-authentication required")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Re-authenticate/ }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("accounts");
		globalThis.removeEventListener("open-app-settings", opened);
	});

	it("follows pushed account lists, including a re-authentication that clears", async () => {
		render(<UsageIndicator />);
		await screen.findByTitle("Session usage");
		await waitFor(() => expect(listeners.all.length).toBeGreaterThan(0));
		const push = listeners.all[listeners.all.length - 1];
		act(() => push({ allProfiles: [profile({ isActive: true }), profile()] }));
		await openPopover();
		expect(screen.getByText("Other Accounts")).toBeInTheDocument();
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
	});

	it("marks a snapshot that needs re-authentication", async () => {
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ needsReauthentication: true }),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("Needs re-authentication")).toHaveTextContent("!");
		await openPopover();
		expect(screen.getByText("Re-authentication required")).toBeInTheDocument();
		expect(screen.getByText("Needs re-auth")).toBeInTheDocument();
	});

	it("shows dashes, not a made-up 0 %, for an unmeasured provider", async () => {
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ usageUnmeasured: true }),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("Not measured")).toHaveTextContent("–│–");
		await openPopover();
		expect(screen.getByText(/does not report a quota/)).toBeInTheDocument();
	});

	it("says when each window resets, with its translated name", async () => {
		const inThreeHours = new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString();
		api.requestUsageUpdate
			.mockResolvedValueOnce({
				success: true,
				data: snapshot({
					sessionResetTimestamp: inThreeHours,
					weeklyResetTimestamp: "not a date",
					weeklyResetTime: "Monday 9:00",
					usageWindows: { sessionWindowLabel: "5-hour window", weeklyWindowLabel: "7-day window" },
				} as Partial<UsageSnapshot>),
			})
			.mockResolvedValue({
				success: true,
				data: snapshot({ sessionResetTimestamp: "not a date", sessionResetTime: "Unknown", weeklyResetTime: "Friday" }),
			});
		const first = render(<UsageIndicator />);
		await openPopover();
		expect(screen.getByText(/^Resets in 3/)).toBeInTheDocument();
		expect(screen.getByText("Monday 9:00")).toBeInTheDocument();
		expect(screen.queryByText("Session")).toBeNull();
		first.unmount();
		render(<UsageIndicator />);
		await openPopover();
		expect(screen.queryByText("Unknown")).toBeNull();
		expect(screen.getByText("Friday")).toBeInTheDocument();
		expect(screen.getByText("Session")).toBeInTheDocument();
	});

	it("shows the month's OpenAI API cost and its details", async () => {
		state.provider = "openai";
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({
				providerName: "openai",
				weeklyUsageValue: 12.5,
				openaiUsageDetails: {
					completions: { data: [{ model: "gpt-x", n_input_tokens_total: 3, n_output_tokens_total: 4 }] },
					cost: { data: [{ model: "gpt-x", cost_usd: 1.234 }, { model: "gpt-y" }] },
					embeddings: { data: [{ model: "embed-1", n_input_tokens_total: 9 }, { model: "embed-2" }] },
					moderations: { count: 2 },
				},
			} as Partial<UsageSnapshot>),
		});
		render(<UsageIndicator />);
		const cost = await screen.findByTitle("OpenAI Cost (current month)");
		expect(cost).toHaveTextContent("$12.5");
		await openPopover();
		expect(screen.getByText("View OpenAI dashboard")).toBeInTheDocument();
		expect(screen.getByText("gpt-x: 3 in, 4 out")).toBeInTheDocument();
		expect(screen.getByText(/gpt-x: \$\s*1\.23/)).toBeInTheDocument();
		expect(screen.getByText(/gpt-y: \$\s*0\.00/)).toBeInTheDocument();
		expect(screen.getByText("embed-1: 9")).toBeInTheDocument();
		expect(screen.getByText("embed-2: 0")).toBeInTheDocument();
		expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
	});

	it("shows a dash when the OpenAI cost is not known", async () => {
		state.provider = "openai";
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({
				providerName: "openai",
				openaiUsageDetails: { completions: {}, cost: { data: [] }, embeddings: {} },
			} as unknown as Partial<UsageSnapshot>),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("OpenAI Cost (current month)")).toHaveTextContent("$–");
		await openPopover();
		expect(screen.getAllByText("No data")).toHaveLength(3);
	});

	it("says where ChatGPT plan limits come from", async () => {
		state.provider = "openai";
		api.requestUsageUpdate
			.mockResolvedValueOnce({
				success: true,
				data: snapshot({
					providerName: "openai",
					openaiSubscription: { source: "codex-session-log", observedAt: "2026-11-15T08:00:00Z" },
				} as Partial<UsageSnapshot>),
			})
			.mockResolvedValue({
				success: true,
				data: snapshot({
					providerName: "openai",
					openaiSubscription: { source: "chatgpt-usage-api", observedAt: "2026-11-15T08:00:00Z" },
				} as Partial<UsageSnapshot>),
			});
		const first = render(<UsageIndicator />);
		await openPopover();
		expect(screen.getByText(/last recorded by Codex CLI/)).toBeInTheDocument();
		first.unmount();
		render(<UsageIndicator />);
		await openPopover();
		expect(screen.getByText("ChatGPT plan limits, as reported by ChatGPT.")).toBeInTheDocument();
	});

	it("shows Copilot's context use first, then its premium quota, then its tokens", async () => {
		state.provider = "copilot";
		state.context = { percentUsed: 37.4, model: "gpt-5" };
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({
				providerName: "copilot",
				sessionPercent: 55.6,
				copilotUsageDetails: { scope: "personal-quotas", premiumRequestsUnlimited: false },
			} as Partial<UsageSnapshot>),
		});
		const first = render(<UsageIndicator />);
		expect(await screen.findByTitle("Context used — gpt-5")).toHaveTextContent("37%");
		first.unmount();

		state.context = null;
		const second = render(<UsageIndicator />);
		expect(await screen.findByTitle("Copilot Premium Requests")).toHaveTextContent("56%");
		second.unmount();

		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({
				providerName: "copilot",
				copilotUsageDetails: { scope: "aggregated-metrics", totalTokens: 1500 },
			} as Partial<UsageSnapshot>),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("Tokens consumed (Copilot)")).toHaveTextContent("1.5K");
	});

	it("colours Copilot's context use by how full it is", async () => {
		state.provider = "copilot";
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ providerName: "copilot" }),
		});
		for (const [percent, colour] of [
			[95, "text-destructive"],
			[75, "text-orange-500"],
		] as const) {
			state.context = { percentUsed: percent, model: "m" };
			const view = render(<UsageIndicator />);
			expect(await screen.findByTitle("Context used — m")).toHaveClass(colour);
			view.unmount();
		}
	});

	it("shows zero Copilot tokens when none are reported", async () => {
		state.provider = "copilot";
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ providerName: "copilot" }),
		});
		render(<UsageIndicator />);
		expect(await screen.findByTitle("Tokens consumed (Copilot)")).toHaveTextContent("0");
	});
});

describe("UsageIndicator popover and accounts", () => {
	it("opens on hover after a short delay and closes after leaving", async () => {
		render(<UsageIndicator />);
		await screen.findByTitle("Session usage");
		vi.useFakeTimers();
		fireEvent.mouseEnter(trigger());
		fireEvent.mouseLeave(trigger());
		fireEvent.mouseEnter(trigger());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(150);
		});
		expect(screen.getByText("Usage Breakdown")).toBeInTheDocument();
		fireEvent.mouseLeave(trigger());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300);
		});
		expect(screen.queryByText("Usage Breakdown")).toBeNull();
	});

	it("stays open while pinned, and a second click closes it", async () => {
		render(<UsageIndicator />);
		await openPopover();
		vi.useFakeTimers();
		fireEvent.mouseLeave(trigger());
		fireEvent.mouseEnter(trigger());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(screen.getByText("Usage Breakdown")).toBeInTheDocument();
		fireEvent.click(trigger());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.queryByText("Usage Breakdown")).toBeNull();
	});

	it("closes on Escape", async () => {
		render(<UsageIndicator />);
		await openPopover();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("Usage Breakdown")).toBeNull());
	});

	it("names the signed-in Claude account and opens the accounts settings", async () => {
		api.getClaudeProfiles.mockResolvedValue({
			success: true,
			data: {
				profiles: [
					{ id: "x", name: "Unused", isAuthenticated: false },
					{ id: "y", name: "Team Seat", email: "seat@example.com", isAuthenticated: true },
				],
			},
		});
		const opened = vi.fn();
		globalThis.addEventListener("open-app-settings", opened);
		render(<UsageIndicator />);
		await openPopover();
		const account = await screen.findByRole("button", { name: /seat@example\.com/ });
		expect(account).toHaveTextContent("TS");
		fireEvent.click(account);
		await waitFor(() => expect(opened).toHaveBeenCalled());
		expect(screen.queryByText("Usage Breakdown")).toBeNull();
		globalThis.removeEventListener("open-app-settings", opened);
	});

	it("falls back to the snapshot's account, then to placeholder initials", async () => {
		api.getClaudeProfiles
			.mockResolvedValueOnce({ success: true, data: { profiles: [{ id: "x" }] } })
			.mockRejectedValueOnce(new Error("locked"));
		api.requestUsageUpdate
			.mockResolvedValueOnce({ success: true, data: snapshot({ profileName: "Solo", profileEmail: undefined }) })
			.mockResolvedValue({ success: true, data: snapshot({ profileName: " ", profileEmail: undefined }) });
		const first = render(<UsageIndicator />);
		await openPopover();
		expect(screen.getByRole("button", { name: /Active Account/ })).toHaveTextContent("SO");
		first.unmount();
		render(<UsageIndicator />);
		await openPopover();
		expect(screen.getByRole("button", { name: /Active Account/ })).toHaveTextContent("UN");
	});

	it("does not look up Claude accounts for another provider", async () => {
		state.provider = "copilot";
		api.requestUsageUpdate.mockResolvedValue({
			success: true,
			data: snapshot({ providerName: "copilot" }),
		});
		render(<UsageIndicator />);
		await screen.findByTitle("Tokens consumed (Copilot)");
		expect(api.getClaudeProfiles).not.toHaveBeenCalled();
	});

	it("switches to another account at once and keeps it when the switch succeeds", async () => {
		api.requestAllProfilesUsage.mockResolvedValue(allProfiles([profile()]));
		render(<UsageIndicator />);
		await openPopover();
		fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
		await waitFor(() => expect(api.setActiveClaudeProfile).toHaveBeenCalledWith("p2"));
		expect(screen.getByRole("button", { name: /Active Account/ })).toHaveTextContent(
			"grace@example.com",
		);
		expect(screen.getByRole("button", { name: /Ada Lovelace/ })).toBeInTheDocument();
		await waitFor(() => expect(api.requestUsageUpdate).toHaveBeenCalledWith());
	});

	it("puts the account back when the switch is refused or fails", async () => {
		api.requestAllProfilesUsage.mockResolvedValue(allProfiles([profile()]));
		api.setActiveClaudeProfile
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("keychain"));
		render(<UsageIndicator />);
		await openPopover();
		for (let attempt = 0; attempt < 2; attempt++) {
			fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: /Active Account/ })).toHaveTextContent(
					"ada@example.com",
				),
			);
		}
		expect(api.setActiveClaudeProfile).toHaveBeenCalledTimes(2);
	});

	it("opens the accounts settings after switching to an account that must sign in again", async () => {
		api.requestAllProfilesUsage.mockResolvedValue(
			allProfiles([profile({ needsReauthentication: true })]),
		);
		const opened = vi.fn();
		globalThis.addEventListener("open-app-settings", opened);
		render(<UsageIndicator />);
		await openPopover();
		fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
		await waitFor(() => expect(opened).toHaveBeenCalled());
		globalThis.removeEventListener("open-app-settings", opened);
	});
});
