import {
	AlertCircle,
	CheckCircle2,
	ExternalLink,
	Eye,
	EyeOff,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectEnvConfig } from "../../../../shared/types";
import { GUIDE_ANCHORS } from "../../guided-tour/anchors";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";

interface JiraSyncStatus {
	connected: boolean;
	instanceUrl?: string;
	projectKey?: string;
	issueCount?: number;
	lastSyncedAt?: string;
	error?: string;
}

/**
 * Jira Cloud integration settings component.
 * Manages Jira instance URL, email, API token, and project configuration.
 *
 * Connects to the backend JIRA connector at src/connectors/jira/.
 */
export function JiraIntegration({
	envConfig,
	updateEnvConfig,
	showJiraToken,
	setShowJiraToken,
}: {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
	readonly showJiraToken: boolean;
	readonly setShowJiraToken: React.Dispatch<React.SetStateAction<boolean>>;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [isTestingConnection, setIsTestingConnection] = useState(false);
	const [connectionStatus, setConnectionStatus] =
		useState<JiraSyncStatus | null>(null);

	// Guard: don't render until envConfig is loaded (matches AzureDevOpsIntegration pattern)
	if (!envConfig) {
		return null;
	}

	const jiraEnabled = envConfig.jiraEnabled ?? false;
	const jiraInstanceUrl = envConfig.jiraInstanceUrl ?? "";
	const jiraEmail = envConfig.jiraEmail ?? "";
	const jiraApiToken = envConfig.jiraApiToken ?? "";
	const jiraProjectKey = envConfig.jiraProjectKey ?? "";
	const jiraAutoSync = envConfig.jiraAutoSync ?? false;

	const handleTestConnection = async () => {
		setIsTestingConnection(true);
		setConnectionStatus(null);

		try {
			if (!jiraInstanceUrl || !jiraEmail || !jiraApiToken) {
				setConnectionStatus({
					connected: false,
					error: t("jira.fillAllFields", { ns: "settings" }),
				});
				return;
			}

			// The bridge is `testJiraConnection` (preload/api/modules/jira-api.ts).
			// This used to call `jiraTestConnection` — a name only `window.d.ts`
			// ever declared — so the guard never matched and the fallback branch
			// reported `connected: true` on three filled fields, without once
			// contacting Jira. Announcing a connection nobody tested is worse
			// than announcing a failure.
			const test = globalThis.electronAPI?.testJiraConnection;
			if (typeof test !== "function") {
				setConnectionStatus({
					connected: false,
					error: t("jira.bridgeUnavailable", { ns: "settings" }),
				});
				return;
			}

			const result = await test({
				instanceUrl: jiraInstanceUrl,
				email: jiraEmail,
				apiToken: jiraApiToken,
			});
			setConnectionStatus(
				result.data || { connected: false, error: result.error },
			);
		} catch (err) {
			setConnectionStatus({
				connected: false,
				error: err instanceof Error ? err.message : "Connection failed",
			});
		} finally {
			setIsTestingConnection(false);
		}
	};

	return (
		<div className="space-y-6">
			{/* Enable/Disable Toggle */}
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label className="text-sm font-medium">
						{t("jira.enable", { ns: "settings" })}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t("jira.enableDescription", { ns: "settings" })}
					</p>
				</div>
				<Switch
					data-guide={GUIDE_ANCHORS.jira.enable}
					checked={jiraEnabled}
					onCheckedChange={(checked) =>
						updateEnvConfig({ jiraEnabled: checked })
					}
				/>
			</div>

			{jiraEnabled && (
				<>
					<Separator />

					{/* Instance URL */}
					<div className="space-y-2">
						<Label htmlFor="jira-url" className="text-sm">
							{t("jira.instanceUrl", { ns: "settings" })}{" "}
							<span className="text-destructive">
								{t("jira.required", { ns: "settings" })}
							</span>
						</Label>
						<Input
							id="jira-url"
							data-guide={GUIDE_ANCHORS.jira.instanceUrl}
							type="url"
							value={jiraInstanceUrl}
							onChange={(e) =>
								updateEnvConfig({ jiraInstanceUrl: e.target.value })
							}
							placeholder={t("jira.instanceUrlPlaceholder", { ns: "settings" })}
							className="font-mono text-sm"
						/>
						<p className="text-xs text-muted-foreground">
							{t("jira.instanceUrlDescription", { ns: "settings" })}
						</p>
					</div>

					{/* Email */}
					<div className="space-y-2">
						<Label htmlFor="jira-email" className="text-sm">
							{t("jira.email", { ns: "settings" })}{" "}
							<span className="text-destructive">
								{t("jira.required", { ns: "settings" })}
							</span>
						</Label>
						<Input
							id="jira-email"
							data-guide={GUIDE_ANCHORS.jira.email}
							type="email"
							value={jiraEmail}
							onChange={(e) => updateEnvConfig({ jiraEmail: e.target.value })}
							placeholder={t("jira.emailPlaceholder", { ns: "settings" })}
							className="text-sm"
						/>
						<p className="text-xs text-muted-foreground">
							{t("jira.emailDescription", { ns: "settings" })}
						</p>
					</div>

					{/* API Token */}
					<div className="space-y-2">
						<Label htmlFor="jira-token" className="text-sm">
							{t("jira.apiToken", { ns: "settings" })}{" "}
							<span className="text-destructive">
								{t("jira.required", { ns: "settings" })}
							</span>
						</Label>
						<div className="flex gap-2">
							<div className="relative flex-1">
								<Input
									id="jira-token"
									data-guide={GUIDE_ANCHORS.jira.token}
									type={showJiraToken ? "text" : "password"}
									value={jiraApiToken}
									onChange={(e) =>
										updateEnvConfig({ jiraApiToken: e.target.value })
									}
									placeholder={t("jira.apiTokenPlaceholder", {
										ns: "settings",
									})}
									className="pr-10 font-mono text-sm"
								/>
								<button
									type="button"
									onClick={() => setShowJiraToken(!showJiraToken)}
									className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								>
									{showJiraToken ? (
										<EyeOff className="h-4 w-4" />
									) : (
										<Eye className="h-4 w-4" />
									)}
								</button>
							</div>
						</div>
						<p className="text-xs text-muted-foreground">
							{t("jira.apiTokenDescription", { ns: "settings" })}{" "}
							<a
								href="https://id.atlassian.com/manage-profile/security/api-tokens"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline inline-flex items-center gap-0.5"
							>
								{t("jira.apiTokenLink", { ns: "settings" })}
								<ExternalLink className="h-3 w-3" />
							</a>
						</p>
					</div>

					{/* Project Key */}
					<div className="space-y-2">
						<Label htmlFor="jira-project" className="text-sm">
							{t("jira.projectKey", { ns: "settings" })}
						</Label>
						<Input
							id="jira-project"
							data-guide={GUIDE_ANCHORS.jira.projectKey}
							value={jiraProjectKey}
							onChange={(e) =>
								updateEnvConfig({ jiraProjectKey: e.target.value })
							}
							placeholder={t("jira.projectKeyPlaceholder", { ns: "settings" })}
							className="font-mono text-sm uppercase"
						/>
						<p className="text-xs text-muted-foreground">
							{t("jira.projectKeyDescription", { ns: "settings" })}
						</p>
					</div>

					{/* Auto-sync Toggle */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="text-sm">
								{t("jira.autoSync", { ns: "settings" })}
							</Label>
							<p className="text-xs text-muted-foreground">
								{t("jira.autoSyncDescription", { ns: "settings" })}
							</p>
						</div>
						<Switch
							checked={jiraAutoSync}
							onCheckedChange={(checked) =>
								updateEnvConfig({ jiraAutoSync: checked })
							}
						/>
					</div>

					<Separator />

					{/* Test Connection */}
					<div className="space-y-3">
						<Button
							size="sm"
							variant="outline"
							onClick={handleTestConnection}
							disabled={
								isTestingConnection ||
								!jiraInstanceUrl ||
								!jiraEmail ||
								!jiraApiToken
							}
							className="gap-2"
						>
							{isTestingConnection ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="h-4 w-4" />
							)}
							{t("jira.testConnection", { ns: "settings" })}
						</Button>

						{/* Connection Status */}
						{connectionStatus && (
							<div
								className={`rounded-lg border p-3 ${
									connectionStatus.connected
										? "border-green-500/30 bg-green-500/5"
										: "border-destructive/30 bg-destructive/5"
								}`}
							>
								<div className="flex items-center gap-2">
									{connectionStatus.connected ? (
										<CheckCircle2 className="h-4 w-4 text-green-500" />
									) : (
										<AlertCircle className="h-4 w-4 text-destructive" />
									)}
									<span
										className={`text-sm font-medium ${
											connectionStatus.connected
												? "text-green-500"
												: "text-destructive"
										}`}
									>
										{connectionStatus.connected
											? t("jira.connected", { ns: "settings" })
											: t("jira.connectionFailed", { ns: "settings" })}
									</span>
								</div>
								{connectionStatus.connected && connectionStatus.instanceUrl && (
									<p className="text-xs text-muted-foreground mt-1">
										Instance: {connectionStatus.instanceUrl}
										{connectionStatus.projectKey &&
											` • Project: ${connectionStatus.projectKey}`}
									</p>
								)}
								{connectionStatus.error && (
									<p className="text-xs text-destructive mt-1">
										{connectionStatus.error}
									</p>
								)}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
