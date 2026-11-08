import type { PluginMarketplaceTab } from "@shared/types/plugin-marketplace";
import { AlertTriangle, BookOpen, Package, Puzzle, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
	loadInstalledPlugins,
	loadPluginCatalog,
	usePluginMarketplaceStore,
} from "@/stores/plugin-marketplace-store";
import { useProjectStore } from "@/stores/project-store";
import { InstalledPluginsView } from "./InstalledPluginsView";
import { PluginCatalogView } from "./PluginCatalogView";
import { PluginSDKView } from "./PluginSDKView";
import { Chip, ModuleHeader, ModuleStage, Notice, Tabs } from "../charter";

const TABS: Array<{
	id: PluginMarketplaceTab;
	labelKey: string;
	icon: LucideIcon;
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
	const { t } = useTranslation(["common", "navigation"]);
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
		<ModuleStage data-testid="plugin-marketplace-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("common:pluginMarketplace.title")}
				description={t("common:pluginMarketplace.subtitle")}
				icon={Puzzle}
				tone="violet"
				actions={
					installed.length > 0 && (
						<Chip tone="violet" dot={false}>
							{t("common:pluginMarketplace.installedBadge", { count: installed.length })}
						</Chip>
					)
				}
			/>
			<div className="relative z-[1] px-6 pt-3">
				<Tabs
					label={t("common:pluginMarketplace.title")}
					tabs={TABS.map(({ id, labelKey, icon }) => ({
						id,
						label: t(labelKey),
						icon,
						count: id === "installed" && installed.length > 0 ? installed.length : undefined,
					}))}
					value={activeTab}
					onChange={setActiveTab}
				/>
			</div>
			{error && (
				<div className="relative z-[1] px-6 pt-3">
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				</div>
			)}
			<div className="relative z-[1] flex-1 overflow-hidden">
				{activeTab === "catalog" && <PluginCatalogView />}
				{activeTab === "installed" && <InstalledPluginsView />}
				{activeTab === "sdk" && <PluginSDKView />}
			</div>
		</ModuleStage>
	);
}
