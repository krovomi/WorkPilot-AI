import type { PluginMarketplaceTab } from "@shared/types/plugin-marketplace";
import { BookOpen, Package, Puzzle } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	loadInstalledPlugins,
	loadPluginCatalog,
	usePluginMarketplaceStore,
} from "@/stores/plugin-marketplace-store";
import { useProjectStore } from "@/stores/project-store";
import { InstalledPluginsView } from "./InstalledPluginsView";
import { PluginCatalogView } from "./PluginCatalogView";
import { PluginSDKView } from "./PluginSDKView";
import { PageHeader } from "../ui/page-header";

const TABS: Array<{
	id: PluginMarketplaceTab;
	labelKey: string;
	icon: React.ElementType;
}> = [
	{
		id: "catalog",
		labelKey: "common:pluginMarketplace.tabs.catalog",
		icon: Puzzle,
	},
	{
		id: "installed",
		labelKey: "common:pluginMarketplace.tabs.installed",
		icon: Package,
	},
	{ id: "sdk", labelKey: "common:pluginMarketplace.tabs.sdk", icon: BookOpen },
];

export function PluginMarketplace() {
	const { t } = useTranslation(["common"]);
	const { activeTab, setActiveTab, installed, error } =
		usePluginMarketplaceStore();

	const projectId = useProjectStore((state) => state.selectedProjectId);

	useEffect(() => {
		loadPluginCatalog();
	}, []);

	// Installed plugins are the selected project's skills
	useEffect(() => {
		loadInstalledPlugins(projectId);
	}, [projectId]);

	return (
		<div className="flex flex-col h-full overflow-hidden bg-background">
			<PageHeader
				className="pb-0"
				icon={Puzzle}
				title={t("common:pluginMarketplace.title")}
				description={t("common:pluginMarketplace.subtitle")}
				actions={
					installed.length > 0 && (
						<span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
							{t("common:pluginMarketplace.installedBadge", {
								count: installed.length,
							})}
						</span>
					)
				}
			>
				<div className="flex gap-0">
					{TABS.map(({ id, labelKey, icon: Icon }) => (
						<button
							key={id}
							type="button"
							onClick={() => setActiveTab(id)}
							className={cn(
								"flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
								activeTab === id
									? "border-primary text-primary"
									: "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
							)}
						>
							<Icon className="h-4 w-4" />
							{t(labelKey)}
							{id === "installed" && installed.length > 0 && (
								<span className="ml-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
									{installed.length}
								</span>
							)}
						</button>
					))}
				</div>
			</PageHeader>

			{/* Error banner */}
			{error && (
				<div className="shrink-0 bg-destructive/10 border-b border-destructive/20 px-6 py-2 text-xs text-destructive">
					{error}
				</div>
			)}

			{/* Content */}
			<div className="flex-1 overflow-hidden">
				{activeTab === "catalog" && <PluginCatalogView />}
				{activeTab === "installed" && <InstalledPluginsView />}
				{activeTab === "sdk" && <PluginSDKView />}
			</div>
		</div>
	);
}
