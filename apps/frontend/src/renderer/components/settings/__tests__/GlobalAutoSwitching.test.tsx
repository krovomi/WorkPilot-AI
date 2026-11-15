/**
 * GlobalAutoSwitching — when and how WorkPilot moves to another account: the
 * switches, the routing strategy, the session threshold (saved once the
 * slider is let go) and the order of the signed-in accounts. A value that
 * could not be saved goes back to the saved one and says so.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { AppSettings } from "../../../../shared/types";
import { useClaudeProfileStore } from "../../../stores/claude-profile-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { GlobalAutoSwitching } from "../GlobalAutoSwitching";

const { toast, getStaticProviders } = vi.hoisted(() => ({ toast: vi.fn(), getStaticProviders: vi.fn() }));

vi.mock("../AccountPriorityList", () => stubModule("AccountPriorityList"));
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@shared/utils/providers", () => ({ getStaticProviders }));

type Account = { id: string; name: string; type: string; displayName: string; identifier: string; isActive: boolean };

const settingsInitial = useSettingsStore.getState();
const claudeInitial = useClaudeProfileStore.getState();
let api: RendererApi;

const PROVIDERS = [
	{ name: "anthropic", label: "Anthropic", description: "" },
	{ name: "copilot", label: "GitHub Copilot", description: "" },
	{ name: "openai", label: "OpenAI", description: "" },
	{ name: "ollama", label: "Ollama", description: "" },
	{ name: "mistral", label: "Mistral", description: "" },
];

beforeEach(() => {
	api = installRendererApi({
		getClaudeProfiles: vi.fn(async () => ({
			success: true,
			data: {
				profiles: [
					{ id: "c1", name: "Personal", email: "me@example.com", isAuthenticated: true },
					{ id: "c2", name: "Old", isAuthenticated: false },
					{ id: "c3", name: "Work", isAuthenticated: true },
				],
				activeProfileId: "c1",
			},
		})),
		checkCopilotAuth: vi.fn(async () => ({ success: true, data: { authenticated: true, username: "octocat" } })),
		getAccountPriorityOrder: vi.fn(async () => ({ success: true, data: ["openai", "oauth-c3"] })),
		setAccountPriorityOrder: vi.fn(async () => ({ success: true })),
	});
	useSettingsStore.setState({
		profiles: [
			{ id: "a1", name: "OpenAI work", baseUrl: "https://api.openai.com/v1", apiKey: "••••", createdAt: 0, updatedAt: 0 },
			{ id: "a2", name: "My ollama", baseUrl: "", apiKey: "", createdAt: 0, updatedAt: 0 },
		],
		activeProfileId: null,
	});
	getStaticProviders.mockResolvedValue({
		providers: PROVIDERS,
		status: { anthropic: true, copilot: true, openai: true, ollama: true, mistral: false },
	});
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
	useSettingsStore.setState(settingsInitial, true);
	useClaudeProfileStore.setState(claudeInitial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderSwitching(settings: Partial<AppSettings> = {}, providerStatus?: Record<string, boolean>) {
	const onSettingsChange = vi.fn();
	const props = {
		settings: { autoSwitchEnabled: true, ...settings } as AppSettings,
		onSettingsChange,
		isOpen: true,
		providerStatus,
	};
	const view = render(<GlobalAutoSwitching {...props} />);
	return { onSettingsChange, props, ...view };
}

const saved = () => globalThis.electronAPI.saveSettings as unknown as ReturnType<typeof vi.fn>;
const accounts = () => stubProps("AccountPriorityList").accounts as Account[];

describe("GlobalAutoSwitching", () => {
	it("lists the signed-in accounts in their saved order, Claude accounts first", async () => {
		renderSwitching();
		await waitFor(() => expect(accounts().map((a) => a.id)).toEqual(["api-a1", "oauth-c3", "oauth-c1", "copilot", "api-a2"]));
		const byId = Object.fromEntries(accounts().map((a) => [a.id, a]));
		expect(byId["oauth-c1"]).toMatchObject({ type: "oauth", identifier: "me@example.com", isActive: true });
		expect(byId["oauth-c3"]).toMatchObject({ identifier: "No email", isActive: false });
		expect(byId["api-a1"]).toMatchObject({ type: "api", identifier: "https://api.openai.com/v1" });
		expect(byId.copilot).toMatchObject({ identifier: "@octocat" });
		// An Ollama profile found by its name, which has no address to show.
		expect(byId["api-a2"]).toMatchObject({ identifier: "My ollama" });
		// Not signed in, or not configured: not listed.
		expect(accounts().some((a) => a.id === "oauth-c2" || a.name === "mistral")).toBe(false);
		// Read once when the section opens, not again at every render.
		await act(async () => undefined);
		expect(globalThis.electronAPI.getAccountPriorityOrder).toHaveBeenCalledTimes(1);
		expect(globalThis.electronAPI.getClaudeProfiles).toHaveBeenCalledTimes(2);
	});

	it("follows the grid's provider status, and an active API profile", async () => {
		useSettingsStore.setState({ activeProfileId: "a1" });
		getStaticProviders.mockResolvedValue({ providers: PROVIDERS, status: {} });
		(globalThis.electronAPI.checkCopilotAuth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: { authenticated: false } });
		renderSwitching({}, { openai: true, copilot: true });
		await waitFor(() => expect(accounts().map((a) => a.id)).toContain("copilot"));
		const byId = Object.fromEntries(accounts().map((a) => [a.id, a]));
		expect(byId.copilot.identifier).toBe("Authenticated via API key");
		expect(byId["api-a1"].isActive).toBe(true);
		// The Claude account is not the one in use while an API profile is.
		expect(byId["oauth-c1"].isActive).toBe(false);
	});

	it("saves a new order, and says when it could not", async () => {
		renderSwitching();
		await waitFor(() => expect(accounts().length).toBeGreaterThan(0));
		await act(async () => void (await callStub("AccountPriorityList", "onReorder", ["copilot", "api-a1"])));
		expect(globalThis.electronAPI.setAccountPriorityOrder).toHaveBeenCalledWith(["copilot", "api-a1"]);
		expect(accounts()[0].id).toBe("copilot");
		expect(toast).not.toHaveBeenCalled();

		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		(globalThis.electronAPI.setAccountPriorityOrder as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ success: false, error: "disk" })
			.mockRejectedValueOnce(new Error("IPC"));
		for (let attempt = 0; attempt < 2; attempt++) {
			await act(async () => void (await callStub("AccountPriorityList", "onReorder", ["api-a1"])));
		}
		expect(toast).toHaveBeenCalledTimes(2);
		expect(toast.mock.calls[0][0]).toMatchObject({ variant: "destructive", description: "Unable to update settings" });
		// The list shows the order that is saved again, not the refused one.
		await waitFor(() => expect(accounts().map((a) => a.id).slice(0, 2)).toEqual(["copilot", "api-a1"]));
	});

	it("turns auto-switching on and off, and stays put when that is not saved", async () => {
		const { onSettingsChange } = renderSwitching({ autoSwitchEnabled: false });
		const master = screen.getByRole("switch", { name: "Enable auto-switching" });
		expect(screen.queryByRole("switch", { name: "Proactive Monitoring" })).toBeNull();
		await userEvent.click(master);
		expect(saved()).toHaveBeenCalledWith({ autoSwitchEnabled: true });
		expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ autoSwitchEnabled: true }));
		expect(toast.mock.calls.at(-1)?.[0].title).toBe("Auto-switching enabled");
		expect(master).toBeChecked();

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		saved().mockResolvedValueOnce({ success: false }).mockRejectedValueOnce(new Error("IPC"));
		await userEvent.click(master);
		expect(master).toBeChecked();
		await userEvent.click(master);
		expect(master).toBeChecked();
		expect(toast.mock.calls.slice(-2).every(([call]) => call.variant === "destructive")).toBe(true);
		await userEvent.click(master);
		expect(master).not.toBeChecked();
		expect(toast.mock.calls.at(-1)?.[0].title).toBe("Auto-switching disabled");
	});

	it("saves each rule, and puts a rule back when it is not saved", async () => {
		await i18n.changeLanguage("fr");
		const { onSettingsChange } = renderSwitching();
		const name = (key: string) => i18n.t(`settings:autoSwitching.${key}`);
		await userEvent.click(screen.getByRole("switch", { name: name("rateLimitSwitching") }));
		expect(saved()).toHaveBeenLastCalledWith({ rateLimitEnabled: true });
		expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ rateLimitEnabled: true }));
		await userEvent.click(screen.getByRole("switch", { name: name("authFailureSwitching") }));
		expect(saved()).toHaveBeenLastCalledWith({ authFailureEnabled: true });
		await userEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("settings:llmRouter.routingStrategy.cheapest")) }));
		expect(saved()).toHaveBeenLastCalledWith({ routingStrategy: "cheapest" });

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		saved().mockResolvedValueOnce({ success: false });
		const proactive = screen.getByRole("switch", { name: name("proactiveMonitoring") });
		expect(proactive).toBeChecked();
		await userEvent.click(proactive);
		expect(saved()).toHaveBeenLastCalledWith({ proactiveEnabled: false });
		// Back to what is saved: the props, which never had the earlier changes.
		await waitFor(() => expect(proactive).toBeChecked());
		expect(screen.getByRole("switch", { name: name("rateLimitSwitching") })).not.toBeChecked();
		expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({ variant: "destructive", title: "Erreur" });
	});

	it("moves the threshold with the slider and saves it once it is let go", async () => {
		renderSwitching({ sessionThreshold: 90 });
		const slider = screen.getByLabelText("Session Threshold");
		fireEvent.change(slider, { target: { value: "80" } });
		fireEvent.change(slider, { target: { value: "70" } });
		expect(screen.getByText("70%")).toBeInTheDocument();
		expect(saved()).not.toHaveBeenCalled();
		expect(slider).toBeEnabled();
		await act(async () => {
			fireEvent.pointerUp(slider);
		});
		expect(saved()).toHaveBeenCalledTimes(1);
		expect(saved()).toHaveBeenCalledWith({ sessionThreshold: 70 });
		// Let go where it was saved: nothing more to save.
		fireEvent.change(slider, { target: { value: "90" } });
		fireEvent.keyUp(slider);
		fireEvent.blur(slider);
		expect(saved()).toHaveBeenCalledTimes(1);
	});

	it("follows settings changed elsewhere, and still lists accounts when Copilot cannot be asked", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		(globalThis.electronAPI.checkCopilotAuth as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gh"));
		(globalThis.electronAPI.getAccountPriorityOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { rerender, props } = renderSwitching({ autoSwitchEnabled: false });
		await waitFor(() => expect(error).toHaveBeenCalledWith("[GlobalAutoSwitching] Copilot auth check failed:", expect.any(Error)));
		rerender(<GlobalAutoSwitching {...props} settings={{ ...props.settings, autoSwitchEnabled: true, rateLimitEnabled: true } as AppSettings} />);
		expect(screen.getByRole("switch", { name: "Enable auto-switching" })).toBeChecked();
		expect(screen.getByRole("switch", { name: "Switch on Rate Limit" })).toBeChecked();
		await waitFor(() => expect(accounts().find((a) => a.id === "copilot")?.identifier).toBe("Authenticated via API key"));
	});

	it("shows no account list without accounts, and survives a provider list that cannot be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		getStaticProviders.mockRejectedValue(new Error("registry"));
		renderSwitching();
		await waitFor(() => expect(error).toHaveBeenCalledWith("[GlobalAutoSwitching] Failed to list accounts:", expect.any(Error)));
		expect(screen.queryByTestId("stub-AccountPriorityList")).toBeNull();
	});
});
