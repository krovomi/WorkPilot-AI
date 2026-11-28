/**
 * AuthStatusIndicator - Dumb display component for authentication status
 *
 * Shows how the provider the usage lens observes is signed in, as an icon
 * badge next to the lens (which already names the provider):
 * - Subscription (Claude Code OAuth, ChatGPT, Copilot…): Lock icon
 * - API Profile or API key: Key icon and provider-specific colors
 * The provider's name is in the aria-label and the tooltip.
 *
 * The plan shown is the one the usage snapshot reports (`usage-plan-store`),
 * which the main process asks the provider for; the plan stored with a
 * Claude profile at login is only the fallback, because it is not updated
 * when the account changes plan (Pro → Max).
 *
 * This component does NOT perform any authentication detection.
 * Auth type is derived purely from selectedProvider + profiles data:
 * - If selectedProvider matches an API profile -> type 'profile'
 * - If selectedProvider is 'anthropic' with no API profile -> type 'oauth'
 * - Otherwise -> type 'provider'
 *
 * Usage data comes from UsageMonitor via IPC push events.
 */

import { claudePlanName } from "@shared/utils/plan-names";
import {
	type ApiProvider,
	detectProvider,
	getProviderBadgeColor,
	getProviderLabel,
} from "@shared/utils/provider-detection";
import {
	ExternalLink,
	Fingerprint,
	Key,
	Lock,
	Server,
	Shield,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeProfileStore } from "@/stores/claude-profile-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usagePlanKey, useUsagePlanStore } from "@/stores/usage-plan-store";
import { useShallow } from "zustand/react/shallow";
import { useProviderContext } from "./ProviderContext";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";

/**
 * OAuth fallback state when no API profile is active (e.g. Claude Code subscription)
 */
const OAUTH_FALLBACK = {
	type: "oauth" as const,
	provider: "anthropic",
} as const;

/** A provider the badges do not know (LM Studio, a custom one…) keeps its own name. */
function badgeColorOf(provider: string): string {
	return (
		getProviderBadgeColor(provider as ApiProvider) ??
		getProviderBadgeColor("unknown")
	);
}

type GithubCliStatus = {
	available: boolean;
	isAuth?: boolean;
	username?: string;
};

type WindsurfAccount = {
	userName?: string;
	planName?: string;
	usageInfo?: {
		usedMessages: number;
		totalMessages: number;
		usedFlowActions: number;
		totalFlowActions: number;
	};
};

