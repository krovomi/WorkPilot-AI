import { CheckCircle2, Globe, Info, KeyRound, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitHubSyncStatus, ProjectEnvConfig } from "../../../shared/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { CollapsibleSection } from "./CollapsibleSection";
import { ConnectionStatus } from "./ConnectionStatus";
import { GitHubOAuthFlow } from "./GitHubOAuthFlow";
import { PasswordInput } from "./PasswordInput";
import { StatusBadge } from "./StatusBadge";

interface GitHubIntegrationSectionProps {
	readonly isExpanded: boolean;
	readonly onToggle: () => void;
	readonly envConfig: ProjectEnvConfig;
	readonly onUpdateConfig: (updates: Partial<ProjectEnvConfig>) => void;
	readonly gitHubConnectionStatus: GitHubSyncStatus | null;
	readonly isCheckingGitHub: boolean;
	readonly projectName?: string;
}

export function GitHubIntegrationSection({
	isExpanded,
	onToggle,
	envConfig,
	onUpdateConfig,
	gitHubConnectionStatus,
	isCheckingGitHub,
	projectName,
}: GitHubIntegrationSectionProps) {
	const { t } = useTranslation();
	// Show OAuth flow if user previously used OAuth, or if there's no token yet
	const [showOAuthFlow, setShowOAuthFlow] = useState(
		envConfig.githubAuthMethod === "oauth" ||
			(!envConfig.githubToken && !envConfig.githubAuthMethod),
	);

	const badge = envConfig.githubEnabled ? (
		<StatusBadge status="success" label={t("settings:common.enabled")} />
	) : null;

	const handleOAuthSuccess = (token: string, _username?: string) => {
		onUpdateConfig({ githubToken: token, githubAuthMethod: "oauth" });
		setShowOAuthFlow(false);
	};

	const handleManualTokenChange = (value: string) => {
		onUpdateConfig({ githubToken: value, githubAuthMethod: "pat" });
	};

	const renderOAuthConnectedState = () => (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="text-sm font-medium text-foreground">
					{t("settings:projectSections.github.githubAuthentication")}
				</Label>
				<Button
					variant="ghost"
					size="sm"
					onClick={() =>
						onUpdateConfig({ githubToken: "", githubAuthMethod: undefined })
					}
					className="text-muted-foreground hover:text-foreground"
				>
					{t("settings:projectSections.github.useManualToken")}
				</Button>
			</div>
			<div className="flex items-center gap-2 p-3 rounded-lg border border-success/30 bg-success/5">
				<CheckCircle2 className="h-4 w-4 text-success" />
				<span className="text-sm text-foreground">
					{t("settings:projectSections.github.authenticatedViaOAuth")}
				</span>
			</div>
		</div>
	);

	const renderOAuthFlowState = () => (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<Label className="text-sm font-medium text-foreground">
					{t("settings:projectSections.github.githubAuthentication")}
				</Label>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowOAuthFlow(false)}
				>
					{t("settings:projectSections.github.useManualToken")}
				</Button>
			</div>
			<GitHubOAuthFlow
				onSuccess={handleOAuthSuccess}
				onCancel={() => setShowOAuthFlow(false)}
			/>
		</div>
	);

	const renderManualTokenState = () => (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="text-sm font-medium text-foreground">
					{t("settings:projectSections.github.patLabel")}
				</Label>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShowOAuthFlow(true)}
					className="gap-2"
				>
					<KeyRound className="h-3 w-3" />
					{t("settings:projectSections.github.useOAuthInstead")}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("settings:projectSections.github.patHelpBefore")} <code className="px-1 bg-muted rounded">repo</code>{" "}
				{t("settings:projectSections.github.patHelpAfter")}{" "}
				<a
					href="https://github.com/settings/tokens/new?scopes=repo&description=WorkPilot AI-UI"
					target="_blank"
					rel="noopener noreferrer"
					className="text-info hover:underline"
				>
					{t("settings:projectSections.github.githubSettingsLink")}
				</a>
			</p>
			<PasswordInput
				value={envConfig.githubToken || ""}
				onChange={handleManualTokenChange}
				placeholder={t("settings:projectSections.github.tokenPlaceholder")}
			/>
		</div>
	);

	const getAuthenticationSection = () => {
		if (
			envConfig.githubAuthMethod === "oauth" &&
			envConfig.githubToken &&
			!showOAuthFlow
		) {
			return renderOAuthConnectedState();
		}

		if (showOAuthFlow) {
			return renderOAuthFlowState();
		}

		return renderManualTokenState();
	};

	return (
		<CollapsibleSection
			title={t("settings:projectSections.github.integrationTitle")}
			icon={<Globe className="h-4 w-4" />}
			isExpanded={isExpanded}
			onToggle={onToggle}
			badge={badge}
		>
			{/* Project-Specific Configuration Notice */}
			{projectName && (
				<div className="rounded-lg border border-info/30 bg-info/5 p-3 mb-4">
					<div className="flex items-start gap-2">
						<Info className="h-4 w-4 text-info mt-0.5 shrink-0" />
						<div className="flex-1">
							<p className="text-sm font-medium text-foreground">
								{t("settings:projectSections.github.projectSpecificTitle")}
							</p>
							<p className="text-xs text-muted-foreground mt-1">
								{t("settings:projectSections.github.projectSpecificBefore")}{" "}
								<span className="font-semibold text-foreground">
									{projectName}
								</span>
								{t("settings:projectSections.github.projectSpecificAfter")}
							</p>
						</div>
					</div>
				</div>
			)}

			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label className="font-normal text-foreground">
						{t("projectSections.github.enableGitHubIssues", { ns: "settings" })}
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
						onUpdateConfig({ githubEnabled: checked })
					}
				/>
			</div>

			{envConfig.githubEnabled && (
				<>
					{getAuthenticationSection()}

					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">
							{t("settings:projectSections.github.repository")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("settings:projectSections.github.repositoryFormatPrefix")} <code className="px-1 bg-muted rounded">owner/repo</code>{" "}
							{t("settings:projectSections.github.repositoryFormatExample")}
						</p>
						<Input
							placeholder="owner/repository"
							value={envConfig.githubRepo || ""}
							onChange={(e) => onUpdateConfig({ githubRepo: e.target.value })}
						/>
					</div>

					{/* Connection Status */}
					{envConfig.githubToken && envConfig.githubRepo && (
						<ConnectionStatus
							isChecking={isCheckingGitHub}
							isConnected={gitHubConnectionStatus?.connected || false}
							title={t("settings:projectSections.github.connectionStatus")}
							successMessage={`Connected to ${gitHubConnectionStatus?.repoFullName}`}
							errorMessage={gitHubConnectionStatus?.error || "Not connected"}
							additionalInfo={gitHubConnectionStatus?.repoDescription}
						/>
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
								onUpdateConfig({ githubAutoSync: checked })
							}
						/>
					</div>
				</>
			)}
		</CollapsibleSection>
	);
}
