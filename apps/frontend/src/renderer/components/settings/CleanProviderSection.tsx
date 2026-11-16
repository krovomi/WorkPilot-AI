/**
 * Settings → AI accounts: every provider the app can run on, how each signs
 * in and whether it answers, then the automatic failover between them.
 */
import { ProviderService } from "@shared/services/providerService";
import type { AppSettings } from "@shared/types/settings";
import { type CanonicalProvider, getStaticProviders } from "@shared/utils/providers";
import { AlertCircle, ArrowDownUp, Plug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useToast } from "@/hooks/use-toast";
import { saveSettings as saveSettingsToDisk, useSettingsStore } from "@/stores/settings-store";
import { loadClaudeProfiles, useClaudeProfileStore } from "../../stores/claude-profile-store";
import { CharterButton, Notice, ScanLine, Stat, Stats, Tabs } from "../charter";
import { useProviderContext } from "../ProviderContext";
import { Dialog, DialogContent } from "../ui/dialog";
import { type ProviderCardData, providerCardStatus } from "./CleanProviderCard";
import { CleanProviderGrid } from "./CleanProviderGrid";
import { buildFailoverAccounts, isAccountExcluded } from "./failover-accounts";
import { GlobalAutoSwitching } from "./GlobalAutoSwitching";
import { getAllConnectors } from "./multiconnector/utils";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import { providerKeyInfo } from "./provider-key-info";
import { consumeProviderReauthRequest, onProviderReauthRequest } from "./reauth-request";
import { SettingsSection } from "./SettingsSection";
import { useProviderUsage } from "./use-provider-usage";

type Settings = AppSettings & Record<string, unknown>;
type View = "providers" | "failover";
interface TestResult {
	readonly date: string;
	readonly success: boolean;
}

interface CleanProviderSectionProps {
	settings: Settings;
	onSettingsChange: (settings: Settings) => void;
	isOpen: boolean;
}

/** The connection tests saved in the settings (`testResult_<provider>`). */
export function savedTestResults(settings: Readonly<Record<string, unknown>>): Map<string, TestResult> {
	const results = new Map<string, TestResult>();
	for (const [key, value] of Object.entries(settings)) {
		if (!key.startsWith("testResult_")) continue;
		const result = value as { date?: unknown; success?: unknown } | null;
		if (typeof result?.date === "string") {
			results.set(key.slice("testResult_".length), { date: result.date, success: result.success === true });
		}
	}
	return results;
}

