import { getProvider as getRegistryProvider } from "@shared/services/providerRegistry";
import { detectProvider } from "@shared/utils/provider-detection";
import { getStaticProviders } from "@shared/utils/providers";
import {
	Activity,
	AlertCircle,
	ArrowDownUp,
	BarChart3,
	RefreshCw,
	Router,
	Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { AppSettings } from "../../../shared/types";
import {
	loadClaudeProfiles as loadGlobalClaudeProfiles,
	useClaudeProfileStore,
} from "../../stores/claude-profile-store";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { useShallow } from "zustand/react/shallow";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
	AccountPriorityList,
	type UnifiedAccount,
} from "./AccountPriorityList";

interface GlobalAutoSwitchingProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
	readonly isOpen: boolean;
	/** Pre-computed provider status from the parent grid (includes OAuth enrichment).
	 *  When provided, used as the source of truth to filter providers — guarantees
	 *  the priority list is ISO with what the grid shows. */
	readonly providerStatus?: Record<string, boolean>;
}

export function GlobalAutoSwitching({
	settings,
	onSettingsChange,
	isOpen,
	providerStatus,
}: GlobalAutoSwitchingProps) {
	const { t } = useTranslation("settings");
	const { toast } = useToast();
	const { profiles: apiProfiles, activeProfileId: activeApiProfileId } = useSettingsStore(
		useShallow((s) => ({
			profiles: s.profiles,
			activeProfileId: s.activeProfileId,
		})),
	);
	// Select only the fields we need to avoid re-renders from unrelated store changes (e.g. isLoading)
	const claudeProfiles = useClaudeProfileStore((s) => s.profiles);
	const activeClaudeProfileId = useClaudeProfileStore((s) => s.activeProfileId);
	const [isLoading, setIsLoading] = useState(false);

	// Priority order state
	const [priorityOrder, setPriorityOrder] = useState<string[]>([]);
	const [isSavingPriority, setIsSavingPriority] = useState(false);

	// The GitHub account Copilot is signed in with, shown on its row.
	const [copilotUsername, setCopilotUsername] = useState<string | undefined>();

	// Unified accounts state
	const [unifiedAccounts, setUnifiedAccounts] = useState<UnifiedAccount[]>([]);

	// Auto-switching state - initialize from settings
	const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(
		settings.autoSwitchEnabled ?? false,
	);
	const [proactiveEnabled, setProactiveEnabled] = useState(
		settings.proactiveEnabled ?? true,
	);
	const [sessionThreshold, setSessionThreshold] = useState(
		settings.sessionThreshold ?? 95,
	);
	const [rateLimitEnabled, setRateLimitEnabled] = useState(
		settings.rateLimitEnabled ?? false,
	);
	const [authFailureEnabled, setAuthFailureEnabled] = useState(
		settings.authFailureEnabled ?? false,
	);
	const [routingStrategy, setRoutingStrategy] = useState(
		settings.routingStrategy ?? "best_performance",
	);

	// Load Claude profiles on mount
	useEffect(() => {
		loadGlobalClaudeProfiles();
	}, []);

	// Read the GitHub account Copilot is signed in with when the section opens.
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;
		globalThis.electronAPI
			.checkCopilotAuth()
			.then((result) => {
				if (cancelled) return;
				setCopilotUsername(result?.success && result.data?.authenticated ? result.data.username : undefined);
			})
			.catch((err) => {
				console.error("[GlobalAutoSwitching] Copilot auth check failed:", err);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen]);

	// Sync autoSwitchEnabled with settings
	useEffect(() => {
		setAutoSwitchEnabled(settings.autoSwitchEnabled ?? false);
	}, [settings.autoSwitchEnabled]);

	// Sync other auto-switching settings with settings
	useEffect(() => {
		setProactiveEnabled(settings.proactiveEnabled ?? true);
		setSessionThreshold(settings.sessionThreshold ?? 95);
		setRateLimitEnabled(settings.rateLimitEnabled ?? false);
		setAuthFailureEnabled(settings.authFailureEnabled ?? false);
		setRoutingStrategy(settings.routingStrategy ?? "best_performance");
	}, [
		settings.proactiveEnabled,
		settings.sessionThreshold,
		settings.rateLimitEnabled,
		settings.authFailureEnabled,
		settings.routingStrategy,
	]);

	// Build unified accounts list — getStaticProviders is the single source of truth,
	// same as the provider grid, to guarantee ISO between the two views.
	const buildUnifiedAccounts = async (): Promise<UnifiedAccount[]> => {
		const unifiedList: UnifiedAccount[] = [];
		const representedProviders = new Set<string>();

		const getRegistryLabel = (providerName: string): string => {
			const regProvider = getRegistryProvider(providerName);
			return regProvider?.label || providerName;
		};

		// Step 1: OAuth Claude profiles → always displayed as "Anthropic (Claude)"
		claudeProfiles.forEach((profile) => {
			unifiedList.push({
				id: `oauth-${profile.id}`,
				name: profile.name,
				type: "oauth",
				displayName: getRegistryLabel("anthropic"), // "Anthropic (Claude)" — not the account nickname
				identifier: profile.email || t("accounts.priority.noEmail"),
				isActive: profile.id === activeClaudeProfileId && !activeApiProfileId,
				isNext: false,
				isAvailable: profile.isAuthenticated ?? false,
				hasUnlimitedUsage: false,
			});
			representedProviders.add(profile.name);
			representedProviders.add("anthropic"); // block duplicate API Anthropic entry
		});

		// Step 2: All other providers via getStaticProviders — same source as the provider grid
		// Use parent's providerStatus when available (already OAuth-enriched, matches the grid exactly).
		// Fall back to getStaticProviders for standalone usage (e.g. outside CleanProviderSection).
		const { providers: staticProviders, status: fallbackStatus } =
			await getStaticProviders(
				apiProfiles,
				settings as unknown as Record<string, unknown>,
			);
		const effectiveStatus = providerStatus ?? fallbackStatus;

		// Matching API profile for URL-based identifier
		const findApiProfile = (providerName: string) =>
			apiProfiles.find((p) => {
				if (p.baseUrl) {
					const detected = detectProvider(p.baseUrl);
					if (detected === providerName) return true;
					if (providerName === "ollama" && detected === "ollama_local") return true;
				}
				const n = p.name?.toLowerCase() || "";
				if (providerName === "openai") return n.includes("openai");
				if (providerName === "google") return n.includes("gemini");
				if (providerName === "mistral") return n.includes("mistral");
				if (providerName === "deepseek") return n.includes("deepseek");
				if (providerName === "grok") return n.includes("grok");
				if (providerName === "windsurf") return n.includes("windsurf");
				if (providerName === "ollama") return n.includes("ollama");
				return false;
			});

		for (const sp of staticProviders) {
			if (representedProviders.has(sp.name)) continue;
			if (!effectiveStatus[sp.name]) continue; // not configured/authenticated — skip (same filter as grid)

			const matchingProfile = findApiProfile(sp.name);
			const identifier =
				sp.name === "copilot" && copilotUsername
					? `@${copilotUsername}`
					: matchingProfile?.baseUrl ||
						matchingProfile?.name ||
						t("accounts.priority.providerAuth");

			unifiedList.push({
				id: matchingProfile ? `api-${matchingProfile.id}` : sp.name,
				name: sp.name,
				type: "api",
				displayName: getRegistryLabel(sp.name),
				identifier,
				isActive: matchingProfile
					? matchingProfile.id === activeApiProfileId
					: false,
				isNext: false,
				isAvailable: true,
				hasUnlimitedUsage: sp.name !== "copilot",
			});
			representedProviders.add(sp.name);
		}

		const filteredList = unifiedList.filter((account) => account.isAvailable);

		if (priorityOrder.length > 0) {
			filteredList.sort((a, b) => {
				const findIndex = (account: UnifiedAccount): number => {
					let idx = priorityOrder.indexOf(account.id);
					if (idx !== -1) return idx;
					idx = priorityOrder.indexOf(account.name);
					if (idx !== -1) return idx;
					return -1;
				};
				const aPos = findIndex(a) === -1 ? Infinity : findIndex(a);
				const bPos = findIndex(b) === -1 ? Infinity : findIndex(b);
				return aPos - bPos;
			});
		}
		return filteredList;
	};

	// Load unified accounts when the underlying data changes.
	// NOTE: Do NOT put `buildUnifiedAccounts` itself in the deps array — it is a
	// plain function recreated on every render, which would cause the effect to fire
	// every render → setUnifiedAccounts → re-render → new function → infinite loop.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the data buildUnifiedAccounts reads
	useEffect(() => {
		let cancelled = false;
		buildUnifiedAccounts()
			.then((accounts) => {
				if (!cancelled) setUnifiedAccounts(accounts);
			})
			.catch((err) => console.error("[GlobalAutoSwitching] Failed to list accounts:", err));
		return () => {
			cancelled = true;
		};
	}, [
		claudeProfiles,
		activeClaudeProfileId,
		activeApiProfileId,
		copilotUsername,
		providerStatus,
		priorityOrder,
		apiProfiles,
	]);

	// Load priority order from ClaudeProfileManager
	const loadPriorityOrder = async () => {
		try {
			const result = await globalThis.electronAPI.getAccountPriorityOrder();
			if (result.success && result.data) {
				setPriorityOrder(result.data);
			}
		} catch (err) {
			console.warn("[GlobalAutoSwitching] Failed to load priority order:", err);
		}
	};

	// Save priority order
	const handlePriorityReorder = async (newOrder: string[]) => {
		const savedOrder = priorityOrder;
		setPriorityOrder(newOrder);
		setIsSavingPriority(true);
		try {
			// Save to ClaudeProfileManager (single source of truth)
			const result = await globalThis.electronAPI.setAccountPriorityOrder(newOrder);
			if (!result.success) throw new Error(result.error);
		} catch (err) {
			console.warn("[GlobalAutoSwitching] Failed to save priority order:", err);
			// The list goes back to the order that is saved, not the one refused.
			setPriorityOrder(savedOrder);
			toast({
				variant: "destructive",
				title: t("autoSwitching.toast.error"),
				description: t("autoSwitching.toast.errorDescription"),
			});
		} finally {
			setIsSavingPriority(false);
		}
	};

	// Load data when section is opened. Only then: loadPriorityOrder is a new
	// function at every render, and the order it loads renders again, so
	// depending on it read the order and the profiles again and again, forever.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the section opens, not when its loader changes
	useEffect(() => {
		if (isOpen) {
			loadPriorityOrder();
			// Also refresh Claude profiles when opening
			loadGlobalClaudeProfiles();
		}
	}, [isOpen]);

	const handleToggleAutoSwitch = async (enabled: boolean) => {
		// Update local state immediately for better UX
		setAutoSwitchEnabled(enabled);

		setIsLoading(true);
		try {
			// Save to settings
			const success = await saveSettings({ autoSwitchEnabled: enabled });

			if (success) {
				// Also propagate to parent
				onSettingsChange({
					...settings,
					autoSwitchEnabled: enabled,
				});

				toast({
					title: enabled
						? t("settings:autoSwitching.enabled")
						: t("settings:autoSwitching.disabled"),
					description: enabled
						? t("settings:autoSwitching.enabledDescription")
						: t("settings:autoSwitching.disabledDescription"),
				});
			} else {
				// Revert state if save failed
				setAutoSwitchEnabled(!enabled);
				throw new Error("Failed to save settings");
			}
		} catch (error) {
			// Revert state if save failed
			setAutoSwitchEnabled(!enabled);
			console.error(
				"[GlobalAutoSwitching] Failed to toggle auto-switch:",
				error,
			);
			toast({
				variant: "destructive",
				title: t("settings:autoSwitching.toast.error"),
				description: t("settings:autoSwitching.toast.errorDescription"),
			});
		} finally {
			setIsLoading(false);
		}
	};

	const handleStrategyChange = (strategy: typeof routingStrategy) =>
		handleUpdateSetting({ routingStrategy: strategy });

	// Each value shows at once; one that could not be saved goes back to the
	// saved value.
	const applyLocally = (values: Partial<AppSettings>) => {
		if (values.proactiveEnabled !== undefined) setProactiveEnabled(values.proactiveEnabled);
		if (values.sessionThreshold !== undefined) setSessionThreshold(values.sessionThreshold);
		if (values.rateLimitEnabled !== undefined) setRateLimitEnabled(values.rateLimitEnabled);
		if (values.authFailureEnabled !== undefined) setAuthFailureEnabled(values.authFailureEnabled);
		if (values.routingStrategy !== undefined) setRoutingStrategy(values.routingStrategy);
	};

	const handleUpdateSetting = async (updates: Partial<AppSettings>) => {
		applyLocally(updates);
		setIsLoading(true);
		try {
			if (!(await saveSettings(updates))) throw new Error("Failed to save settings");
			// Also propagate to parent
			onSettingsChange({
				...settings,
				...updates,
			});
		} catch (error) {
			console.error("[GlobalAutoSwitching] Failed to update settings:", error);
			applyLocally({
				proactiveEnabled: settings.proactiveEnabled ?? true,
				sessionThreshold: settings.sessionThreshold ?? 95,
				rateLimitEnabled: settings.rateLimitEnabled ?? false,
				authFailureEnabled: settings.authFailureEnabled ?? false,
				routingStrategy: settings.routingStrategy ?? "best_performance",
			});
			toast({
				variant: "destructive",
				title: t("settings:autoSwitching.toast.error"),
				description: t("settings:autoSwitching.toast.errorDescription"),
			});
		} finally {
			setIsLoading(false);
		}
	};

	// The threshold follows the slider and is saved once it is let go, not
	// at every step of the drag.
	const commitSessionThreshold = () => {
		if (sessionThreshold !== (settings.sessionThreshold ?? 95)) {
			void handleUpdateSetting({ sessionThreshold });
		}
	};

	return (
		<div className="space-y-6">
			{/* Master toggle */}
			<div className="flex items-center justify-between">
				<div>
					<Label htmlFor="auto-switch-enabled" className="text-sm font-medium">
						{t("settings:autoSwitching.enableLabel")}
					</Label>
					<p className="text-xs text-muted-foreground mt-1">
						{t("settings:autoSwitching.enableDescription")}
					</p>
				</div>
				<Switch
					id="auto-switch-enabled"
					checked={autoSwitchEnabled}
					onCheckedChange={handleToggleAutoSwitch}
					disabled={isLoading}
				/>
			</div>

			{autoSwitchEnabled && (
				<>
					{/* Routing Strategy */}
					<div className="space-y-3">
						<div>
							<Label className="text-sm font-medium flex items-center gap-2">
								<Router className="h-3.5 w-3.5" />
								{t("llmRouter.routingStrategy.title")}
							</Label>
							<p className="text-xs text-muted-foreground mt-1">
								{t("llmRouter.routingStrategy.description")}
							</p>
						</div>
						<div className="grid grid-cols-2 gap-2">
							{(
								[
									{
										id: "best_performance",
										label: t("llmRouter.routingStrategy.bestPerformance"),
										desc: t(
											"llmRouter.routingStrategy.bestPerformanceDescription",
										),
										icon: <Zap className="h-3.5 w-3.5" />,
									},
									{
										id: "cheapest",
										label: t("llmRouter.routingStrategy.cheapest"),
										desc: t("llmRouter.routingStrategy.cheapestDescription"),
										icon: <ArrowDownUp className="h-3.5 w-3.5" />,
									},
									{
										id: "lowest_latency",
										label: t("llmRouter.routingStrategy.lowestLatency"),
										desc: t(
											"llmRouter.routingStrategy.lowestLatencyDescription",
										),
										icon: <BarChart3 className="h-3.5 w-3.5" />,
									},
									{
										id: "round_robin",
										label: t("llmRouter.routingStrategy.roundRobin"),
										desc: t("llmRouter.routingStrategy.roundRobinDescription"),
										icon: <Router className="h-3.5 w-3.5" />,
									},
								] as const
							).map((s) => (
								<button
									key={s.id}
									type="button"
									onClick={() => handleStrategyChange(s.id)}
									disabled={isLoading}
									className={cn(
										"flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors",
										routingStrategy === s.id
											? "border-primary bg-primary/5 ring-1 ring-primary"
											: "border-border hover:bg-accent/50",
									)}
								>
									<span
										className={cn(
											"mt-0.5 shrink-0",
											routingStrategy === s.id
												? "text-primary"
												: "text-muted-foreground",
										)}
									>
										{s.icon}
									</span>
									<div className="min-w-0">
										<span className="text-xs font-medium block">{s.label}</span>
										<p className="text-3xs text-muted-foreground leading-tight mt-0.5">
											{s.desc}
										</p>
									</div>
								</button>
							))}
						</div>
					</div>

					{/* Proactive Monitoring */}
					<div className="pl-6 space-y-4 pt-2 border-l-2 border-primary/20">
						<div className="flex items-center justify-between">
							<div>
								<Label htmlFor="auto-switch-proactive" className="text-sm font-medium flex items-center gap-2">
									<Activity className="h-3.5 w-3.5" />
									{t("settings:autoSwitching.proactiveMonitoring")}
								</Label>
								<p className="text-xs text-muted-foreground mt-1">
									{t("settings:autoSwitching.proactiveDescription")}
								</p>
							</div>
							<Switch
								id="auto-switch-proactive"
								checked={proactiveEnabled}
								onCheckedChange={(value) =>
									handleUpdateSetting({ proactiveEnabled: value })
								}
								disabled={isLoading}
							/>
						</div>

						{/* Session threshold */}
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label htmlFor="session-threshold" className="text-sm">
									{t("settings:autoSwitching.sessionThreshold")}
								</Label>
								<span className="text-sm font-mono">{sessionThreshold}%</span>
							</div>
							<div className="flex items-center gap-2">
								<input
									id="session-threshold"
									type="range"
									min={0}
									max={99}
									step={1}
									value={sessionThreshold}
									onChange={(e) => setSessionThreshold(Number.parseInt(e.target.value, 10))}
									onPointerUp={commitSessionThreshold}
									onKeyUp={commitSessionThreshold}
									onBlur={commitSessionThreshold}
									className="flex-1"
								/>
							</div>
							<p className="text-xs text-muted-foreground">
								{t("settings:autoSwitching.sessionThresholdDescription")}
							</p>
						</div>

						{/* Rate limit switching */}
						<div className="flex items-center justify-between">
							<div>
								<Label htmlFor="auto-switch-rate-limit" className="text-sm font-medium flex items-center gap-2">
									<AlertCircle className="h-3.5 w-3.5" />
									{t("settings:autoSwitching.rateLimitSwitching")}
								</Label>
								<p className="text-xs text-muted-foreground mt-1">
									{t("settings:autoSwitching.rateLimitDescription")}
								</p>
							</div>
							<Switch
								id="auto-switch-rate-limit"
								checked={rateLimitEnabled}
								onCheckedChange={(value) =>
									handleUpdateSetting({ rateLimitEnabled: value })
								}
								disabled={isLoading}
							/>
						</div>

						{/* Auth failure switching */}
					</div>
					<div className="flex items-center justify-between">
						<div>
							<Label htmlFor="auto-switch-auth-failure" className="text-sm font-medium">
								{t("settings:autoSwitching.authFailureSwitching")}
							</Label>
							<p className="text-xs text-muted-foreground mt-1">
								{t("settings:autoSwitching.authFailureDescription")}
							</p>
						</div>
						<Switch
							id="auto-switch-auth-failure"
							checked={authFailureEnabled}
							onCheckedChange={(value) =>
								handleUpdateSetting({ authFailureEnabled: value })
							}
							disabled={isLoading}
						/>
					</div>
				</>
			)}

			{/* Account Priority Order */}
			{autoSwitchEnabled && unifiedAccounts.length > 0 && (
				<div className="pt-4 border-t border-border/50">
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<RefreshCw className="h-4 w-4 text-muted-foreground" />
							<h4 className="text-sm font-medium text-foreground">
								{t("settings:autoSwitching.priorityOrder.title")}
							</h4>
						</div>

						<AccountPriorityList
							accounts={unifiedAccounts}
							onReorder={handlePriorityReorder}
							isLoading={isSavingPriority}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
