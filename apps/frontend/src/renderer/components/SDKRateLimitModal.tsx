import {
	AlertCircle,
	Check,
	ChevronDown,
	Clock,
	ExternalLink,
	FileText,
	Lightbulb,
	ListTodo,
	Map as MapIcon,
	Plus,
	RefreshCw,
	Star,
	User,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SDKRateLimitInfo } from "../../shared/types";
import { debugError } from "../../shared/utils/debug-logger";
import { useToast } from "../hooks/use-toast";
import {
	loadClaudeProfiles,
	useClaudeProfileStore,
} from "../stores/claude-profile-store";
import { useRateLimitStore } from "../stores/rate-limit-store";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

const CLAUDE_UPGRADE_URL = "https://claude.ai/upgrade";

/** The translation key naming the feature that hit the limit. */
const SOURCE_KEYS: Record<SDKRateLimitInfo["source"], string> = {
	changelog: "rateLimit.sources.changelog",
	task: "rateLimit.sources.task",
	roadmap: "rateLimit.sources.roadmap",
	ideation: "rateLimit.sources.ideation",
	"title-generator": "rateLimit.sources.titleGenerator",
	other: "rateLimit.sources.claude",
};

/**
 * Get an icon for the source
 */
function getSourceIcon(source: SDKRateLimitInfo["source"]) {
	switch (source) {
		case "changelog":
			return FileText;
		case "task":
			return ListTodo;
		case "roadmap":
			return MapIcon;
		case "ideation":
			return Lightbulb;
		default:
			return AlertCircle;
	}
}

