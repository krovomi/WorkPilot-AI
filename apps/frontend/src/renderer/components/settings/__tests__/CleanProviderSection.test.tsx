/**
 * CleanProviderSection — Settings → Accounts: every provider as a card with
 * how it signs in, its usage and its last test. Configured providers that were
 * never tested are tested once in the background, a switch that could not be
 * saved does not move, and a failed load is retried in place.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { AppSettings } from "../../../../shared/types/settings";
import { useSettingsStore } from "../../../stores/settings-store";
import { CleanProviderSection } from "../CleanProviderSection";
import { requestProviderReauth } from "../reauth-request";

const { toast, getStaticProviders, getAllConnectors, setContextProvider } = vi.hoisted(() => ({
	toast: vi.fn(),
	getStaticProviders: vi.fn(),
	getAllConnectors: vi.fn(),
	setContextProvider: vi.fn(),
}));

vi.mock("../CleanProviderGrid", () => stubModule("CleanProviderGrid"));
vi.mock("../GlobalAutoSwitching", () => stubModule("GlobalAutoSwitching"));
vi.mock("../ProviderConfigDialog", () => stubModule("ProviderConfigDialog"));
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../multiconnector/utils", () => ({ getAllConnectors }));
vi.mock("../../ProviderContext", () => ({
	useProviderContext: () => ({ setSelectedProvider: setContextProvider }),
}));
vi.mock("@shared/utils/providers", () => ({ getStaticProviders }));

type GridProvider = {
	id: string;
	name: string;
	description: string;
	isConfigured: boolean;
	isWorking?: boolean;
	lastTested?: string;
	usageCount?: number;
	realUsageData?: { sessionPercent: number; profileName?: string };
	realApiKeyInfo: Record<string, unknown>;
};

const PROVIDERS = [
	{ name: "anthropic", label: "Anthropic", description: "-" },
	{ name: "openai", label: "OpenAI", description: "-" },
	{ name: "copilot", label: "GitHub Copilot", description: "-" },
	{ name: "mistral", label: "Mistral", description: "-" },
	{ name: "gemini", label: "Gemini", description: "-" },
	{ name: "ollama", label: "Ollama", description: "-" },
	{ name: "windsurf", label: "Windsurf", description: "-" },
	{ name: "brand-new", label: "Brand New", description: "Its own words" },
];

const STATUS = { anthropic: true, openai: true, copilot: true, mistral: false, windsurf: false };

const initial = useSettingsStore.getState();
let api: RendererApi;
let invoke: ReturnType<typeof vi.fn>;
let usageListener: (snapshot: unknown) => void = () => undefined;
let allUsageListener: (data: unknown) => void = () => undefined;

function useApi(overrides: Record<string, unknown> = {}) {
	api?.restore();
	invoke = vi.fn(async (channel: string) => {
		if (channel === "usage:getAllData") {
			return { windsurf: { provider: "windsurf", usage: { sessionPercent: 12 }, timestamp: 1 } };
		}
		if (channel === "credential:testProvider") return { success: true, message: "ok" };
		return undefined;
	});
	api = installRendererApi({
		invoke,
		requestAllProfilesUsage: vi.fn(async () => ({
			success: true,
			data: {
				allProfiles: [
					{ profileId: "p2", profileName: "Work", sessionPercent: 80, weeklyPercent: 10, isActive: false },
					{ profileId: "p1", profileName: "Me", sessionPercent: 40, weeklyPercent: 20, isActive: true },
				],
			},
		})),
		requestUsageUpdate: vi.fn(async (provider: string) =>
			provider === "anthropic"
				? { success: true, data: { profileId: "p1", profileName: "Me", sessionPercent: 55, weeklyPercent: 30 } }
				: { success: false },
		),
		onUsageUpdated: vi.fn((listener) => {
			usageListener = listener;
			return () => {
				usageListener = () => undefined;
			};
		}),
		onAllProfilesUsageUpdated: vi.fn((listener) => {
			allUsageListener = listener;
			return () => undefined;
		}),
		...overrides,
	});
}

function setStore(settings: Record<string, unknown> = {}) {
	useSettingsStore.setState({
		settings: {
			...initial.settings,
			globalOpenAIApiKey: "••••",
			credentialsSetAt: { globalOpenAIApiKey: "2026-10-01T00:00:00.000Z" },
			testResult_openai: { date: "2026-11-01T00:00:00.000Z", success: true },
			...settings,
		} as AppSettings,
		profiles: [
			{ id: "m", name: "Mistral key", baseUrl: "https://api.mistral.ai/v1", apiKey: "••••", createdAt: 0, updatedAt: 0 },
			{ id: "g", name: "Gemini key", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "••••", createdAt: 0, updatedAt: 0 },
			{ id: "x", name: "No url", baseUrl: "", apiKey: "••••", createdAt: 0, updatedAt: 0 },
		],
	});
}

beforeEach(() => {
	useApi();
	setStore();
	getAllConnectors.mockResolvedValue([]);
	getStaticProviders.mockImplementation(async () => ({ providers: PROVIDERS, status: STATUS }));
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
	useSettingsStore.setState(initial, true);
	localStorage.clear();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderSection(isOpen = true) {
	const onSettingsChange = vi.fn();
	const view = render(
		<CleanProviderSection
			settings={useSettingsStore.getState().settings as AppSettings & Record<string, unknown>}
			onSettingsChange={onSettingsChange}
			isOpen={isOpen}
		/>,
	);
	return { onSettingsChange, ...view };
}

const grid = () => stubProps("CleanProviderGrid").providers as GridProvider[];
const card = (id: string) => grid().find((p) => p.id === id) as GridProvider;
const tests = () => invoke.mock.calls.filter(([channel]) => channel === "credential:testProvider").map(([, id]) => id);
const saved = () => globalThis.electronAPI.saveSettings as unknown as ReturnType<typeof vi.fn>;

async function settle() {
	await waitFor(() => expect(card("anthropic").realUsageData?.sessionPercent).toBe(55));
}

describe("CleanProviderSection", () => {
	it("shows how each provider signs in, its usage and its last test", async () => {
		renderSection();
		expect(screen.getByText("Loading providers...")).toBeInTheDocument();
		await settle();
		expect(card("anthropic")).toMatchObject({
			name: "Anthropic",
			isConfigured: true,
			isWorking: true,
			usageCount: 55,
			realApiKeyInfo: { hasKey: true, isOAuth: true, authMethod: "oauth" },
		});
		expect(card("openai")).toMatchObject({
			lastTested: "2026-11-01T00:00:00.000Z",
			realApiKeyInfo: { hasKey: true, keyPreview: "••••", authMethod: "api-key", setAt: "2026-10-01T00:00:00.000Z" },
		});
		expect(card("copilot").realApiKeyInfo).toEqual({ hasKey: true, isOAuth: false, authMethod: "cli" });
		expect(card("mistral")).toMatchObject({
			isConfigured: false,
			isWorking: undefined,
			realApiKeyInfo: { hasKey: true, provider: "Mistral key", authMethod: "api-key" },
		});
		expect(card("gemini").realApiKeyInfo).toMatchObject({ provider: "Gemini key" });
		expect(card("ollama").realApiKeyInfo).toEqual({ hasKey: true, keyPreview: undefined, isOAuth: false, authMethod: "local" });
		// Usage read by the credential manager when no profile has it.
		expect(card("windsurf")).toMatchObject({ usageCount: 12, realUsageData: { profileName: "Windsurf" } });
		expect(card("brand-new")).toMatchObject({
			description: "Its own words",
			realApiKeyInfo: { hasKey: false, authMethod: "api-key" },
		});
		expect(card("anthropic").description).toBe(i18n.t("settings:sections.accounts.providers.anthropic"));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("tests each configured, untested provider once, even while the list keeps changing", async () => {
		const answers: Array<(value: unknown) => void> = [];
		invoke.mockImplementation(async (channel: string) =>
			channel === "credential:testProvider" ? new Promise((resolve) => answers.push(resolve)) : undefined,
		);
		renderSection();
		await waitFor(() => expect(tests()).toEqual(["anthropic"]));
		// The list changes while the first test runs.
		act(() => {
			usageListener({ profileId: "p1", profileName: "Me", sessionPercent: 5, weeklyPercent: 5 });
		});
		await act(async () => answers[0]({ success: false, message: "expired" }));
		await waitFor(() => expect(tests()).toEqual(["anthropic", "copilot"]));
		await act(async () => answers[1]({ success: true, message: "ok" }));
		await waitFor(() => expect(saved()).toHaveBeenCalledTimes(2));
		// openai had a result already; mistral is not configured.
		expect(tests()).toEqual(["anthropic", "copilot"]);
		expect(saved().mock.calls.map(([s]) => Object.keys(s).filter((k) => k.startsWith("testResult_") && k !== "testResult_openai"))).toEqual([
			["testResult_anthropic"],
			["testResult_anthropic", "testResult_copilot"],
		]);
		expect(useSettingsStore.getState().settings).toMatchObject({ testResult_anthropic: { success: false } });
		expect(toast).not.toHaveBeenCalled();
	});

	it("tests a provider on demand and says how it went, by its name", async () => {
		renderSection();
		await settle();
		invoke.mockImplementation(async (channel: string, id: string) => {
			if (channel !== "credential:testProvider") return undefined;
			if (id === "openai") return { success: true, message: "ok", details: { modelCount: 3 } };
			if (id === "mistral") return { success: true, message: "ok", details: { model: "large" } };
			if (id === "gemini") return { success: false, message: "quota" };
			throw new Error("IPC");
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const run = (id: string) => act(async () => void (await callStub("CleanProviderGrid", "onTest", id)));
		await run("openai");
		expect(toast.mock.calls.at(-1)?.[0]).toEqual({
			title: "Test successful",
			description: "The OpenAI provider is working correctly (3 models available)",
		});
		await run("mistral");
		expect(toast.mock.calls.at(-1)?.[0].description).toBe("The Mistral provider is working correctly (Model used: large)");
		await run("gemini");
		expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({
			variant: "destructive",
			description: "The Gemini provider failed: quota",
		});
		// The service turns a broken channel into a failed answer.
		await run("ollama");
		expect(toast.mock.calls.at(-1)?.[0].description).toBe("The Ollama provider failed: IPC");
		expect(stubProps("CleanProviderGrid").testingProviders).toEqual(new Set());
		expect(useSettingsStore.getState().settings).toMatchObject({ testResult_gemini: { success: false } });
	});

	it("shows a test in progress, and an unexpected failure", async () => {
		renderSection();
		await settle();
		let answer: (value: unknown) => void = () => undefined;
		invoke.mockImplementation(async (channel: string) =>
			channel === "credential:testProvider" ? new Promise((resolve) => (answer = resolve)) : undefined,
		);
		let running: Promise<unknown> = Promise.resolve();
		act(() => {
			running = callStub("CleanProviderGrid", "onTest", "openai") as Promise<unknown>;
		});
		expect(stubProps("CleanProviderGrid").testingProviders).toEqual(new Set(["openai"]));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		// A result that cannot be saved is an unexpected failure.
		saved().mockRejectedValueOnce(new Error("disk"));
		await act(async () => {
			answer(null);
			await running;
		});
		expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({ description: "The OpenAI provider failed: Unknown error" });
		expect(stubProps("CleanProviderGrid").testingProviders).toEqual(new Set());
	});

	it("switches a provider off for auto-switching, and keeps it on when that is not saved", async () => {
		renderSection();
		await settle();
		await act(async () => void (await callStub("CleanProviderGrid", "onToggle", "openai", false)));
		expect(saved()).toHaveBeenLastCalledWith(expect.objectContaining({ disabledAutoSwitchProviders: ["openai"] }));
		expect(card("openai").isWorking).toBe(false);
		expect(toast.mock.calls.at(-1)?.[0]).toEqual({
			title: "Provider disabled",
			description: "OpenAI has been disabled successfully",
		});
		expect(screen.getByRole("alert")).toHaveTextContent("1 provider(s) with errors");
		expect(JSON.parse(localStorage.getItem("work_pilot_ai_llm_providers_openai") ?? "{}").openai.enabled).toBe(false);

		// Switching it off twice keeps one entry.
		await act(async () => void (await callStub("CleanProviderGrid", "onToggle", "openai", false)));
		expect(saved().mock.lastCall?.[0].disabledAutoSwitchProviders).toEqual(["openai"]);

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		saved().mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => void (await callStub("CleanProviderGrid", "onToggle", "openai", true)));
		expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({
			variant: "destructive",
			description: "Failed to enable provider OpenAI",
		});
		expect(card("openai").isWorking).toBe(false);

		await act(async () => void (await callStub("CleanProviderGrid", "onToggle", "openai", true)));
		expect(saved().mock.lastCall?.[0].disabledAutoSwitchProviders).toEqual([]);
		expect(toast.mock.calls.at(-1)?.[0].title).toBe("Provider enabled");
		expect(card("openai").isWorking).toBe(true);
	});

	it("opens a provider's settings, and its login when a re-auth was asked for", async () => {
		requestProviderReauth("anthropic");
		renderSection();
		await waitFor(() => expect(stubProps("ProviderConfigDialog")).toMatchObject({ isOpen: true, autoStartOAuth: true }));
		expect((stubProps("ProviderConfigDialog").provider as GridProvider).id).toBe("anthropic");
		act(() => {
			callStub("ProviderConfigDialog", "onOpenChange", false);
		});
		expect(screen.queryByTestId("stub-ProviderConfigDialog")).toBeNull();

		act(() => {
			callStub("CleanProviderGrid", "onConfigure", "openai");
		});
		expect(stubProps("ProviderConfigDialog")).toMatchObject({ isOpen: true, autoStartOAuth: false });
		expect((stubProps("ProviderConfigDialog").provider as GridProvider).id).toBe("openai");
		act(() => {
			callStub("ProviderConfigDialog", "onOpenChange", false);
			callStub("CleanProviderGrid", "onConfigure", "unknown");
		});
		expect(screen.queryByTestId("stub-ProviderConfigDialog")).toBeNull();

		// A request made while the section is open, for a provider by name.
		act(() => requestProviderReauth("GitHub Copilot"));
		expect((stubProps("ProviderConfigDialog").provider as GridProvider).id).toBe("copilot");
		act(() => {
			callStub("ProviderConfigDialog", "onOpenChange", false);
			requestProviderReauth("nobody");
		});
		expect(screen.queryByTestId("stub-ProviderConfigDialog")).toBeNull();
	});

	it("makes an activated provider the default everywhere", async () => {
		const changed = vi.fn();
		globalThis.addEventListener("providerChanged", changed);
		renderSection();
		await settle();
		act(() => {
			callStub("CleanProviderGrid", "onConfigure", "openai");
		});
		await act(async () => void (await callStub("ProviderConfigDialog", "onProviderActivated", "openai")));
		expect(setContextProvider).toHaveBeenCalledWith("openai");
		expect(useSettingsStore.getState().settings.selectedProvider).toBe("openai");
		expect(localStorage.getItem("selectedProvider")).toBe("openai");
		expect(globalThis.electronAPI.selectProvider).toHaveBeenCalledWith("openai");
		expect(changed.mock.calls[0][0].detail.provider).toBe("openai");

		// The backend not answering does not stop the switch.
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		(globalThis.electronAPI.selectProvider as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("IPC"));
		await act(async () => void (await callStub("ProviderConfigDialog", "onProviderActivated", "mistral")));
		expect(error).toHaveBeenCalled();
		expect(changed).toHaveBeenCalledTimes(2);
		globalThis.removeEventListener("providerChanged", changed);

		// What the dialog saves goes to disk first.
		await act(async () => void (await callStub("ProviderConfigDialog", "onSettingsChange", { theme: "dark" })));
		expect(saved()).toHaveBeenLastCalledWith({ theme: "dark" });
	});

	it("retries a failed load in place, without reloading the window", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		getAllConnectors.mockRejectedValueOnce(new Error("offline"));
		const reload = vi.fn();
		vi.stubGlobal("location", { ...globalThis.location, reload });
		renderSection();
		expect(await screen.findByText("Failed to load provider list")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByTestId("stub-CleanProviderGrid")).toBeInTheDocument();
		expect(getAllConnectors).toHaveBeenCalledTimes(2);
		expect(reload).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("opens and closes the auto-switching drawer, and says when nothing is configured", async () => {
		getStaticProviders.mockImplementation(async () => ({ providers: PROVIDERS.slice(5), status: {} }));
		renderSection();
		expect(await screen.findByText(/No provider configured/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Auto-switching" }));
		expect(stubProps("GlobalAutoSwitching")).toMatchObject({ isOpen: true, providerStatus: {} });
		await act(async () => void (await callStub("GlobalAutoSwitching", "onSettingsChange", { autoSwitch: true })));
		expect(saved()).toHaveBeenLastCalledWith({ autoSwitch: true });
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByTestId("stub-GlobalAutoSwitching")).toBeNull();
	});

	it("keeps the active profile's live usage over the slower summary of all profiles", async () => {
		const { rerender } = renderSection();
		await settle();
		act(() => {
			usageListener({ profileId: "p1", profileName: "Me", sessionPercent: 70, weeklyPercent: 90 });
			usageListener({});
			allUsageListener({
				allProfiles: [
					{ profileId: "p1", profileName: "Me", sessionPercent: 1, isActive: true },
					{ profileId: "p3", profileName: "openai team", sessionPercent: 33, isActive: false },
				],
			});
		});
		expect(card("anthropic").usageCount).toBe(70);
		expect(card("openai").usageCount).toBe(33);

		rerender(
			<CleanProviderSection
				settings={useSettingsStore.getState().settings as AppSettings & Record<string, unknown>}
				onSettingsChange={vi.fn()}
				isOpen={false}
			/>,
		);
		act(() => usageListener({ profileId: "p1", sessionPercent: 2, weeklyPercent: 2 }));
		expect(card("anthropic").usageCount).toBe(70);
	});

	it("still shows the providers when usage cannot be read", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		useApi({
			requestAllProfilesUsage: vi.fn(async () => Promise.reject(new Error("IPC"))),
			requestUsageUpdate: vi.fn(async () => Promise.reject(new Error("IPC"))),
		});
		invoke.mockImplementation(async (channel: string) => {
			if (channel === "usage:getAllData") throw new Error("IPC");
			return { success: true, message: "ok" };
		});
		renderSection();
		await waitFor(() => expect(card("anthropic")).toBeDefined());
		expect(card("anthropic").realUsageData).toBeUndefined();
		expect(card("windsurf").realUsageData).toBeUndefined();
		cleanup();

		getStaticProviders.mockRejectedValueOnce(new Error("registry"));
		renderSection();
		await waitFor(() => expect(console.error).toHaveBeenCalledWith("Failed to load providers:", expect.any(Error)));
		expect(grid()).toEqual([]);
	});
});
