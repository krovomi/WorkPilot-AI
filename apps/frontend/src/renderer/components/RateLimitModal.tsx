import {
	AlertCircle,
	Check,
	ChevronDown,
	Clock,
	ExternalLink,
	Plus,
	RefreshCw,
	Star,
	User,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { debugError } from "../../shared/utils/debug-logger";
import { useToast } from "../hooks/use-toast";
import {
	loadClaudeProfiles,
	switchTerminalToProfile,
	useClaudeProfileStore,
} from "../stores/claude-profile-store";
import { useAuthStore } from "../stores/auth-store";
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

export function RateLimitModal() {
	const { t } = useTranslation("common");
	const { isModalOpen, rateLimitInfo, hideRateLimitModal, clearPendingRateLimit } =
		useAuthStore(
			useShallow((s) => ({
				isModalOpen: s.rateLimit_isModalOpen,
				rateLimitInfo: s.rateLimit_info,
				hideRateLimitModal: s.rateLimit_hideModal,
				clearPendingRateLimit: s.rateLimit_clearPending,
			})),
		);
	const { profiles, activeProfileId, isSwitching } = useClaudeProfileStore(
		useShallow((s) => ({
			profiles: s.profiles,
			activeProfileId: s.activeProfileId,
			isSwitching: s.isSwitching,
		})),
	);
	const { toast } = useToast();
	const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
		null,
	);
	const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(false);
	const [isLoadingSettings, setIsLoadingSettings] = useState(false);
	const [isAddingProfile, setIsAddingProfile] = useState(false);
	const [newProfileName, setNewProfileName] = useState("");
	const newProfileInputRef = useRef<HTMLInputElement>(null);
	// Set by "Add new account": the menu then gives the focus to the name field
	// instead of back to its trigger.
	const focusNewProfileRef = useRef(false);
	const suggestedProfileId = rateLimitInfo?.suggestedProfileId;

	// Load profiles and auto-switch settings when the modal opens, and pre-select
	// the suggested profile. Only then: this effect depended on a function made
	// anew each render, so it ran again on every render, reloaded the profiles
	// in a loop and put the suggestion back over the account the user picked.
	useEffect(() => {
		if (!isModalOpen) return;
		loadClaudeProfiles();
		globalThis.electronAPI
			.getAutoSwitchSettings()
			.then((result) => {
				if (result.success && result.data) {
					setAutoSwitchEnabled(result.data.autoSwitchOnRateLimit);
				}
			})
			.catch((err: unknown) => {
				debugError("[RateLimitModal] Failed to load auto-switch settings:", err);
			});
		if (suggestedProfileId) {
			setSelectedProfileId(suggestedProfileId);
		}
	}, [isModalOpen, suggestedProfileId]);

	// Reset selection when modal closes
	useEffect(() => {
		if (!isModalOpen) {
			setSelectedProfileId(null);
			setIsAddingProfile(false);
			setNewProfileName("");
		}
	}, [isModalOpen]);

	const handleAutoSwitchToggle = async (enabled: boolean) => {
		setIsLoadingSettings(true);
		try {
			const result = await globalThis.electronAPI.updateAutoSwitchSettings({
				enabled: enabled,
				autoSwitchOnRateLimit: enabled,
			});
			// A refused save is reported like a failed one; the switch stays as saved.
			if (!result.success) {
				throw new Error(result.error || "updateAutoSwitchSettings failed");
			}
			setAutoSwitchEnabled(enabled);
		} catch (err) {
			debugError(
				"[RateLimitModal] Failed to update auto-switch settings:",
				err,
			);
			toast({
				variant: "destructive",
				title: t("rateLimit.toast.autoSwitchFailed"),
				description: t("rateLimit.toast.tryAgain"),
			});
		} finally {
			setIsLoadingSettings(false);
		}
	};

	const handleUpgrade = () => {
		globalThis.open(CLAUDE_UPGRADE_URL, "_blank");
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

			// A refused save used to be dropped without a word.
			if (!result.success || !result.data) {
				throw new Error(result.error || "saveClaudeProfile failed");
			}
			// Reload profiles
			loadClaudeProfiles();
			setNewProfileName("");
			// Close the modal
			hideRateLimitModal();

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
			debugError("[RateLimitModal] Failed to add profile:", err);
			toast({
				variant: "destructive",
				title: t("rateLimit.toast.addProfileFailed"),
				description: t("rateLimit.toast.tryAgain"),
			});
		} finally {
			setIsAddingProfile(false);
		}
	};

	// The store opens the modal only with a rate limit to show.
	if (!rateLimitInfo) return null;

	const handleSwitchProfile = async (profileId: string) => {
		const success = await switchTerminalToProfile(
			rateLimitInfo.terminalId,
			profileId,
		);
		if (success) {
			// Clear the pending rate limit since we successfully switched, and
			// close: the modal was left open with nothing left to show.
			clearPendingRateLimit();
			hideRateLimitModal();
		} else {
			toast({
				variant: "destructive",
				title: t("rateLimit.toast.switchFailed"),
				description: t("rateLimit.toast.tryAgain"),
			});
		}
	};

	// Get profiles that are not the current rate-limited one
	const currentProfileId = rateLimitInfo.profileId || activeProfileId;
	const availableProfiles = profiles.filter((p) => p.id !== currentProfileId);
	const hasMultipleProfiles = profiles.length > 1;

	const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

	const currentProfile = profiles.find((p) => p.id === currentProfileId);
	const suggestedProfile = profiles.find((p) => p.id === suggestedProfileId);

	// The account auto-switch already moved to, if it did
	const autoSwitchHappened =
		(rateLimitInfo.autoSwitchEnabled && suggestedProfile) || null;

	// Determine the appropriate button text based on the current state
	const getButtonText = () => {
		if (autoSwitchHappened) {
			return t("buttons.continue");
		}
		if (hasMultipleProfiles) {
			return t("buttons.close");
		}
		return t("buttons.gotIt");
	};

	return (
		<Dialog
			open={isModalOpen}
			onOpenChange={(open) => !open && hideRateLimitModal()}
		>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-warning">
						<AlertCircle className="h-5 w-5" />
						{t("rateLimit.modalTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("rateLimit.modalDescription")}
						{currentProfile && !currentProfile.isDefault && (
							<span className="text-muted-foreground">
								{" "}
								({t("rateLimit.profile", { name: currentProfile.name })})
							</span>
						)}
					</DialogDescription>
				</DialogHeader>

				<div className="py-4 space-y-4">
					{/* Auto-switch notification */}
					{autoSwitchHappened && (
						<div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
							<Zap className="h-5 w-5 text-success shrink-0" />
							<div>
								<p className="text-sm font-medium text-foreground">
									{t("rateLimit.autoSwitching", {
										name: autoSwitchHappened.name,
									})}
								</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									{t("rateLimit.autoSwitchingDescription")}
								</p>
							</div>
						</div>
					)}

					{/* Reset time info */}
					{rateLimitInfo.resetTime && !autoSwitchHappened && (
						<div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
							<Clock className="h-5 w-5 text-muted-foreground shrink-0" />
							<div>
								<p className="text-sm font-medium text-foreground">
									{t("rateLimit.resetsTime", { time: rateLimitInfo.resetTime })}
								</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									{t("rateLimit.usageRestored")}
								</p>
							</div>
						</div>
					)}

					{/* Profile switching / Add account section - show unless auto-switch happened */}
					{!autoSwitchHappened && (
						<div className="rounded-lg border border-accent/50 bg-accent/10 p-4">
							<h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
								<User className="h-4 w-4" />
								{hasMultipleProfiles
									? t("rateLimit.switchAccount")
									: t("rateLimit.useAnotherAccount")}
							</h4>

							{hasMultipleProfiles ? (
								<>
									<p className="text-sm text-muted-foreground mb-3">
										{suggestedProfile
											? t("rateLimit.recommended", {
													name: suggestedProfile.name,
												})
											: t("rateLimit.otherSubscriptions")}
									</p>

									<div className="flex items-center gap-2">
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="outline"
													className="flex-1 justify-between"
												>
													<span className="truncate flex items-center gap-2">
														{selectedProfile?.name ||
															t("rateLimit.selectAccount")}
														{selectedProfileId ===
															suggestedProfileId && (
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
																suggestedProfileId && (
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
													// The field was found by its English placeholder, so
													// this did nothing in French.
													onClick={() => {
														focusNewProfileRef.current = true;
													}}
													className="flex items-center gap-2 text-muted-foreground"
												>
													<Plus className="h-4 w-4" />
													{t("rateLimit.addNewAccount")}
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>

										<Button
											variant="default"
											size="sm"
											// No switch without an account picked.
											onClick={
												selectedProfileId
													? () => handleSwitchProfile(selectedProfileId)
													: undefined
											}
											disabled={!selectedProfileId || isSwitching}
											className="gap-2 shrink-0"
										>
											{isSwitching ? (
												<>
													<RefreshCw className="h-4 w-4 animate-spin" />
													{t("rateLimit.switching")}
												</>
											) : (
												<>
													<RefreshCw className="h-4 w-4" />
													{t("buttons.switch")}
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
												htmlFor="auto-switch"
												className="text-xs text-muted-foreground cursor-pointer"
											>
												{t("rateLimit.autoSwitchOnRateLimit")}
											</Label>
											<Switch
												id="auto-switch"
												checked={autoSwitchEnabled}
												onCheckedChange={handleAutoSwitchToggle}
												disabled={isLoadingSettings}
											/>
										</div>
									)}
								</>
							) : (
								<p className="text-sm text-muted-foreground mb-3">
									{t("rateLimit.addAnotherSubscription")}
								</p>
							)}

							{/* Add new account section */}
							<div
								className={
									hasMultipleProfiles
										? "mt-4 pt-3 border-t border-border/50"
										: ""
								}
							>
								<p className="text-xs text-muted-foreground mb-2">
									{hasMultipleProfiles
										? t("rateLimit.addAnotherAccount")
										: t("rateLimit.connectAccount")}
								</p>
								<div className="flex items-center gap-2">
									<Input
										ref={newProfileInputRef}
										placeholder={t("rateLimit.accountNamePlaceholder")}
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
										{t("buttons.add")}
									</Button>
								</div>
								<p className="text-xs text-muted-foreground mt-2">
									{t("rateLimit.willOpenLogin")}
								</p>
							</div>
						</div>
					)}

					{/* Upgrade prompt */}
					<div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
						<h4 className="text-sm font-medium text-foreground mb-2">
							{t("rateLimit.upgradeTitle")}
						</h4>
						<p className="text-sm text-muted-foreground mb-3">
							{t("rateLimit.upgradeDescription")}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="gap-2"
							onClick={handleUpgrade}
							aria-label={t("accessibility.upgradeSubscriptionAriaLabel")}
						>
							<ExternalLink className="h-4 w-4" aria-hidden="true" />
							{t("rateLimit.upgradeSubscription")}
							<span className="sr-only">
								({t("accessibility.opensInNewWindow")})
							</span>
						</Button>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={hideRateLimitModal}>
						{getButtonText()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
