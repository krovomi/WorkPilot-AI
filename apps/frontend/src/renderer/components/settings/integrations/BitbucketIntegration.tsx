/**
 * The Bitbucket Cloud settings of a project: the switch, the account (a
 * saved forge account of the app, or the project's own username + API token
 * or app password, or an access token alone), the
 * repository and the auto-sync. The token reaches this view masked; typing a
 * new one replaces it, leaving it as it came keeps the stored one. When the
 * repository is empty, the project's bitbucket.org remote fills it. The
 * connection test reads the saved settings, in the main process.
 */

import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BitbucketSyncStatus, ProjectEnvConfig } from "../../../../shared/types";
import { bitbucketRepoFromRemote } from "../../../../shared/utils/bitbucket-repo";
import { PasswordInput } from "../../project-settings/PasswordInput";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";
import { ForgeAccountPicker } from "./ForgeAccountPicker";

interface BitbucketIntegrationProps {
	readonly projectId: string;
	readonly projectPath?: string;
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

export function BitbucketIntegration({
	projectId,
	projectPath,
	envConfig,
	updateEnvConfig,
}: BitbucketIntegrationProps) {
	const { t } = useTranslation("bitbucket");
	const [status, setStatus] = useState<BitbucketSyncStatus | null>(null);
	const [isChecking, setIsChecking] = useState(false);
	const enabled = !!envConfig?.bitbucketEnabled;
	// A saved account brings its own username and token.
	const usesAccount = !!envConfig?.bitbucketAccountId;
	const needsRepo = enabled && !envConfig?.bitbucketWorkspace && !envConfig?.bitbucketRepo;

	// Fill the repository from the project's remote, once, when it is empty.
	useEffect(() => {
		if (!needsRepo || !projectPath) return;
		let live = true;
		window.electronAPI
			.detectRepoProvider(projectPath)
			.then((result) => {
				const ref = result?.success && result.data?.remoteUrl ? bitbucketRepoFromRemote(result.data.remoteUrl) : null;
				if (live && ref) updateEnvConfig({ bitbucketWorkspace: ref.workspace, bitbucketRepo: ref.repo });
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [needsRepo, projectPath, updateEnvConfig]);

	if (!envConfig) return null;

	const checkConnection = async () => {
		setIsChecking(true);
		const result = await window.electronAPI.bitbucket.checkConnection(projectId).catch(() => undefined);
		setStatus(
			result?.success && result.data
				? result.data
				: { connected: false, error: result?.error || t("errors.checkConnection") },
		);
		setIsChecking(false);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label htmlFor="bitbucket-enabled" className="font-normal text-foreground">
						{t("settings.enable")}
					</Label>
					<p className="text-xs text-muted-foreground">{t("settings.enableDescription")}</p>
				</div>
				<Switch
					id="bitbucket-enabled"
					checked={enabled}
					onCheckedChange={(checked) => updateEnvConfig({ bitbucketEnabled: checked })}
				/>
			</div>

			{enabled && (
				<>
					<ForgeAccountPicker
						forge="bitbucket"
						value={envConfig.bitbucketAccountId}
						onChange={(accountId) => updateEnvConfig({ bitbucketAccountId: accountId })}
					/>

					{!usesAccount && (
						<>
							<div className="space-y-2">
								<Label htmlFor="bitbucket-username" className="text-sm font-medium text-foreground">
									{t("settings.username")}
								</Label>
								<p className="text-xs text-muted-foreground">{t("settings.usernameDescription")}</p>
								<Input
									id="bitbucket-username"
									value={envConfig.bitbucketUsername || ""}
									onChange={(e) => updateEnvConfig({ bitbucketUsername: e.target.value })}
									autoComplete="off"
								/>
							</div>

							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">{t("settings.token")}</Label>
								<p className="text-xs text-muted-foreground">{t("settings.tokenDescription")}</p>
								<PasswordInput
									aria-label={t("settings.token")}
									value={envConfig.bitbucketToken || ""}
									onChange={(value) => updateEnvConfig({ bitbucketToken: value })}
								/>
							</div>
						</>
					)}

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label htmlFor="bitbucket-workspace" className="text-sm font-medium text-foreground">
								{t("settings.workspace")}
							</Label>
							<Input
								id="bitbucket-workspace"
								value={envConfig.bitbucketWorkspace || ""}
								onChange={(e) => updateEnvConfig({ bitbucketWorkspace: e.target.value })}
								placeholder="workspace"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="bitbucket-repo" className="text-sm font-medium text-foreground">
								{t("settings.repo")}
							</Label>
							<Input
								id="bitbucket-repo"
								value={envConfig.bitbucketRepo || ""}
								onChange={(e) => updateEnvConfig({ bitbucketRepo: e.target.value })}
								placeholder="repository"
							/>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">{t("settings.repoDescription")}</p>

					<ConnectionStatus status={status} isChecking={isChecking} onCheck={checkConnection} />

					<Separator />

					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<div className="flex items-center gap-2">
								<RefreshCw className="h-4 w-4 text-info" />
								<Label htmlFor="bitbucket-auto-sync" className="font-normal text-foreground">
									{t("settings.autoSync")}
								</Label>
							</div>
							<p className="text-xs text-muted-foreground pl-6">{t("settings.autoSyncDescription")}</p>
						</div>
						<Switch
							id="bitbucket-auto-sync"
							checked={!!envConfig.bitbucketAutoSync}
							onCheckedChange={(checked) => updateEnvConfig({ bitbucketAutoSync: checked })}
						/>
					</div>
				</>
			)}
		</div>
	);
}

interface ConnectionStatusProps {
	readonly status: BitbucketSyncStatus | null;
	readonly isChecking: boolean;
	readonly onCheck: () => void;
}

function ConnectionStatus({ status, isChecking, onCheck }: ConnectionStatusProps) {
	const { t } = useTranslation("bitbucket");
	let line = t("settings.notChecked");
	if (isChecking) line = t("settings.checking");
	else if (status?.connected) line = t("settings.connectedTo", { repo: status.fullName ?? "" });
	else if (status) line = status.error || t("settings.notConnected");

	return (
		<div className="rounded-lg border border-border bg-muted/30 p-3">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">{t("settings.connectionStatus")}</p>
					<p className="text-xs text-muted-foreground break-words">{line}</p>
					<p className="text-xs text-muted-foreground mt-1">{t("settings.checkUsesSaved")}</p>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{isChecking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
					{!isChecking && status?.connected && <CheckCircle2 className="h-4 w-4 text-success" />}
					{!isChecking && status && !status.connected && <AlertCircle className="h-4 w-4 text-warning" />}
					<Button variant="outline" size="sm" onClick={onCheck} disabled={isChecking}>
						{t("settings.checkConnection")}
					</Button>
				</div>
			</div>
		</div>
	);
}