export function SDKRateLimitModal() {
	const {
		isSDKModalOpen,
		sdkRateLimitInfo,
		hideSDKRateLimitModal,
		clearPendingRateLimit,
	} = useRateLimitStore();
	const { profiles, isSwitching, setSwitching } = useClaudeProfileStore();
	const { toast } = useToast();
	const { t } = useTranslation("common");
	const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
		null,
	);
	const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(false);
	const [isLoadingSettings, setIsLoadingSettings] = useState(false);
	const [isRetrying, setIsRetrying] = useState(false);
	const [isAddingProfile, setIsAddingProfile] = useState(false);
	const [newProfileName, setNewProfileName] = useState("");
	const newProfileInputRef = useRef<HTMLInputElement>(null);
	// Set by "Add new account": the menu then gives the focus to the name field
	// instead of back to its trigger.
	const focusNewProfileRef = useRef(false);

	// Load profiles and auto-switch settings when the modal opens, and pre-select
	// the suggested profile. Only then: this effect also depended on the profile
	// list and on a function made anew each render, so it ran again on every
	// render, put the suggestion back over the account the user picked, and
	// looped on its own state update.
	useEffect(() => {
		if (!isSDKModalOpen) return;
		loadClaudeProfiles();
		globalThis.electronAPI
			.getAutoSwitchSettings()
			.then((result) => {
				if (result.success && result.data) {
					setAutoSwitchEnabled(result.data.autoSwitchOnRateLimit);
				}
			})
			.catch((err: unknown) => {
				debugError(
					"[SDKRateLimitModal] Failed to load auto-switch settings:",
					err,
				);
			});
		if (sdkRateLimitInfo?.suggestedProfile?.id) {
			setSelectedProfileId(sdkRateLimitInfo.suggestedProfile.id);
		}
	}, [isSDKModalOpen, sdkRateLimitInfo]);

	// Reset selection when modal closes
	useEffect(() => {
		if (!isSDKModalOpen) {
			setSelectedProfileId(null);
			setIsRetrying(false);
			setIsAddingProfile(false);
			setNewProfileName("");
		}
	}, [isSDKModalOpen]);

	const handleAutoSwitchToggle = async (enabled: boolean) => {
		setIsLoadingSettings(true);
		try {
			await globalThis.electronAPI.updateAutoSwitchSettings({
				enabled: enabled,
				autoSwitchOnRateLimit: enabled,
			});
			setAutoSwitchEnabled(enabled);
		} catch (err) {
			debugError(
				"[SDKRateLimitModal] Failed to update auto-switch settings:",
				err,
			);
		} finally {
			setIsLoadingSettings(false);
		}
	};

	const handleUpgrade = () => {
		window.open(CLAUDE_UPGRADE_URL, "_blank");
	};

	// Reachable only with a name typed: the button and Enter both need one.
	const handleAddProfile = async () => {
		setIsAddingProfile(true);
		try {
			// Create a new profile - the backend will set the proper configDir
			const profileName = newProfileName.trim();
			const profileSlug = profileName.toLowerCase().replaceAll(/\s+/g, "-");

			const result = await globalThis.electronAPI.saveClaudeProfile({
				id: `profile-${Date.now()}`,
				name: profileName,
				// Use a placeholder - the backend will resolve the actual path
				configDir: `~/.claude-profiles/${profileSlug}`,
				isDefault: false,
				createdAt: new Date(),
			});

			// A refused save is reported like a failed one.
			if (!result.success || !result.data) {
				throw new Error(result.error || "saveClaudeProfile failed");
			}
			// Reload profiles
			loadClaudeProfiles();
			setNewProfileName("");
			// Close the modal
			hideSDKRateLimitModal();

			// Direct user to Settings to complete authentication
			toast({
				variant: "success",
				title: t("profileCreated.title", { profileName }),
				description: (
					<span className="whitespace-pre-line">
						{`${t("profileCreated.instructions")}\n` +
							`1. ${t("profileCreated.step1")}\n` +
							`2. ${t("profileCreated.step2")}\n` +
							`3. ${t("profileCreated.step3")}\n\n` +
							t("profileCreated.footer")}
					</span>
				),
				duration: 15000,
			});
		} catch (err) {
			debugError("[SDKRateLimitModal] Failed to add profile:", err);
			toast({
				variant: "destructive",
				title: t("rateLimit.toast.addProfileFailed"),
				description: t("rateLimit.toast.tryAgain"),
			});
		} finally {
			setIsAddingProfile(false);
		}
	};

	const handleRetryWithProfile = async () => {
		// Retry is disabled until a profile is picked; an operation without a
		// project cannot be retried from here.
		if (!selectedProfileId || !sdkRateLimitInfo?.projectId) return;

		setIsRetrying(true);
		setSwitching(true);

		try {
			// First, set the active profile
			await globalThis.electronAPI.setActiveClaudeProfile(selectedProfileId);

			// Then retry the operation
			const result = await globalThis.electronAPI.retryWithProfile({
				source: sdkRateLimitInfo.source,
				projectId: sdkRateLimitInfo.projectId,
				taskId: sdkRateLimitInfo.taskId,
				profileId: selectedProfileId,
			});

			if (result.success) {
				// Clear the pending rate limit since we successfully switched
				clearPendingRateLimit();
			}
		} catch (err) {
			debugError("[SDKRateLimitModal] Failed to retry with profile:", err);
		} finally {
			setIsRetrying(false);
			setSwitching(false);
		}
	};

	if (!sdkRateLimitInfo) return null;

	// Get profiles that are not the current rate-limited one
	const currentProfileId = sdkRateLimitInfo.profileId;
	const availableProfiles = profiles.filter((p) => p.id !== currentProfileId);
	const hasMultipleProfiles = profiles.length > 1;

	const selectedProfile = selectedProfileId
		? profiles.find((p) => p.id === selectedProfileId)
		: null;

	const currentProfile = profiles.find((p) => p.id === currentProfileId);
	const suggestedProfile = sdkRateLimitInfo.suggestedProfile
		? profiles.find((p) => p.id === sdkRateLimitInfo.suggestedProfile?.id)
		: null;

	const SourceIcon = getSourceIcon(sdkRateLimitInfo.source);
	const sourceName = t(SOURCE_KEYS[sdkRateLimitInfo.source] ?? SOURCE_KEYS.other);
	const swappedFrom = currentProfile?.name;
	const swappedTo = sdkRateLimitInfo.swappedToProfile?.name;

	return (
		<Dialog
			open={isSDKModalOpen}
			onOpenChange={(open) => !open && hideSDKRateLimitModal()}
		>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-warning">
						<AlertCircle className="h-5 w-5" />
						{t("rateLimit.sdk.title")}
					</DialogTitle>
					<DialogDescription className="flex items-center gap-2">
						<SourceIcon className="h-4 w-4" />
						{t("rateLimit.sdk.interrupted", { source: sourceName })}
						{currentProfile && (
							<span className="text-muted-foreground">
								{" "}
								({t("common:rateLimit.profile", { name: currentProfile.name })})
							</span>
						)}
					</DialogDescription>
				</DialogHeader>

				<div className="py-4 space-y-4">
					{/* Swap notification info */}
					<div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
						{sdkRateLimitInfo.wasAutoSwapped ? (
							<>
								<p className="font-medium mb-1">
									{sdkRateLimitInfo.swapReason === "proactive"
										? t("rateLimit.sdk.proactiveSwap")
										: t("rateLimit.sdk.reactiveSwap")}
								</p>
								<p>
									{sdkRateLimitInfo.swapReason === "proactive"
										? t("rateLimit.sdk.proactiveSwapDesc", {
												from: swappedFrom,
												to: swappedTo,
											})
										: t("rateLimit.sdk.reactiveSwapDesc", {
												from: swappedFrom,
												to: swappedTo,
											})}
								</p>
								<p className="mt-2 text-3xs">
									{t("rateLimit.sdk.continueWithoutInterruption")}
								</p>
							</>
						) : (
							<>
								<p className="font-medium mb-1">
									{t("rateLimit.sdk.rateLimitReached")}
								</p>
								<p>
									{t("rateLimit.sdk.operationStopped", {
										account: currentProfile?.name || t("rateLimit.sdk.yourAccount"),
									})}
									{hasMultipleProfiles
										? ` ${t("rateLimit.sdk.switchBelow")}`
										: ` ${t("rateLimit.sdk.addAccountToContinue")}`}
								</p>
							</>
						)}
					</div>

					{/* Upgrade button */}
					<Button
						variant="default"
						size="sm"
						className="gap-2 w-full"
						onClick={() => window.open(CLAUDE_UPGRADE_URL, "_blank")}
					>
						<Zap className="h-4 w-4" />
						{t("rateLimit.sdk.upgradeToProButton")}
					</Button>

					{/* Reset time info */}
					{sdkRateLimitInfo.resetTime && (
						<div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
							<Clock className="h-5 w-5 text-muted-foreground shrink-0" />
							<div>
								<p className="text-sm font-medium text-foreground">
									{t("rateLimit.sdk.resetsLabel", {
										time: sdkRateLimitInfo.resetTime,
									})}
								</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									{sdkRateLimitInfo.limitType === "weekly"
										? t("rateLimit.sdk.weeklyLimit")
										: t("rateLimit.sdk.sessionLimit")}
								</p>
							</div>
						</div>
					)}

					{/* Profile switching / Add account section */}
					<div className="rounded-lg border border-accent/50 bg-accent/10 p-4">
						<h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
							<User className="h-4 w-4" />
							{hasMultipleProfiles
								? t("rateLimit.sdk.switchAccountRetry")
								: t("rateLimit.useAnotherAccount")}
						</h4>

						{hasMultipleProfiles ? (
							<>
								<p className="text-sm text-muted-foreground mb-3">
									{suggestedProfile ? (
										<>
											{t("common:rateLimit.sdk.recommendedBefore")}{" "}
											<strong>{suggestedProfile.name}</strong>{" "}
											{t("common:rateLimit.sdk.recommendedAfter")}
										</>
									) : (
										t("common:rateLimit.sdk.switchClaudeRetry")
									)}
								</p>

								<div className="flex items-center gap-2">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												className="flex-1 justify-between"
											>
												<span className="truncate flex items-center gap-2">
													{selectedProfile?.name || t("common:rateLimit.selectAccount")}
													{selectedProfileId ===
														sdkRateLimitInfo.suggestedProfile?.id && (
														<Star className="h-3 w-3 text-warning" />
													)}
												</span>
												<ChevronDown className="h-4 w-4 shrink-0 ml-2" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="start"
											className="w-[220px] bg-popover border border-border shadow-lg"
											onCloseAutoFocus={(event) => {
												if (!focusNewProfileRef.current) return;
												focusNewProfileRef.current = false;
												event.preventDefault();
												newProfileInputRef.current?.focus();
											}}
										>
											{availableProfiles.map((profile) => (
												<DropdownMenuItem
													key={profile.id}
													onClick={() => setSelectedProfileId(profile.id)}
													className="flex items-center justify-between"
												>
													<span className="truncate flex items-center gap-2">
														{profile.name}
														{profile.id ===
															sdkRateLimitInfo.suggestedProfile?.id && (
															<Star
																className="h-3 w-3 text-warning"
																aria-label={t("common:rateLimit.recommendedAria")}
															/>
														)}
													</span>
													{selectedProfileId === profile.id && (
														<Check className="h-4 w-4 shrink-0" />
													)}
												</DropdownMenuItem>
											))}
											<DropdownMenuSeparator />
											<DropdownMenuItem
												// The field was looked up by its placeholder, which is
												// translated, and the menu gave the focus back to its
												// trigger as it closed: it never reached the field.
												onClick={() => {
													focusNewProfileRef.current = true;
												}}
												className="flex items-center gap-2 text-muted-foreground"
											>
												<Plus className="h-4 w-4" />
												{t("common:rateLimit.addNewAccount")}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>

									<Button
										variant="default"
										size="sm"
										onClick={handleRetryWithProfile}
										disabled={!selectedProfileId || isRetrying || isSwitching}
										className="gap-2 shrink-0"
									>
										{isRetrying || isSwitching ? (
											<>
												<RefreshCw className="h-4 w-4 animate-spin" />
												{t("rateLimit.sdk.retrying")}
											</>
										) : (
											<>
												<RefreshCw className="h-4 w-4" />
												{t("rateLimit.sdk.retry")}
											</>
										)}
									</Button>
								</div>

								{selectedProfile?.description && (
									<p className="text-xs text-muted-foreground mt-2">
										{selectedProfile.description}
									</p>
								)}

								{/* Auto-switch toggle */}
								{availableProfiles.length > 0 && (
									<div className="flex items-center justify-between mt-4 pt-3 border-t border-border/50">
										<Label
											htmlFor="sdk-auto-switch"
											className="text-xs text-muted-foreground cursor-pointer"
										>
											{t("rateLimit.sdk.autoSwitchRetryLabel")}
										</Label>
										<Switch
											id="sdk-auto-switch"
											checked={autoSwitchEnabled}
											onCheckedChange={handleAutoSwitchToggle}
											disabled={isLoadingSettings}
										/>
									</div>
								)}
							</>
						) : (
							<p className="text-sm text-muted-foreground mb-3">
								{t("common:rateLimit.sdk.addClaudeSubscription")}
							</p>
						)}

						{/* Add new account section */}
						<div
							className={
								hasMultipleProfiles ? "mt-4 pt-3 border-t border-border/50" : ""
							}
						>
							<p className="text-xs text-muted-foreground mb-2">
								{hasMultipleProfiles
									? t("common:rateLimit.addAnotherAccount")
									: t("common:rateLimit.sdk.connectClaude")}
							</p>
							<div className="flex items-center gap-2">
								<Input
									ref={newProfileInputRef}
									placeholder={t("common:rateLimit.accountNamePlaceholder")}
									value={newProfileName}
									onChange={(e) => setNewProfileName(e.target.value)}
									className="flex-1 h-8 text-sm"
									onKeyDown={(e) => {
										if (e.key === "Enter" && newProfileName.trim()) {
											handleAddProfile();
										}
									}}
								/>
								<Button
									variant="outline"
									size="sm"
									onClick={handleAddProfile}
									disabled={!newProfileName.trim() || isAddingProfile}
									className="gap-1 shrink-0"
								>
									{isAddingProfile ? (
										<RefreshCw className="h-3 w-3 animate-spin" />
									) : (
										<Plus className="h-3 w-3" />
									)}
									{t("rateLimit.sdk.add")}
								</Button>
							</div>
							<p className="text-xs text-muted-foreground mt-2">
								{t("common:rateLimit.sdk.willOpenClaudeLogin")}
							</p>
						</div>
					</div>

					{/* Upgrade prompt */}
					<div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
						<h4 className="text-sm font-medium text-foreground mb-2">
							{t("common:rateLimit.upgradeTitle")}
						</h4>
						<p className="text-sm text-muted-foreground mb-3">
							{t("common:rateLimit.upgradeDescription")}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="gap-2"
							onClick={handleUpgrade}
						>
							<ExternalLink className="h-4 w-4" />
							{t("common:rateLimit.upgradeSubscription")}
						</Button>
					</div>

					{/* Info about what was interrupted */}
					<div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
						<p className="font-medium mb-1">
							{t("rateLimit.sdk.whatHappened")}
						</p>
						<p>
							{t("rateLimit.sdk.whatHappenedDesc", {
								source: sourceName.toLowerCase(),
								account: currentProfile?.name || t("rateLimit.sdk.defaultAccount"),
							})}
							{hasMultipleProfiles
								? ` ${t("rateLimit.sdk.switchRetryOrAdd")}`
								: ` ${t("rateLimit.sdk.addOrWait")}`}
						</p>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={hideSDKRateLimitModal}>
						{t("rateLimit.sdk.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