export function AuthStatusIndicator() {
	const { profiles, activeProfileId } = useSettingsStore(
		useShallow((s) => ({
			profiles: s.profiles,
			activeProfileId: s.activeProfileId,
		})),
	);
	const { t } = useTranslation(["common"]);
	// The provider the usage badges observe: the running tasks', unless the
	// person picked one (UsageLensSelector). Not the default provider.
	const { usageProvider: selectedProvider } = useProviderContext();

	// Track GitHub CLI status for Copilot provider
	const [githubStatus, setGithubStatus] = useState<GithubCliStatus | null>(
		null,
	);
	const [isLoadingGithubStatus, setIsLoadingGithubStatus] = useState(false);

	// Track Windsurf account info
	const [windsurfAccount, setWindsurfAccount] =
		useState<WindsurfAccount | null>(null);
	const [isLoadingWindsurfAccount, setIsLoadingWindsurfAccount] =
		useState(false);

	// The plan stored with the Claude profile at login: a fallback only, it is
	// not updated when the account changes plan.
	const storedClaudePlanName = useClaudeProfileStore((s) => {
		const profile = s.profiles.find((p) => p.id === s.activeProfileId);
		return claudePlanName(profile?.subscriptionType, profile?.rateLimitTier);
	});

	// Fetch GitHub CLI status when Copilot provider is selected. An answer that
	// arrives after the provider changed is dropped.
	useEffect(() => {
		setGithubStatus(null);
		if (selectedProvider !== "copilot") {
			setIsLoadingGithubStatus(false);
			return;
		}
		let current = true;
		setIsLoadingGithubStatus(true);
		(async () => {
			let status: GithubCliStatus = { available: false };
			try {
				const result = await globalThis.electronAPI.getGithubCliStatus();
				if (result.success && result.data) status = result.data;
			} catch (error) {
				console.warn(
					"[AuthStatusIndicator] Failed to fetch GitHub CLI status:",
					error,
				);
			}
			if (!current) return;
			setGithubStatus(status);
			setIsLoadingGithubStatus(false);
		})();
		return () => {
			current = false;
		};
	}, [selectedProvider]);

	// Fetch Windsurf account info when Windsurf provider is selected. An answer
	// that arrives after the provider changed is dropped.
	useEffect(() => {
		setWindsurfAccount(null);
		if (selectedProvider !== "windsurf") {
			setIsLoadingWindsurfAccount(false);
			return;
		}
		let current = true;
		setIsLoadingWindsurfAccount(true);
		(async () => {
			let account: WindsurfAccount | null = null;
			try {
				const result = await globalThis.electronAPI.detectWindsurfToken();
				if (result.success) {
					account = {
						userName: result.userName,
						planName: result.planName,
						usageInfo: result.usageInfo,
					};
				}
			} catch (error) {
				console.warn(
					"[AuthStatusIndicator] Failed to fetch Windsurf account info:",
					error,
				);
			}
			if (!current) return;
			setWindsurfAccount(account);
			setIsLoadingWindsurfAccount(false);
		})();
		return () => {
			current = false;
		};
	}, [selectedProvider]);

	// Derive auth status purely from selectedProvider + profiles (no IPC calls)
	const authStatus = useMemo(() => {
		if (selectedProvider) {
			const providerProfile = profiles.find(
				(p) => detectProvider(p.baseUrl) === selectedProvider,
			);
			const provider = selectedProvider;

			if (providerProfile) {
				return {
					type: "profile" as const,
					name: providerProfile.name,
					id: providerProfile.id,
					baseUrl: providerProfile.baseUrl,
					provider,
				};
			}

			// No matching API profile — for anthropic, assume OAuth (Claude Code subscription)
			if (provider === "anthropic") {
				return OAUTH_FALLBACK;
			}

			return { type: "provider" as const, provider };
		}

		if (activeProfileId) {
			const activeProfile = profiles.find((p) => p.id === activeProfileId);
			if (activeProfile) {
				return {
					type: "profile" as const,
					name: activeProfile.name,
					id: activeProfile.id,
					baseUrl: activeProfile.baseUrl,
					provider: detectProvider(activeProfile.baseUrl),
				};
			}
		}

		// No provider observed and no active profile: the Claude Code subscription.
		return OAUTH_FALLBACK;
	}, [selectedProvider, profiles, activeProfileId]);

	// The plan the usage snapshot of this provider reports, when there is one.
	const reportedPlan = useUsagePlanStore((s) =>
		authStatus.type === "profile"
			? undefined
			: s.plans[usagePlanKey(authStatus.provider)],
	);
	// Signed in with a subscription: a Claude Code login without an API
	// profile, or any provider whose snapshot reports one (ChatGPT, Copilot…).
	const isOAuth =
		authStatus.type !== "profile" &&
		(reportedPlan
			? reportedPlan.billing === "subscription"
			: authStatus.type === "oauth");
	const isApiBilled =
		authStatus.type === "profile" || reportedPlan?.billing === "api";
	const isAnthropic = authStatus.provider === "anthropic";
	let subscriptionName: string;
	if (reportedPlan?.name) {
		subscriptionName = reportedPlan.name;
	} else if (isAnthropic) {
		subscriptionName =
			storedClaudePlanName ?? t("common:usage.claudeCodeSubscriptionUnknown");
	} else {
		subscriptionName = t("common:usage.planSubscription");
	}
	const Icon = isOAuth ? Lock : Key;
	const badgeLabel =
		authStatus.provider === "unknown"
			? t("common:usage.providerUnknown")
			: (getProviderLabel(authStatus.provider as ApiProvider) ??
				authStatus.provider);

	// Render provider-specific content based on selected provider
	const providerSpecificContent = useMemo(() => {
		if (selectedProvider === "copilot") {
			return (
				<div className="pt-2 border-t space-y-2">
					<div className="text-3xs text-muted-foreground">
						{t("common:usage.copilotAuthNote", { provider: "GitHub Copilot" })}
					</div>

					{/* GitHub CLI Status */}
					{(() => {
						if (isLoadingGithubStatus) {
							return (
								<div className="text-3xs text-muted-foreground italic">
									{t("common:usage.checkingGithubStatus")}
								</div>
							);
						}

						if (!githubStatus) {
							return (
								<div className="text-3xs text-muted-foreground italic">
									{t("common:usage.cannotCheckGithubStatus")}
								</div>
							);
						}

						if (githubStatus.available) {
							return (
								<div className="space-y-1">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-1.5 text-muted-foreground">
											<Shield className="h-3 w-3" />
											<span className="text-3xs">
												{t("common:usage.githubStatus")}
											</span>
										</div>
										<span
											className={`text-3xs font-medium ${githubStatus.isAuth ? "text-success" : "text-destructive"}`}
										>
											{githubStatus.isAuth
												? t("common:usage.connected")
												: t("common:usage.notConnected")}
										</span>
									</div>
									{githubStatus.username && (
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-1.5 text-muted-foreground">
												<Key className="h-3 w-3" />
												<span className="text-3xs">
													{t("common:usage.activeAccount")}
												</span>
											</div>
											<span className="text-3xs font-medium text-blue-500">
												@{githubStatus.username}
											</span>
										</div>
									)}
								</div>
							);
						}

						return (
							<div className="text-3xs text-destructive">
								{t("common:usage.githubCliNotAvailable")}{" "}
								<code className="bg-muted px-1 rounded">gh auth login</code>
							</div>
						);
					})()}

					{/* Note about missing usage data */}
					<div className="pt-1 border-t">
						<div className="text-3xs text-muted-foreground italic">
							{t("common:usage.dataUnavailable")}
						</div>
						<div className="text-3xs text-muted-foreground italic">
							{t("common:usage.dataUnavailableDescription")}
						</div>
						<div className="text-3xs text-muted-foreground mt-1">
							<a
								href="https://github.com/settings/copilot"
								target="_blank"
								rel="noopener noreferrer"
								className="text-blue-500 underline"
							>
								{t("common:usage.copilotDashboardLink")}
							</a>
						</div>
					</div>
				</div>
			);
		}

		if (selectedProvider === "windsurf") {
			return (
				<div className="pt-2 border-t space-y-2">
					<div className="text-3xs text-muted-foreground">
						{t("common:usage.windsurfAuthNote")}
					</div>

					{/* Windsurf Account Info */}
					{(() => {
						if (isLoadingWindsurfAccount) {
							return (
								<div className="text-3xs text-muted-foreground italic">
									{t("common:usage.checkingWindsurfStatus")}
								</div>
							);
						}

						if (!windsurfAccount) {
							return (
								<div className="text-3xs text-muted-foreground italic">
									{t("common:usage.windsurfNotDetected")}
								</div>
							);
						}

						return (
							<div className="space-y-1">
								{/* User name */}
								{windsurfAccount.userName && (
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-1.5 text-muted-foreground">
											<Key className="h-3 w-3" />
											<span className="text-3xs">
												{t("common:usage.activeAccount")}
											</span>
										</div>
										<span className="text-3xs font-medium text-teal-500">
											{windsurfAccount.userName}
										</span>
									</div>
								)}
								{/* Plan */}
								{windsurfAccount.planName && (
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-1.5 text-muted-foreground">
											<Shield className="h-3 w-3" />
											<span className="text-3xs">
												{t("common:usage.windsurfPlan")}
											</span>
										</div>
										<span className="text-3xs font-medium">
											{windsurfAccount.planName}
										</span>
									</div>
								)}
								{/* Usage info */}
								{windsurfAccount.usageInfo && (
									<div className="space-y-1 pt-1 border-t">
										<div className="flex items-center justify-between">
											<span className="text-3xs text-muted-foreground">
												{t("common:usage.windsurfCredits")}
											</span>
											<span className="text-3xs font-medium">
												{Math.round(
													windsurfAccount.usageInfo.usedMessages / 100,
												)}
												/
												{Math.round(
													windsurfAccount.usageInfo.totalMessages / 100,
												)}
											</span>
										</div>
										<div className="flex items-center justify-between">
											<span className="text-3xs text-muted-foreground">
												{t("common:usage.windsurfFlowActions")}
											</span>
											<span className="text-3xs font-medium">
												{Math.round(
													windsurfAccount.usageInfo.usedFlowActions / 100,
												)}
												/
												{Math.round(
													windsurfAccount.usageInfo.totalFlowActions / 100,
												)}
											</span>
										</div>
									</div>
								)}
							</div>
						);
					})()}

					{/* Dashboard link */}
					<div className="pt-1 border-t">
						<div className="text-3xs text-muted-foreground mt-1">
							<a
								href="https://windsurf.com/subscription/usage"
								target="_blank"
								rel="noopener noreferrer"
								className="text-teal-500 underline"
							>
								{t("common:usage.windsurfDashboardLink")}
							</a>
						</div>
					</div>
				</div>
			);
		}

		// Signed in some way (subscription or API key): nothing is missing.
		if (isOAuth || isApiBilled) return null;

		// Neither a profile nor a sign-in is known for this provider
		return (
			<div className="pt-2 border-t text-3xs text-muted-foreground">
				{t("common:usage.noProfileForProvider", { provider: badgeLabel })}
			</div>
		);
	}, [
		selectedProvider,
		isOAuth,
		isApiBilled,
		isLoadingGithubStatus,
		githubStatus,
		isLoadingWindsurfAccount,
		windsurfAccount,
		t,
		badgeLabel,
	]);

	return (
		<div className="flex items-center gap-2">
			{/* Provider Badge + Tooltip */}
			<TooltipProvider delayDuration={200}>
				<Tooltip>
					<TooltipTrigger asChild>
						{/* The provider's name is already in the usage lens on its left:
						    this badge only says how it is signed in (lock: subscription,
						    key: API key), the details are in the tooltip. */}
						<button
							type="button"
							className={`flex h-8 w-8 items-center justify-center rounded-md border transition-all hover:opacity-80 ${badgeColorOf(authStatus.provider)}`}
							aria-label={t("common:usage.authenticationAriaLabel", {
								provider: badgeLabel,
							})}
							data-auth-type={authStatus.type}
						>
							<Icon className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" className="text-xs max-w-xs p-0">
						<div className="p-3 space-y-3">
							{/* Header section */}
							<div className="flex items-center justify-between pb-2 border-b">
								<div className="flex items-center gap-1.5">
									<Shield className="h-3.5 w-3.5" />
									<span className="font-semibold text-xs">
										{t("common:usage.authenticationDetails")}
									</span>
								</div>
								<div
									className={`px-1.5 py-0.5 rounded text-3xs font-semibold ${
										isOAuth
											? "bg-orange-500/15 text-orange-500"
											: "bg-primary/15 text-primary"
									}`}
								>
									{isOAuth ? t("common:usage.oauth") : t("common:usage.apiKey")}
								</div>
							</div>

							{/* Provider info */}
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-1.5 text-muted-foreground">
									<Server className="h-3.5 w-3.5" />
									<span className="font-medium text-2xs">
										{t("common:usage.provider")}
									</span>
								</div>
								<span className="font-semibold text-xs">{badgeLabel}</span>
							</div>

							{/* The plan of a subscription sign-in */}
							{isOAuth && (
								<div className="flex items-center justify-between pt-2 border-t">
									<div className="flex items-center gap-1.5 text-muted-foreground">
										<Lock className="h-3 w-3" />
										<span className="text-3xs">
											{t("common:usage.subscription")}
										</span>
									</div>
									<span className="font-medium text-3xs">
										{subscriptionName}
									</span>
								</div>
							)}

							{/* Profile details for API profiles */}
							{authStatus.type === "profile" ? (
								<div className="pt-2 border-t space-y-2">
									{/* Profile name */}
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-1.5 text-muted-foreground">
											<Key className="h-3 w-3" />
											<span className="text-3xs">
												{t("common:usage.profile")}
											</span>
										</div>
										<span className="font-medium text-3xs">
											{authStatus.name}
										</span>
									</div>
									{/* Profile ID */}
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-1.5 text-muted-foreground">
											<Fingerprint className="h-3 w-3" />
											<span className="text-3xs">{t("common:usage.id")}</span>
										</div>
										<span className="text-xs text-muted-foreground ml-2">
											{authStatus.id}
										</span>
									</div>
									{/* API Endpoint */}
									<div className="pt-1">
										<div className="flex items-center gap-1.5 text-3xs text-muted-foreground mb-1">
											<ExternalLink className="h-3 w-3" />
											<span>{t("common:usage.apiEndpoint")}</span>
										</div>
										<div className="text-3xs font-mono bg-muted px-2 py-1.5 rounded break-all border">
											{authStatus.baseUrl}
										</div>
									</div>
								</div>
							) : (
								providerSpecificContent
							)}
						</div>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);
}