export function CleanProviderSection({
	onSettingsChange: propsOnSettingsChange,
	isOpen,
}: Readonly<CleanProviderSectionProps>) {
	const { t } = useTranslation("settings");
	const { toast } = useToast();
	const [view, setView] = useState<View>("providers");
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [testingProviders, setTestingProviders] = useState<ReadonlySet<string>>(new Set());
	const [selectedProvider, setSelectedProvider] = useState<ProviderCardData | null>(null);
	const [configDialogOpen, setConfigDialogOpen] = useState(false);
	const [autoStartOAuth, setAutoStartOAuth] = useState(false);
	const [staticProviders, setStaticProviders] = useState<CanonicalProvider[]>([]);
	const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>({});
	const [copilotLogin, setCopilotLogin] = useState<string>();
	const [failoverEnabled, setFailoverEnabled] = useState<boolean>();

	const { profiles, activeApiProfileId, settings } = useSettingsStore(
		useShallow((s) => ({ profiles: s.profiles, activeApiProfileId: s.activeProfileId, settings: s.settings as Settings })),
	);
	const claudeProfiles = useClaudeProfileStore((s) => s.profiles);
	const activeClaudeProfileId = useClaudeProfileStore((s) => s.activeProfileId);
	const { selectedProvider: defaultProvider, setSelectedProvider: setContextProvider } = useProviderContext();
	const { claudeUsage, providerUsage } = useProviderUsage(isOpen);
	const testResults = useMemo(() => savedTestResults(settings), [settings]);

	const saveSettings = useCallback(
		async (next: Settings) => {
			// A change that would be lost on restart is not acknowledged.
			const saved = await saveSettingsToDisk(next);
			if (saved) propsOnSettingsChange(next);
			return saved;
		},
		[propsOnSettingsChange],
	);

	const loadConnectors = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			await getAllConnectors();
		} catch (err) {
			console.error("[AiAccounts] Failed to load connectors:", err);
			setError(t("sections.accounts.providers.loadError"));
		} finally {
			setIsLoading(false);
		}
	}, [t]);

	useEffect(() => {
		if (!isOpen) return;
		void loadConnectors();
		void loadClaudeProfiles();
		const api = globalThis.electronAPI;
		api.checkCopilotAuth?.()
			.then((result) => setCopilotLogin(result.data?.authenticated ? result.data.username : undefined))
			.catch(() => setCopilotLogin(undefined));
		api.getAutoSwitchSettings?.()
			.then((result) => {
				if (result.success) setFailoverEnabled(result.data?.enabled === true);
			})
			.catch(() => undefined);
	}, [isOpen, loadConnectors]);

	// Closing the dialog can change a sign-in managed elsewhere (Copilot's gh).
	// biome-ignore lint/correctness/useExhaustiveDependencies: closing the dialog invalidates CLI authentication status.
	useEffect(() => {
		let cancelled = false;
		getStaticProviders(profiles, settings)
			.then((result) => {
				if (cancelled) return;
				setStaticProviders(result.providers);
				setProviderStatus(result.status);
			})
			.catch((err) => console.error("[AiAccounts] Failed to load providers:", err));
		return () => {
			cancelled = true;
		};
	}, [profiles, settings, configDialogOpen]);

	const activeClaudeUsage = useMemo(() => {
		const all = [...claudeUsage.values()];
		return all.find((usage) => usage.isActive) ?? all[0];
	}, [claudeUsage]);

	const providers = useMemo<ProviderCardData[]>(
		() =>
			staticProviders.map((provider) => {
				const connected = providerStatus[provider.name] === true;
				const test = testResults.get(provider.name);
				const other = providerUsage.get(provider.name);
				const usage =
					provider.name === "anthropic"
						? activeClaudeUsage
						: other && {
								profileId: provider.name,
								profileName: provider.label,
								sessionPercent: other.sessionPercent ?? 0,
								weeklyPercent: other.weeklyPercent ?? 0,
								isAuthenticated: true,
								isRateLimited: false,
								availabilityScore: 100,
								isActive: true,
								needsReauthentication: other.needsReauthentication,
							};
				return {
					id: provider.name,
					name: provider.label,
					description: t(`sections.accounts.providers.${provider.name}`, { defaultValue: provider.description }),
					isConfigured: connected,
					isWorking: connected && test ? test.success : undefined,
					lastTested: test?.date,
					realUsageData: usage,
					realApiKeyInfo: providerKeyInfo(provider.name, profiles, settings, connected),
				};
			}),
		[staticProviders, providerStatus, testResults, providerUsage, activeClaudeUsage, profiles, settings, t],
	);

	const failoverAccounts = useMemo(
		() =>
			buildFailoverAccounts({
				claudeProfiles,
				activeClaudeProfileId,
				apiProfiles: profiles,
				activeApiProfileId,
				providers: staticProviders,
				connected: providerStatus,
				usage: claudeUsage,
				copilotLogin,
			}),
		[claudeProfiles, activeClaudeProfileId, profiles, activeApiProfileId, staticProviders, providerStatus, claudeUsage, copilotLogin],
	);
	const excluded = useMemo(() => settings.disabledAutoSwitchProviders ?? [], [settings]);
	const chainLength = failoverAccounts.filter((account) => !isAccountExcluded(account, excluded)).length;

	const nameOf = useCallback(
		(providerId: string) => providers.find((p) => p.id === providerId)?.name ?? providerId,
		[providers],
	);

	const runTest = useCallback(
		async (providerId: string, quiet: boolean) => {
			setTestingProviders((prev) => new Set(prev).add(providerId));
			// ProviderService answers a failed call; saving answers false.
			try {
				const result = await ProviderService.testProvider(providerId);
				const success = result.success === true;
				await saveSettings({
					...(useSettingsStore.getState().settings as Settings),
					[`testResult_${providerId}`]: { date: new Date().toISOString(), success },
				});
				if (quiet) return;
				const details = result.details as { modelCount?: unknown } | undefined;
				const models = typeof details?.modelCount === "number" ? details.modelCount : 0;
				toast(
					success
						? {
								title: t("sections.accounts.providerCard.testSuccess"),
								description: models
									? t("aiAccounts.toast.testOkModels", { name: nameOf(providerId), count: models })
									: t("sections.accounts.providerCard.testSuccessDescription", { providerName: nameOf(providerId) }),
							}
						: {
								variant: "destructive",
								title: t("sections.accounts.providerCard.testError"),
								description: t("sections.accounts.providerCard.testErrorDescription", {
									providerName: nameOf(providerId),
									error: result.message,
								}),
							},
				);
			} finally {
				setTestingProviders((prev) => {
					const next = new Set(prev);
					next.delete(providerId);
					return next;
				});
			}
		},
		[saveSettings, toast, t, nameOf],
	);

	// A connected provider never tested is tested once, quietly, so its card
	// can say whether it answers.
	const autoTested = useRef(new Set<string>());
	useEffect(() => {
		if (!isOpen) return;
		for (const provider of providers) {
			if (!provider.isConfigured || provider.lastTested || autoTested.current.has(provider.id)) continue;
			autoTested.current.add(provider.id);
			void runTest(provider.id, true);
		}
	}, [isOpen, providers, runTest]);

	const setDefaultProvider = useCallback(
		async (providerId: string) => {
			// The default provider seeds new tasks and the features without a
			// selector of their own; tasks keep their own engine.
			setContextProvider(providerId);
			useSettingsStore.getState().updateSettings({ selectedProvider: providerId });
			try {
				localStorage.setItem("selectedProvider", providerId);
			} catch {
				// Storage can be unavailable; the settings keep the choice.
			}
			try {
				await globalThis.electronAPI?.selectProvider?.(providerId);
			} catch (err) {
				console.error("[AiAccounts] Failed to select the provider:", err);
			}
			globalThis.dispatchEvent(
				new CustomEvent("providerChanged", { detail: { provider: providerId, timestamp: Date.now() } }),
			);
		},
		[setContextProvider],
	);

	const openConfig = useCallback(
		(providerId: string, options?: { startOAuth?: boolean }) => {
			const provider = providers.find((p) => p.id === providerId);
			if (!provider) return;
			setSelectedProvider(provider);
			setAutoStartOAuth(options?.startOAuth === true);
			setConfigDialogOpen(true);
		},
		[providers],
	);

	// "Reconnect" from the re-auth toast: start the provider's login once its
	// card exists (providers load after mount).
	useEffect(() => {
		const answer = () => {
			if (providers.length === 0) return;
			const requested = consumeProviderReauthRequest();
			const provider = requested && providers.find((p) => p.id === requested || p.name === requested);
			if (!provider) return;
			setView("providers");
			openConfig(provider.id, { startOAuth: true });
		};
		answer();
		return onProviderReauthRequest(answer);
	}, [providers, openConfig]);

	const saveExcluded = useCallback(
		(next: string[]) =>
			saveSettings({ ...(useSettingsStore.getState().settings as Settings), disabledAutoSwitchProviders: next }),
		[saveSettings],
	);
	const providerLabel = useCallback(
		(provider: string) => staticProviders.find((p) => p.name === provider)?.label ?? provider,
		[staticProviders],
	);

	const connectedCount = providers.filter((p) => p.isConfigured).length;
	const attentionCount = providers.filter((p) => {
		const status = providerCardStatus(p);
		return status === "reauth" || status === "failing";
	}).length;
	const defaultLabel = defaultProvider ? providerLabel(defaultProvider) : t("aiAccounts.stats.none");

	return (
		<SettingsSection title={t("aiAccounts.title")} description={t("aiAccounts.description")}>
			{isLoading ? (
				<ScanLine label={t("aiAccounts.loading")} />
			) : error ? (
				<Notice tone="red" icon={AlertCircle} role="alert">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span>{error}</span>
						<CharterButton size="sm" onClick={() => void loadConnectors()}>
							{t("common.retry")}
						</CharterButton>
					</div>
				</Notice>
			) : (
				<>
					<Stats>
						<Stat
							label={t("aiAccounts.stats.connected")}
							value={t("aiAccounts.stats.connectedValue", { connected: connectedCount, total: providers.length })}
							tone={connectedCount > 0 ? "green" : "muted"}
						/>
						<Stat label={t("aiAccounts.stats.default")} value={defaultLabel} tone="accent" />
						<Stat
							label={t("aiAccounts.stats.failover")}
							value={
								failoverEnabled
									? t("aiAccounts.stats.failoverOn", { count: chainLength })
									: t("aiAccounts.stats.failoverOff")
							}
							tone={failoverEnabled ? "green" : "muted"}
						/>
						<Stat
							label={t("aiAccounts.stats.attention")}
							value={attentionCount}
							tone={attentionCount > 0 ? "amber" : "muted"}
						/>
					</Stats>

					{connectedCount === 0 && providers.length > 0 && (
						<Notice tone="amber" icon={Plug}>
							{t("aiAccounts.noneConnected")}
						</Notice>
					)}

					<Tabs<View>
						label={t("aiAccounts.tabs.label")}
						className="px-0 pb-0"
						value={view}
						onChange={setView}
						tabs={[
							{ id: "providers", label: t("aiAccounts.tabs.providers"), icon: Plug, count: providers.length },
							{ id: "failover", label: t("aiAccounts.tabs.failover"), icon: ArrowDownUp, count: chainLength },
						]}
					/>

					{view === "providers" ? (
						<CleanProviderGrid
							providers={providers}
							defaultProvider={defaultProvider}
							testingProviders={testingProviders}
							onConfigure={openConfig}
							onTest={(id) => void runTest(id, false)}
							onSetDefault={(id) => void setDefaultProvider(id)}
						/>
					) : (
						<GlobalAutoSwitching
							accounts={failoverAccounts}
							excluded={excluded}
							onExcludedChange={saveExcluded}
							providerLabel={providerLabel}
							onSummaryChange={({ enabled }) => setFailoverEnabled(enabled)}
						/>
					)}
				</>
			)}

			{/* Wide enough for the model lists of Hugging Face. */}
			<Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
				<DialogContent className="max-w-[1200px] max-h-[98vh]">
					<ProviderConfigDialog
						isOpen={configDialogOpen}
						onOpenChange={setConfigDialogOpen}
						provider={selectedProvider}
						settings={settings}
						onSettingsChange={saveSettings}
						onTest={(id) => runTest(id, false)}
						useSheet={true}
						onProviderActivated={(id) => void setDefaultProvider(id)}
						autoStartOAuth={autoStartOAuth}
					/>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}
