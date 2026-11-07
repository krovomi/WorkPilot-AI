import { Import, Radio, Zap } from "lucide-react";
import type { LinearSyncStatus, ProjectEnvConfig } from "../../../shared/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { CollapsibleSection } from "./CollapsibleSection";
import { ConnectionStatus } from "./ConnectionStatus";
import { PasswordInput } from "./PasswordInput";
import { StatusBadge } from "./StatusBadge";
import { useTranslation } from "react-i18next";

interface LinearIntegrationSectionProps {
	isExpanded: boolean;
	onToggle: () => void;
	envConfig: ProjectEnvConfig;
	onUpdateConfig: (updates: Partial<ProjectEnvConfig>) => void;
	linearConnectionStatus: LinearSyncStatus | null;
	isCheckingLinear: boolean;
	onOpenImportModal: () => void;
}

export function LinearIntegrationSection({
	isExpanded,
	onToggle,
	envConfig,
	onUpdateConfig,
	linearConnectionStatus,
	isCheckingLinear,
	onOpenImportModal,
}: LinearIntegrationSectionProps) {
	const { t } = useTranslation();
	const badge = envConfig.linearEnabled ? (
		<StatusBadge status="success" label={t("settings:common.enabled")} />
	) : null;

	return (
		<CollapsibleSection
			title={t("settings:projectSections.linear.integrationTitle")}
			icon={<Zap className="h-4 w-4" />}
			isExpanded={isExpanded}
			onToggle={onToggle}
			badge={badge}
		>
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
						onUpdateConfig({ linearEnabled: checked })
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
						<PasswordInput
							value={envConfig.linearApiKey || ""}
							onChange={(value) => onUpdateConfig({ linearApiKey: value })}
							placeholder="lin_api_xxxxxxxx"
						/>
					</div>

					{/* Connection Status */}
					{envConfig.linearApiKey && (
						<ConnectionStatus
							isChecking={isCheckingLinear}
							isConnected={linearConnectionStatus?.connected || false}
							title={t("settings:projectSections.linear.connectionStatus")}
							successMessage={`Connected${linearConnectionStatus?.teamName ? ` to ${linearConnectionStatus.teamName}` : ""}`}
							errorMessage={linearConnectionStatus?.error || "Not connected"}
							additionalInfo={
								linearConnectionStatus?.connected &&
								linearConnectionStatus.issueCount !== undefined
									? `${linearConnectionStatus.issueCount}+ tasks available to import`
									: undefined
							}
						/>
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
										onClick={onOpenImportModal}
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
								onUpdateConfig({ linearRealtimeSync: checked })
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
									onUpdateConfig({ linearTeamId: e.target.value })
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
									onUpdateConfig({ linearProjectId: e.target.value })
								}
							/>
						</div>
					</div>
				</>
			)}
		</CollapsibleSection>
	);
}
