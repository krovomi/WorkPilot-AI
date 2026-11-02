import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Eye,
	EyeOff,
	GitBranch,
	Globe,
	Import,
	Loader2,
	Radio,
	RefreshCw,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	GitHubSyncStatus,
	LinearSyncStatus,
	Project,
	ProjectEnvConfig,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

interface IntegrationSettingsProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;

	// Project settings for main branch
	readonly project: Project;
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;

	// Linear state
	readonly showLinearKey: boolean;
	readonly setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
	readonly linearConnectionStatus: LinearSyncStatus | null;
	readonly isCheckingLinear: boolean;
	readonly linearExpanded: boolean;
	readonly onLinearToggle: () => void;
	readonly onOpenLinearImport: () => void;

	// GitHub state
	readonly showGitHubToken: boolean;
	readonly setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
	readonly gitHubConnectionStatus: GitHubSyncStatus | null;
	readonly isCheckingGitHub: boolean;
	readonly githubExpanded: boolean;
	readonly onGitHubToggle: () => void;
}

export function IntegrationSettings({
	envConfig,
	updateEnvConfig,
	project,
	settings,
	setSettings,
	showLinearKey,
	setShowLinearKey,
	linearConnectionStatus,
	isCheckingLinear,
	linearExpanded,
	onLinearToggle,
	onOpenLinearImport,
	showGitHubToken,
	setShowGitHubToken,
	gitHubConnectionStatus,
	isCheckingGitHub,
	githubExpanded,
	onGitHubToggle,
}: IntegrationSettingsProps) {
	const { t } = useTranslation();
	// Branch selection state
	const [branches, setBranches] = useState<string[]>([]);
	const [isLoadingBranches, setIsLoadingBranches] = useState(false);

	// Track whether initial branch detection has been done to prevent double-execution
	const hasDetectedMainBranch = useRef(false);
	// Track mainBranch in a ref to avoid stale closure issues in loadBranches callback
	const mainBranchRef = useRef(settings.mainBranch);

	// Keep mainBranchRef in sync with settings.mainBranch
	useEffect(() => {
		mainBranchRef.current = settings.mainBranch;
	}, [settings.mainBranch]);

	// Reset detection flag when project OR GitHub repo changes
	// This allows auto-detection to run for a new repo within the same project
	useEffect(() => {
		hasDetectedMainBranch.current = false;
	}, []);

	// Load branches function wrapped in useCallback
	// Note: We use refs for mainBranch check and detection tracking to avoid stale closures
	const loadBranches = useCallback(async () => {
		setIsLoadingBranches(true);
		try {
			const result = await globalThis.electronAPI.getGitBranchesWithInfo(
				project.path,
			);
			if (result.success && result.data) {
				// Extract branch names from GitBranchDetail array
				const branchNames = result.data.map((branch) => branch.name);
				setBranches(branchNames);
				// Auto-detect main branch if not set and not already detected
				// Use mainBranchRef to avoid stale closure issues
				if (!mainBranchRef.current && !hasDetectedMainBranch.current) {
					hasDetectedMainBranch.current = true;
					const detectResult = await globalThis.electronAPI.detectMainBranch(
						project.path,
					);
					// Re-check mainBranchRef after await - user may have selected a branch during detection
					if (
						detectResult.success &&
						detectResult.data !== null &&
						detectResult.data !== undefined &&
						!mainBranchRef.current
					) {
						const detectedBranch = detectResult.data;
						setSettings((prev) => ({ ...prev, mainBranch: detectedBranch }));
					}
				}
			}
		} catch (error) {
			console.error("Failed to load branches:", error);
		} finally {
			setIsLoadingBranches(false);
		}
		// settings.mainBranch not in deps - we use mainBranchRef to avoid stale closures
		// hasDetectedMainBranch ref tracks whether detection has run this session
	}, [project.path, setSettings]);

	// Load branches when GitHub section expands or GitHub connection changes
	useEffect(() => {
		// Only load branches when:
		// 1. GitHub section is expanded
		// 2. Project path exists
		// 3. GitHub is enabled with repo configured
		if (!githubExpanded || !project.path) return;
		if (!envConfig?.githubEnabled || !envConfig?.githubRepo) return;

		// Only load branches when we have a successful connection
		if (gitHubConnectionStatus?.connected) {
			loadBranches();
		}
	}, [
		githubExpanded,
		project.path,
		envConfig?.githubEnabled,
		envConfig?.githubRepo,
		gitHubConnectionStatus?.connected,
		loadBranches,
	]);

	if (!envConfig) return null;

	return (
		<>
			{/* Linear Integration Section */}
			<section className="space-y-3">
				<button
					type="button"
					onClick={onLinearToggle}
					className="w-full flex items-center justify-between text-sm font-semibold text-foreground hover:text-foreground/80"
				>
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4" />
						{t("settings:projectSections.linear.integrationTitle")}
						{envConfig.linearEnabled && (
							<span className="px-2 py-0.5 text-xs bg-success/10 text-success rounded-full">
								{t("settings:common.enabled")}
							</span>
						)}
					</div>
					{linearExpanded ? (
						<ChevronUp className="h-4 w-4" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</button>

				{linearExpanded && (
					<div className="space-y-4 pl-6 pt-2">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="font-normal text-foreground">
									{t("settings:integrations.linear.enableLinearSync")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("settings:integrations.linear.enableLinearSyncDescription")}
								</p>
							</div>
							<Switch
								checked={envConfig.linearEnabled}
								onCheckedChange={(checked) =>
									updateEnvConfig({ linearEnabled: checked })
								}
							/>
						</div>

						{envConfig.linearEnabled && (
							<>
								<div className="space-y-2">
									<Label className="text-sm font-medium text-foreground">
										{t("settings:integrations.linear.apiKey")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t("settings:integrations.linear.apiKeyDescription")}{" "}
										<a
											href="https://linear.app/settings/api"
											target="_blank"
											rel="noopener noreferrer"
											className="text-info hover:underline"
										>
											{t("settings:integrations.linear.apiKeyLink")}
										</a>
									</p>
									<div className="relative">
										<Input
											type={showLinearKey ? "text" : "password"}
											placeholder="lin_api_xxxxxxxx"
											value={envConfig.linearApiKey || ""}
											onChange={(e) =>
												updateEnvConfig({ linearApiKey: e.target.value })
											}
											className="pr-10"
										/>
										<button
											type="button"
											onClick={() => setShowLinearKey(!showLinearKey)}
											className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
										>
											{showLinearKey ? (
												<EyeOff className="h-4 w-4" />
											) : (
												<Eye className="h-4 w-4" />
											)}
										</button>
									</div>
								</div>

								{/* Connection Status */}
								{envConfig.linearApiKey && (
									<div className="rounded-lg border border-border bg-muted/30 p-3">
										<div className="flex items-center justify-between">
											<div>
												<p className="text-sm font-medium text-foreground">
													{t("settings:projectSections.linear.connectionStatus")}
												</p>
												<p className="text-xs text-muted-foreground">
													{(() => {
														if (isCheckingLinear) {
															return "Checking...";
														}
														if (linearConnectionStatus?.connected) {
															const teamName = linearConnectionStatus.teamName
																? ` to ${linearConnectionStatus.teamName}`
																: "";
															return `Connected${teamName}`;
														}
														return (
															linearConnectionStatus?.error || "Not connected"
														);
													})()}
												</p>
												{linearConnectionStatus?.connected &&
													linearConnectionStatus.issueCount !== undefined && (
														<p className="text-xs text-muted-foreground mt-1">
															{t("settings:projectSections.linear.tasksAvailable", {
																count: linearConnectionStatus.issueCount,
															})}
														</p>
													)}
											</div>
											{(() => {
												if (isCheckingLinear) {
													return (
														<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
													);
												}
												if (linearConnectionStatus?.connected) {
													return (
														<CheckCircle2 className="h-4 w-4 text-success" />
													);
												}
												return <AlertCircle className="h-4 w-4 text-warning" />;
											})()}
										</div>
									</div>
								)}

								{/* Import Existing Tasks Button */}
								{linearConnectionStatus?.connected && (
									<div className="rounded-lg border border-info/30 bg-info/5 p-3">
										<div className="flex items-start gap-3">
											<Import className="h-5 w-5 text-info mt-0.5" />
											<div className="flex-1">
												<p className="text-sm font-medium text-foreground">
													{t("settings:integrations.linear.importTasksTitle")}
												</p>
												<p className="text-xs text-muted-foreground mt-1">
													{t("settings:integrations.linear.importTasksDescription")}
												</p>
												<Button
													size="sm"
													variant="outline"
													className="mt-2"
													onClick={onOpenLinearImport}
												>
													<Import className="h-4 w-4 mr-2" />
													{t("settings:integrations.linear.importTasksButton")}
												</Button>
											</div>
										</div>
									</div>
								)}

								<Separator />

								{/* Real-time Sync Toggle */}
								<div className="flex items-center justify-between">
									<div className="space-y-0.5">
										<div className="flex items-center gap-2">
											<Radio className="h-4 w-4 text-info" />
											<Label className="font-normal text-foreground">
												{t("settings:integrations.linear.realtimeSync")}
											</Label>
										</div>
										<p className="text-xs text-muted-foreground pl-6">
											{t("settings:integrations.linear.realtimeSyncDescription")}
										</p>
									</div>
									<Switch
										checked={envConfig.linearRealtimeSync || false}
										onCheckedChange={(checked) =>
											updateEnvConfig({ linearRealtimeSync: checked })
										}
									/>
								</div>

								{envConfig.linearRealtimeSync && (
									<div className="rounded-lg border border-warning/30 bg-warning/5 p-3 ml-6">
										<p className="text-xs text-warning">
											{t("settings:integrations.linear.realtimeSyncWarning")}
										</p>
									</div>
								)}

								<Separator />

								<div className="grid grid-cols-2 gap-4">
									<div className="space-y-2">
										<Label className="text-sm font-medium text-foreground">
											{t("settings:integrations.linear.teamId")}
										</Label>
										<Input
											placeholder={t("settings:integrations.linear.teamIdPlaceholder")}
											value={envConfig.linearTeamId || ""}
											onChange={(e) =>
												updateEnvConfig({ linearTeamId: e.target.value })
											}
										/>
									</div>
									<div className="space-y-2">
										<Label className="text-sm font-medium text-foreground">
											{t("settings:integrations.linear.projectId")}
										</Label>
										<Input
											placeholder={t("settings:integrations.linear.projectIdPlaceholder")}
											value={envConfig.linearProjectId || ""}
											onChange={(e) =>
												updateEnvConfig({ linearProjectId: e.target.value })
											}
										/>
									</div>
								</div>
							</>
						)}
					</div>
				)}
			</section>

			<Separator />

			{/* GitHub Integration Section */}
			<section className="space-y-3">
				<button
					type="button"
					onClick={onGitHubToggle}
					className="w-full flex items-center justify-between text-sm font-semibold text-foreground hover:text-foreground/80"
				>
					<div className="flex items-center gap-2">
						<Globe className="h-4 w-4" />
						{t("settings:projectSections.github.integrationTitle")}
						{envConfig.githubEnabled && (
							<span className="px-2 py-0.5 text-xs bg-success/10 text-success rounded-full">
								{t("settings:common.enabled")}
							</span>
						)}
					</div>
					{githubExpanded ? (
						<ChevronUp className="h-4 w-4" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</button>

				{githubExpanded && (
					<div className="space-y-4 pl-6 pt-2">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="font-normal text-foreground">
									{t("projectSections.github.enableGitHubIssues", {
										ns: "settings",
									})}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t(
										"projectSections.github.syncIssuesFromGitHubAndCreateTasksAutomatically",
										{ ns: "settings" },
									)}
								</p>
							</div>
							<Switch
								checked={envConfig.githubEnabled}
								onCheckedChange={(checked) =>
									updateEnvConfig({ githubEnabled: checked })
								}
							/>
						</div>

						{envConfig.githubEnabled && (
							<>
								<div className="space-y-2">
									<Label className="text-sm font-medium text-foreground">
										{t("settings:projectSections.github.patLabel")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t("settings:projectSections.github.patHelpBefore")}{" "}
										<code className="px-1 bg-muted rounded">repo</code> {t("settings:projectSections.github.patHelpAfter")}{" "}
										<a
											href="https://github.com/settings/tokens/new?scopes=repo&description=WorkPilot AI-UI"
											target="_blank"
											rel="noopener noreferrer"
											className="text-info hover:underline"
										>
											{t("settings:projectSections.github.githubSettingsLink")}
										</a>
									</p>
									<div className="relative">
										<Input
											type={showGitHubToken ? "text" : "password"}
											placeholder={t("settings:projectSections.github.tokenPlaceholder")}
											value={envConfig.githubToken || ""}
											onChange={(e) =>
												updateEnvConfig({ githubToken: e.target.value })
											}
											className="pr-10"
										/>
										<button
											type="button"
											onClick={() => setShowGitHubToken(!showGitHubToken)}
											className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
										>
											{showGitHubToken ? (
												<EyeOff className="h-4 w-4" />
											) : (
												<Eye className="h-4 w-4" />
											)}
										</button>
									</div>
								</div>

								<div className="space-y-2">
									<Label className="text-sm font-medium text-foreground">
										{t("settings:projectSections.github.repository")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t("settings:projectSections.github.repositoryFormatPrefix")}{" "}
										<code className="px-1 bg-muted rounded">owner/repo</code>{" "}
										{t("settings:projectSections.github.repositoryFormatExample")}
									</p>
									<Input
										placeholder="owner/repository"
										value={envConfig.githubRepo || ""}
										onChange={(e) =>
											updateEnvConfig({ githubRepo: e.target.value })
										}
									/>
								</div>

								{/* Connection Status */}
								{envConfig.githubToken && envConfig.githubRepo && (
									<div className="rounded-lg border border-border bg-muted/30 p-3">
										<div className="flex items-center justify-between">
											<div>
												<p className="text-sm font-medium text-foreground">
													{t("settings:projectSections.linear.connectionStatus")}
												</p>
												<p className="text-xs text-muted-foreground">
													{(() => {
														if (isCheckingGitHub) {
															return "Checking...";
														}
														if (gitHubConnectionStatus?.connected) {
															return `Connected to ${gitHubConnectionStatus.repoFullName}`;
														}
														return (
															gitHubConnectionStatus?.error || "Not connected"
														);
													})()}
												</p>
												{gitHubConnectionStatus?.connected &&
													gitHubConnectionStatus.repoDescription && (
														<p className="text-xs text-muted-foreground mt-1 italic">
															{gitHubConnectionStatus.repoDescription}
														</p>
													)}
											</div>
											{(() => {
												if (isCheckingGitHub) {
													return (
														<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
													);
												}
												if (gitHubConnectionStatus?.connected) {
													return (
														<CheckCircle2 className="h-4 w-4 text-success" />
													);
												}
												return <AlertCircle className="h-4 w-4 text-warning" />;
											})()}
										</div>
									</div>
								)}

								{/* Info about accessing issues */}
								{gitHubConnectionStatus?.connected && (
									<div className="rounded-lg border border-info/30 bg-info/5 p-3">
										<div className="flex items-start gap-3">
											<Globe className="h-5 w-5 text-info mt-0.5" />
											<div className="flex-1">
												<p className="text-sm font-medium text-foreground">
													{t("settings:projectSections.github.issuesAvailable")}
												</p>
												<p className="text-xs text-muted-foreground mt-1">
													{t("settings:projectSections.github.issuesAvailableDescription")}
												</p>
											</div>
										</div>
									</div>
								)}

								<Separator />

								{/* Auto-sync Toggle */}
								<div className="flex items-center justify-between">
									<div className="space-y-0.5">
										<div className="flex items-center gap-2">
											<RefreshCw className="h-4 w-4 text-info" />
											<Label className="font-normal text-foreground">
												{t("settings:projectSections.github.autoSyncOnLoad")}
											</Label>
										</div>
										<p className="text-xs text-muted-foreground pl-6">
											{t("settings:projectSections.github.autoSyncDescription")}
										</p>
									</div>
									<Switch
										checked={envConfig.githubAutoSync || false}
										onCheckedChange={(checked) =>
											updateEnvConfig({ githubAutoSync: checked })
										}
									/>
								</div>

								<Separator />

								{/* Main Branch Selection */}
								<div className="space-y-2">
									<div className="flex items-center gap-2">
										<GitBranch className="h-4 w-4 text-info" />
										<Label className="text-sm font-medium text-foreground">
											{t("settings:projectSections.github.mainBranch")}
										</Label>
									</div>
									<p className="text-xs text-muted-foreground">
										{t("settings:projectSections.github.mainBranchDescription")}
									</p>
									<Select
										value={settings.mainBranch || ""}
										onValueChange={(value) =>
											setSettings((prev) => ({ ...prev, mainBranch: value }))
										}
										disabled={isLoadingBranches || branches.length === 0}
									>
										<SelectTrigger>
											{isLoadingBranches ? (
												<div className="flex items-center gap-2">
													<Loader2 className="h-3 w-3 animate-spin" />
													<span>{t("settings:projectSections.github.loadingBranches")}</span>
												</div>
											) : (
												<SelectValue placeholder={t("settings:projectSections.github.selectMainBranch")} />
											)}
										</SelectTrigger>
										<SelectContent>
											{branches.map((branch) => (
												<SelectItem key={branch} value={branch}>
													{branch}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{settings.mainBranch && (
										<p className="text-xs text-muted-foreground">
											{t("settings:projectSections.github.branchHintBefore")}{" "}
											<code className="px-1 bg-muted rounded">
												auto-claude/task-name
											</code>{" "}
											{t("settings:projectSections.github.branchHintFrom")}{" "}
											<code className="px-1 bg-muted rounded">
												{settings.mainBranch}
											</code>
										</p>
									)}
								</div>
							</>
						)}
					</div>
				)}
			</section>
		</>
	);
}
