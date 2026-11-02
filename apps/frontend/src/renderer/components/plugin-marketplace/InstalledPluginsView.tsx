import type { CatalogPluginType } from "@shared/types/plugin-marketplace";
import { PackageOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	uninstallPlugin,
	usePluginMarketplaceStore,
} from "@/stores/plugin-marketplace-store";
import { Button } from "../ui/button";

const TYPE_COLORS: Record<CatalogPluginType, string> = {
	agent: "bg-purple-500/10 text-purple-500",
	"spec-template": "bg-green-500/10 text-green-500",
	"custom-prompt": "bg-pink-500/10 text-pink-500",
};

/** The catalog plugins installed as skills of the selected project. */
export function InstalledPluginsView() {
	const { t } = useTranslation(["common"]);
	const { installed, isInstalledLoading, projectId } =
		usePluginMarketplaceStore();

	const typeLabel: Record<CatalogPluginType, string> = {
		agent: t("common:pluginMarketplace.types.agent"),
		"spec-template": t("common:pluginMarketplace.types.specTemplate"),
		"custom-prompt": t("common:pluginMarketplace.types.customPrompt"),
	};

	if (isInstalledLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
			</div>
		);
	}

	if (!projectId || installed.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
				<PackageOpen className="h-10 w-10 opacity-40" />
				<p className="text-sm font-medium">
					{projectId
						? t("common:pluginMarketplace.noInstalledPlugins")
						: t("common:pluginMarketplace.noProject")}
				</p>
				{projectId && (
					<p className="text-xs">
						{t("common:pluginMarketplace.browseToInstall")}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full overflow-y-auto px-6 py-4">
			<p className="text-xs text-muted-foreground mb-4">
				{t("common:pluginMarketplace.installedCount", {
					count: installed.length,
				})}
			</p>
			<div className="space-y-3">
				{installed.map((plugin) => (
					<div
						key={plugin.pluginId}
						className="flex items-center justify-between rounded-xl border border-border bg-card p-4"
					>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="font-medium text-sm">{plugin.name}</span>
								<span
									className={cn(
										"rounded-full px-2 py-0.5 text-[10px] font-medium",
										TYPE_COLORS[plugin.type],
									)}
								>
									{typeLabel[plugin.type]}
								</span>
							</div>
							<p className="text-xs text-muted-foreground mt-0.5 truncate">
								{t("common:pluginMarketplace.installedIn", {
									paths: plugin.paths.join(", "),
								})}
							</p>
							<p className="text-[10px] text-muted-foreground mt-0.5">
								{t("common:pluginMarketplace.howToUse", { id: plugin.pluginId })}
							</p>
						</div>

						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
							onClick={() => uninstallPlugin(projectId, plugin.pluginId)}
							title={t("common:pluginMarketplace.actions.uninstall")}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}
