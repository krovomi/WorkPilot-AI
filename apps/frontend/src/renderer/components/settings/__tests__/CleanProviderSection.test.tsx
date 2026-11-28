/**
 * CleanProviderSection — Settings → AI accounts: the summary, the providers
 * (how each signs in, its usage, its last test) and the failover chain built
 * from every connected account. Connected providers never tested are tested
 * once in the background, a failed load is retried in place, and the
 * re-auth toast opens the provider's sign-in.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { AppSettings } from "../../../../shared/types/settings";
import { useAiAccountsStore } from "../../../stores/ai-accounts-store";
import { useClaudeProfileStore } from "../../../stores/claude-profile-store";
import { useSettingsStore } from "../../../stores/settings-store";
import type { ProviderCardData } from "../CleanProviderCard";
import { CleanProviderSection, savedTestResults } from "../CleanProviderSection";
import type { FailoverAccount } from "../failover-accounts";
import { requestProviderReauth } from "../reauth-request";

const { toast, getStaticProviders, getAllConnectors, setContextProvider, context } = vi.hoisted(() => ({
	toast: vi.fn(),
	getStaticProviders: vi.fn(),
	getAllConnectors: vi.fn(),
	setContextProvider: vi.fn(),
	context: { selectedProvider: "anthropic" as string },
}));

vi.mock("../CleanProviderGrid", () => stubModule("CleanProviderGrid"));
vi.mock("../GlobalAutoSwitching", () => stubModule("GlobalAutoSwitching"));
vi.mock("../ProviderConfigDialog", () => stubModule("ProviderConfigDialog"));
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../multiconnector/utils", () => ({ getAllConnectors }));
vi.mock("../../ProviderContext", () => ({
	useProviderContext: () => ({ selectedProvider: context.selectedProvider, setSelectedProvider: setContextProvider }),
}));
vi.mock("@shared/utils/providers", () => ({ getStaticProviders }));

const PROVIDERS = [
	{ name: "anthropic", label: "Anthropic", description: "-" },
	{ name: "openai", label: "OpenAI", description: "-" },
	{ name: "copilot", label: "GitHub Copilot", description: "-" },
	{ name: "mistral", label: "Mistral", description: "-" },
	{ name: "windsurf", label: "Windsurf", description: "-" },
	{ name: "brand-new", label: "Brand New", description: "Its own words" },
];
const STATUS = { anthropic: true, openai: true, copilot: true, mistral: false, windsurf: true };

const initialSettings = useSettingsStore.getState();
const initialClaude = useClaudeProfileStore.getState();
const initialAccounts = useAiAccountsStore.getState();
let api: RendererApi;
let invoke: ReturnType<typeof vi.fn>;

function useApi(overrides: Record<string, unknown> = {}) {
	api?.restore();
	invoke = vi.fn(async (channel: string) => {
		if (channel === "usage:getAllData") return { windsurf: { usage: { sessionPercent: 12 } } };
		if (channel === "credential:testProvider") return { success: true, message: "ok" };
		return undefined;
	});
	api = installRendererApi({
		invoke,
		requestAllProfilesUsage: vi.fn(async () => ({
			success: true,
			data: { allProfiles: [{ profileId: "p1", profileName: "Me", sessionPercent: 40, weeklyPercent: 20, isActive: true }] },
		})),
		requestUsageUpdate: vi.fn(async () => ({ success: false })),
		getClaudeProfiles: vi.fn(async () => ({
			success: true,
			data: {
				activeProfileId: "p1",
				profiles: [
					{ id: "p1", name: "Me", email: "me@example.com", isAuthenticated: true },
					{ id: "p2", name: "Off", isAuthenticated: false },
				],
			},
		})),
		checkCopilotAuth: vi.fn(async () => ({ success: true, data: { authenticated: true, username: "octo" } })),
		getAutoSwitchSettings: vi.fn(async () => ({ success: true, data: { enabled: true } })),
		...overrides,
	});
}

function setStore(settings: Record<string, unknown> = {}) {
	useSettingsStore.setState({
		settings: {
			...initialSettings.settings,
			globalOpenAIApiKey: "••••",
			testResult_openai: { date: "2026-11-01T00:00:00.000Z", success: true },
			testResult_windsurf: { date: "2026-11-01T00:00:00.000Z", success: false },
			...settings,
		} as AppSettings,
		profiles: [
			{ id: "m", name: "Mistral key", baseUrl: "https://api.mistral.ai/v1", apiKey: "••••", createdAt: 0, updatedAt: 0 },
		],
	});
}

beforeEach(() => {
	useApi();
	setStore();
	context.selectedProvider = "anthropic";
	getAllConnectors.mockResolvedValue([]);
	getStaticProviders.mockImplementation(async () => ({ providers: PROVIDERS, status: STATUS }));
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
	useSettingsStore.setState(initialSettings, true);
	useClaudeProfileStore.setState(initialClaude, true);
	useAiAccountsStore.setState(initialAccounts, true);
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

const grid = () => stubProps("CleanProviderGrid").providers as ProviderCardData[];
const card = (id: string) => grid().find((p) => p.id === id) as ProviderCardData;
const tests = () => invoke.mock.calls.filter(([channel]) => channel === "credential:testProvider").map(([, id]) => id);

async function settle() {
	await waitFor(() => expect(card("windsurf")?.realUsageData?.sessionPercent).toBe(12));
	await waitFor(() => expect(tests()).toHaveLength(2));
}

describe("savedTestResults", () => {
	it("reads the dated test results saved in the settings", () => {
		expect(
			savedTestResults({
				testResult_a: { date: "d", success: true },
				testResult_b: { date: "d" },
				testResult_c: null,
				testResult_d: { success: true },
				other: 1,
			}),
		).toEqual(
			new Map([
				["a", { date: "d", success: true }],
				["b", { date: "d", success: false }],
			]),
		);
	});
});

describe("CleanProviderSection", () => {
	it("shows each provider: how it signs in, its usage and its last test", async () => {
		renderSection();
		expect(screen.getByText(i18n.t("settings:aiAccounts.loading"))).toBeInTheDocument();
		await settle();
		expect(card("anthropic")).toMatchObject({
			name: "Anthropic",
			isConfigured: true,
			realUsageData: { sessionPercent: 40 },
			realApiKeyInfo: { hasKey: true, authMethod: "oauth" },
		});
		expect(card("openai")).toMatchObject({
			isWorking: true,
			lastTested: "2026-11-01T00:00:00.000Z",
			realApiKeyInfo: { hasKey: true, authMethod: "api-key" },
		});
		expect(card("windsurf")).toMatchObject({ isWorking: false, realUsageData: { profileName: "Windsurf" } });
		expect(card("mistral")).toMatchObject({
			isConfigured: false,
			isWorking: undefined,
			realApiKeyInfo: { hasKey: true, provider: "Mistral key" },
		});
		expect(card("brand-new").description).toBe("Its own words");
		expect(card("anthropic").description).toBe(i18n.t("settings:sections.accounts.providers.anthropic"));
		expect(stubProps("CleanProviderGrid").defaultProvider).toBe("anthropic");
	});

	it("sums up the connected providers, the default, the failover and what needs attention", async () => {
		renderSection();
		await settle();
		expect(screen.getByText("4 / 6")).toBeInTheDocument();
		expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
		// Claude "Me", the Mistral profile, OpenAI, Copilot and Windsurf.
		await waitFor(() => expect(screen.getByText(i18n.t("settings:aiAccounts.stats.failoverOn", { count: 5 }))).toBeInTheDocument());
		// Windsurf failed its last test.
		expect(screen.getByText("1")).toBeInTheDocument();
	});

	it("tests each connected, untested provider once, quietly", async () => {
		renderSection();
		await settle();
		expect(tests().sort()).toEqual(["anthropic", "copilot"]);
		await waitFor(() =>
			expect(useSettingsStore.getState().settings).toMatchObject({ testResult_copilot: { success: true } }),
		);
		expect(toast).not.toHaveBeenCalled();
	});

	it("reports a test run from a card, with the models found", async () => {
		renderSection();
		await settle();
		invoke.mockImplementation(async (channel: string) =>
			channel === "credential:testProvider" ? { success: true, message: "ok", details: { modelCount: 7 } } : undefined,
		);
		await act(async () => callStub("CleanProviderGrid", "onTest", "openai"));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({ description: i18n.t("settings:aiAccounts.toast.testOkModels", { name: "OpenAI", count: 7 }) }),
			),
		);

		invoke.mockImplementation(async (channel: string) =>
			channel === "credential:testProvider" ? { success: true, message: "ok" } : undefined,
		);
		await act(async () => callStub("CleanProviderGrid", "onTest", "openai"));
		await waitFor(() =>
			expect(toast).toHaveBeenLastCalledWith(
				expect.objectContaining({ title: i18n.t("settings:sections.accounts.providerCard.testSuccess") }),
			),
		);
	});

	it("reports a failed test and a test that could not run", async () => {
		renderSection();
		await settle();
		invoke.mockImplementation(async (channel: string) =>
			channel === "credential:testProvider" ? { success: false, message: "bad key" } : undefined,
		);
		await act(async () => callStub("CleanProviderGrid", "onTest", "unknown-provider"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
		expect(useSettingsStore.getState().settings).toMatchObject({ "testResult_unknown-provider": { success: false } });

		toast.mockClear();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		invoke.mockImplementation(async (channel: string) => {
			if (channel === "credential:testProvider") throw new Error("down");
			return undefined;
		});
		await act(async () => callStub("CleanProviderGrid", "onTest", "openai"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
		error.mockRestore();
	});

	it("does not report a quiet test that could not run", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		invoke.mockImplementation(async (channel: string) => {
			if (channel === "credential:testProvider") throw new Error("down");
			return undefined;
		});
		renderSection();
		await waitFor(() => expect(tests()).toHaveLength(2));
		await waitFor(() => expect(screen.queryByText(i18n.t("settings:aiAccounts.loading"))).toBeNull());
		expect(toast).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("makes a provider the default everywhere", async () => {
		const changed = vi.fn();
		globalThis.addEventListener("providerChanged", changed);
		renderSection();
		await settle();
		await act(async () => callStub("CleanProviderGrid", "onSetDefault", "openai"));
		expect(setContextProvider).toHaveBeenCalledWith("openai");
		expect(useSettingsStore.getState().settings.selectedProvider).toBe("openai");
		expect(localStorage.getItem("selectedProvider")).toBe("openai");
		expect(api.fn("selectProvider")).toHaveBeenCalledWith("openai");
		expect(changed).toHaveBeenCalled();
		globalThis.removeEventListener("providerChanged", changed);
	});

	it("keeps the default when storage or the backend refuses it", async () => {
		useApi({ selectProvider: vi.fn(async () => Promise.reject(new Error("no backend"))) });
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("full");
		});
		renderSection();
		await settle();
		await act(async () => callStub("CleanProviderGrid", "onSetDefault", "copilot"));
		expect(useSettingsStore.getState().settings.selectedProvider).toBe("copilot");
		expect(error).toHaveBeenCalled();
		setItem.mockRestore();
		error.mockRestore();
	});

	it("opens a provider's settings, and its sign-in when asked", async () => {
		renderSection();
		await settle();
		act(() => {
			callStub("CleanProviderGrid", "onConfigure", "nope");
		});
		expect(screen.queryByTestId("stub-ProviderConfigDialog")).toBeNull();
		act(() => {
			callStub("CleanProviderGrid", "onConfigure", "copilot", { startOAuth: true });
		});
		expect(stubProps("ProviderConfigDialog")).toMatchObject({
			isOpen: true,
			autoStartOAuth: true,
			provider: expect.objectContaining({ id: "copilot" }),
		});
		await act(async () => {
			await callStub("ProviderConfigDialog", "onTest", "copilot");
		});
		await act(async () => callStub("ProviderConfigDialog", "onProviderActivated", "copilot"));
		expect(setContextProvider).toHaveBeenCalledWith("copilot");
		await act(async () => {
			await callStub("ProviderConfigDialog", "onSettingsChange", {
				...useSettingsStore.getState().settings,
				globalMistralApiKey: "k",
			});
		});
		expect(api.fn("saveSettings")).toHaveBeenCalled();
	});

	it("counts each provider's accounts, names the one it runs on and opens them", async () => {
		const snapshot = {
			accounts: [{ id: "m1", provider: "mistral", name: "Client", hasKey: true, createdAt: "" }],
			defaults: { mistral: "m1" },
			mainKeys: ["openai", "mistral"],
		};
		useApi({ listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })) });
		renderSection();
		// Mistral, connected by its account, is tested once too.
		await waitFor(() => expect(tests()).toHaveLength(3));
		await waitFor(() => expect(card("mistral").accounts).toEqual({ count: 2, defaultName: "Client" }));
		// A default account connects a provider whose own page holds no key.
		expect(card("mistral").isConfigured).toBe(true);
		expect(card("openai").accounts).toEqual({ count: 1, defaultName: undefined });
		expect(card("anthropic").accounts).toEqual({ count: 2, defaultName: "Me" });
		expect(card("copilot").accounts).toEqual({ count: 0, defaultName: undefined });

		act(() => {
			callStub("CleanProviderGrid", "onManageAccounts", "nope");
		});
		expect(screen.queryByRole("dialog")).toBeNull();
		act(() => {
			callStub("CleanProviderGrid", "onManageAccounts", "mistral");
		});
		expect(await screen.findByRole("dialog", { name: "Mistral accounts" })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("counts a CLI's sign-ins on its card, and names the default one", async () => {
		const login = (id: string, provider: string, name: string) => ({
			id,
			provider,
			name,
			hasKey: false,
			kind: "login" as const,
			signedIn: true,
			createdAt: "",
		});
		const snapshot = {
			accounts: [login("c1", "copilot", "Work"), login("c2", "copilot", "Client"), login("x1", "codex", "Plus")],
			defaults: { copilot: "c2" },
			mainKeys: ["openai"],
		};
		useApi({ listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })) });
		renderSection();
		await settle();
		await waitFor(() => expect(card("copilot").accounts).toEqual({ count: 2, defaultName: "Client" }));
		expect(card("openai").accounts).toEqual({ count: 2, defaultName: "Main key" });
	});

	it("names the main key when it runs beside other accounts", async () => {
		const snapshot = {
			accounts: [{ id: "o1", provider: "openai", name: "Work", hasKey: true, createdAt: "" }],
			defaults: {},
			mainKeys: ["openai"],
		};
		useApi({ listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })) });
		renderSection();
		await settle();
		await waitFor(() => expect(card("openai").accounts).toEqual({ count: 2, defaultName: "Main key" }));
	});

	it("starts a sign-in asked from the re-auth toast, on the providers tab", async () => {
		const user = userEvent.setup();
		renderSection();
		await settle();
		await user.click(screen.getByRole("tab", { name: /Auto failover/ }));
		act(() => requestProviderReauth("missing"));
		act(() => requestProviderReauth("copilot"));
		await waitFor(() => expect(stubProps("ProviderConfigDialog")).toMatchObject({ isOpen: true, autoStartOAuth: true }));
		expect(screen.getByTestId("stub-CleanProviderGrid")).toBeInTheDocument();
	});

	it("shows the failover chain of every connected account and saves what is taken out", async () => {
		const user = userEvent.setup();
		setStore({ disabledAutoSwitchProviders: ["provider-windsurf"] });
		renderSection();
		await settle();
		await user.click(screen.getByRole("tab", { name: /Auto failover/ }));
		const props = stubProps("GlobalAutoSwitching");
		const accounts = props.accounts as FailoverAccount[];
		expect(accounts.map((a) => a.id)).toEqual(["oauth-p1", "api-m", "provider-openai", "provider-copilot", "provider-windsurf"]);
		expect(accounts.find((a) => a.id === "provider-copilot")?.detail).toBe("@octo");
		expect(props.excluded).toEqual(["provider-windsurf"]);
		expect((props.providerLabel as (p: string) => string)("copilot")).toBe("GitHub Copilot");
		expect((props.providerLabel as (p: string) => string)("other")).toBe("other");

		await act(async () => {
			await callStub("GlobalAutoSwitching", "onExcludedChange", []);
		});
		expect(useSettingsStore.getState().settings.disabledAutoSwitchProviders).toEqual([]);
		act(() => {
			callStub("GlobalAutoSwitching", "onSummaryChange", { enabled: false, chainLength: 4 });
		});
		expect(screen.getByText(i18n.t("settings:aiAccounts.stats.failoverOff"))).toBeInTheDocument();
	});

	it("says so when no provider is connected, and copes with what the main does not answer", async () => {
		useApi({
			checkCopilotAuth: vi.fn(async () => Promise.reject(new Error("no gh"))),
			getAutoSwitchSettings: vi.fn(async () => Promise.reject(new Error("no main"))),
		});
		getStaticProviders.mockImplementation(async () => ({ providers: PROVIDERS, status: {} }));
		context.selectedProvider = "";
		renderSection();
		await waitFor(() => expect(screen.getByText(i18n.t("settings:aiAccounts.noneConnected"))).toBeInTheDocument());
		expect(screen.getByText(i18n.t("settings:aiAccounts.stats.none"))).toBeInTheDocument();
		expect(screen.getByText(i18n.t("settings:aiAccounts.stats.failoverOff"))).toBeInTheDocument();
	});

	it("does not acknowledge a change the main did not save", async () => {
		useApi({ saveSettings: vi.fn(async () => ({ success: false })) });
		const { onSettingsChange } = renderSection();
		await waitFor(() => expect(tests()).toHaveLength(2));
		await waitFor(() => expect(api.fn("saveSettings")).toHaveBeenCalled());
		expect(onSettingsChange).not.toHaveBeenCalled();
	});

	it("keeps the page when the failover settings are not readable", async () => {
		useApi({
			getAutoSwitchSettings: vi.fn(async () => ({ success: false })),
			checkCopilotAuth: vi.fn(async () => ({ success: true, data: { authenticated: false } })),
			invoke: vi.fn(async (channel: string) =>
				channel === "usage:getAllData" ? { windsurf: { usage: { weeklyPercent: 12 } } } : { success: true },
			),
		});
		renderSection();
		await waitFor(() => expect(card("windsurf")?.realUsageData).toMatchObject({ sessionPercent: 0, weeklyPercent: 12 }));
		expect(screen.getByText(i18n.t("settings:aiAccounts.stats.failoverOff"))).toBeInTheDocument();
	});

	it("shows a failed load and retries it in place", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		getAllConnectors.mockRejectedValueOnce(new Error("offline"));
		const user = userEvent.setup();
		renderSection();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(i18n.t("settings:sections.accounts.providers.loadError"));
		await user.click(screen.getByRole("button", { name: i18n.t("settings:common.retry") }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(getAllConnectors).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});

	it("logs a provider list that could not be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		getStaticProviders.mockRejectedValue(new Error("broken"));
		renderSection();
		await waitFor(() => expect(error).toHaveBeenCalledWith("[AiAccounts] Failed to load providers:", expect.any(Error)));
		error.mockRestore();
	});

	it("loads nothing while closed", async () => {
		renderSection(false);
		await waitFor(() => expect(getStaticProviders).toHaveBeenCalled());
		expect(getAllConnectors).not.toHaveBeenCalled();
		expect(tests()).toEqual([]);
	});
});
