/**
 * MCP Marketplace — Main View Component
 *
 * The universal integration ecosystem. Provides:
 * - Catalog: Browse and install MCP servers
 * - Installed: Manage installed servers
 * - Builder: Create custom MCP servers (no-code)
 */

import {
	ArrowUpDown,
	BadgeCheck,
	Download,
	RefreshCw,
	Search,
	Store,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
	McpCategory,
	McpMarketplaceTab,
} from "../../../shared/types/mcp-marketplace";
import {
	loadBuilderProjects,
	loadInstalledServers,
	loadMarketplaceCatalog,
	useMcpMarketplaceStore,
} from "../../stores/mcp-marketplace-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	ScanLine,
	Tabs,
} from "../charter";
import { Input } from "../ui/input";
import { McpBuilder } from "./McpBuilder";
import { McpInstalledList } from "./McpInstalledList";
import { McpServerCard } from "./McpServerCard";

const TABS: { id: McpMarketplaceTab; labelKey: string; icon: typeof Store }[] =
	[
		{ id: "catalog", labelKey: "mcpMarketplace.tabs.catalog", icon: Store },
		{
			id: "installed",
			labelKey: "mcpMarketplace.tabs.installed",
			icon: Download,
		},
		{ id: "builder", labelKey: "mcpMarketplace.tabs.builder", icon: Wrench },
	];

const CATEGORIES: { value: McpCategory | "all"; labelKey: string }[] = [
	{ value: "all", labelKey: "mcpMarketplace.categories.all" },
	{
		value: "communication",
		labelKey: "mcpMarketplace.categories.communication",
	},
	{
		value: "project-management",
		labelKey: "mcpMarketplace.categories.projectManagement",
	},
	{ value: "design", labelKey: "mcpMarketplace.categories.design" },
	{ value: "monitoring", labelKey: "mcpMarketplace.categories.monitoring" },
	{
		value: "version-control",
		labelKey: "mcpMarketplace.categories.versionControl",
	},
	{
		value: "documentation",
		labelKey: "mcpMarketplace.categories.documentation",
	},
	{ value: "database", labelKey: "mcpMarketplace.categories.database" },
	{ value: "cloud", labelKey: "mcpMarketplace.categories.cloud" },
	{ value: "testing", labelKey: "mcpMarketplace.categories.testing" },
	{ value: "web", labelKey: "mcpMarketplace.categories.web" },
	{ value: "ai", labelKey: "mcpMarketplace.categories.ai" },
];

export function McpMarketplace() {
	const { t } = useTranslation(["common", "navigation"]);
	const {
		activeTab,
		setActiveTab,
		filters,
		setFilters,
		getFilteredCatalog,
		installed,
		isCatalogLoading,
	} = useMcpMarketplaceStore();

	const projectId = useProjectStore((state) => state.selectedProjectId);

	const filteredCatalog = getFilteredCatalog();

	// Load data on mount
	useEffect(() => {
		loadMarketplaceCatalog();
		loadBuilderProjects();
	}, []);

	// Installed servers are the selected project's
	useEffect(() => {
		loadInstalledServers(projectId);
	}, [projectId]);

	const handleRefresh = useCallback(() => {
		loadMarketplaceCatalog();
		loadInstalledServers(projectId);
		loadBuilderProjects();
	}, [projectId]);

	return (
		<ModuleStage data-testid="mcp-marketplace-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("mcpMarketplace.title")}
				description={t("mcpMarketplace.subtitle")}
				icon={Store}
				tone="blue"
				actions={
					<>
						<Chip tone="blue" dot={false}>
							{installed.length} {t("mcpMarketplace.installedCount")}
						</Chip>
						<CharterButton variant="ghost" icon={RefreshCw} onClick={handleRefresh}>
							{t("mcpMarketplace.refresh")}
						</CharterButton>
					</>
				}
			/>
			<div className="relative z-[1] px-6 pt-3">
				<Tabs
					label={t("mcpMarketplace.title")}
					tabs={TABS.map((tab) => ({
						id: tab.id,
						label: t(tab.labelKey),
						icon: tab.icon,
						count: tab.id === "installed" ? installed.length : undefined,
					}))}
					value={activeTab}
					onChange={setActiveTab}
				/>
			</div>

			{/* Catalog tab content */}
			{activeTab === "catalog" && (
				<>
					<div className="relative z-[1] flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
						<div className="relative w-72 max-w-full">
							<Search className="wp-muted pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" aria-hidden="true" />
							<Input
								type="search"
								aria-label={t("mcpMarketplace.searchPlaceholder")}
								value={filters.search}
								onChange={(e) => setFilters({ search: e.target.value })}
								placeholder={t("mcpMarketplace.searchPlaceholder")}
								className="h-8 pl-8 text-xs"
							/>
						</div>
						<Chip
							tone="blue"
							pressed={filters.sortBy === "featured"}
							onClick={() => setFilters({ sortBy: "featured" })}
							dot={false}
						>
							<ArrowUpDown className="h-3 w-3" aria-hidden="true" />
							{t("mcpMarketplace.sort.featured")}
						</Chip>
						<Chip
							tone="blue"
							pressed={filters.sortBy === "name"}
							onClick={() => setFilters({ sortBy: "name" })}
							dot={false}
						>
							{t("mcpMarketplace.sort.name")}
						</Chip>
						<Chip
							tone="green"
							pressed={filters.showOfficialOnly}
							onClick={() => setFilters({ showOfficialOnly: !filters.showOfficialOnly })}
							dot={false}
						>
							<BadgeCheck className="h-3 w-3" aria-hidden="true" />
							{t("mcpMarketplace.officialOnly")}
						</Chip>
					</div>
					<div className="wp-chips relative z-[1] shrink-0 px-6 pb-3">
						{CATEGORIES.map((cat) => (
							<Chip
								key={cat.value}
								tone="violet"
								dot={false}
								pressed={filters.category === cat.value}
								onClick={() => setFilters({ category: cat.value })}
							>
								{t(cat.labelKey)}
							</Chip>
						))}
					</div>

					{/* Catalog grid */}
					<div className="relative z-[1] flex-1 overflow-auto px-6 pb-6">
						{!projectId && (
							<Notice tone="amber" className="mb-4">
								{t("mcpMarketplace.noProject")}
							</Notice>
						)}
						{isCatalogLoading ? (
							<ScanLine />
						) : filteredCatalog.length === 0 ? (
							<EmptyStage icon={Search} tone="blue" title={t("mcpMarketplace.noResults")}>
								{t("mcpMarketplace.noResultsHint")}
							</EmptyStage>
						) : (
							<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
								{filteredCatalog.map((server) => (
									<McpServerCard key={server.id} server={server} />
								))}
							</div>
						)}
					</div>
				</>
			)}

			{/* Installed tab content */}
			{activeTab === "installed" && <McpInstalledList />}

			{/* Builder tab content */}
			{activeTab === "builder" && <McpBuilder />}
		</ModuleStage>
	);
}
