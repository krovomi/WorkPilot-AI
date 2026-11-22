/**
 * Agent Tools Overview
 *
 * Displays MCP server and tool configuration for each agent phase.
 * Helps users understand what tools are available during different execution phases.
 * Now shows per-project MCP configuration with toggles to enable/disable servers.
 */

import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	ClipboardList,
	Code,
	FileCheck,
	Globe,
	Info,
	Lightbulb,
	ListChecks,
	Loader2,
	Lock,
	Monitor,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Server,
	Settings2,
	Terminal,
	Trash2,
	Wrench,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AVAILABLE_MODELS,
	THINKING_LEVELS,
} from "../../shared/constants/models";
import type {
	AgentMcpOverride,
	AgentMcpOverrides,
	CustomMcpServer,
	McpHealthCheckResult,
	McpTestConnectionResult,
	ProjectEnvConfig,
} from "../../shared/types";
import type { ThinkingLevel } from "../../shared/types/settings";
import {
	type AgentSettingsSource,
	resolveAgentSettings as resolveAgentModelConfig,
	useProjectEnvConfig,
	useResolvedAgentSettings,
} from "../hooks";
import { useProjectStore } from "../stores/project-store";
import { useSettingsStore } from "../stores/settings-store";
import type { McpPolicyRefusal, McpPolicyRefusalData } from "../../shared/types/mcp-policy";
import { CustomMcpDialog } from "./CustomMcpDialog";
import { McpPolicyRefusalNotice } from "./mcp-marketplace/McpPolicyNotice";
import { McpServerSettingsDialog } from "./McpServerSettingsDialog";
import { TokenSavingsSettings } from "./settings/TokenSavingsSettings";
import { UiUxSettings } from "./settings/UiUxSettings";
import { McpPinsSection } from "./settings/McpPinsSection";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Chip, ModuleHeader, ModuleStage, Page } from "./charter";

// Agent configuration data - mirrors AGENT_CONFIGS from backend
// Model and thinking are now dynamically read from user settings
// Labels and descriptions live in settings:agents.<id>.
interface AgentConfig {
	category: string;
	tools: string[];
	mcp_servers: string[];
	mcp_optional?: string[];
	// Maps to settings source - either a phase or a feature
	settingsSource: AgentSettingsSource;
}

// Helper to get model label from short name
function getModelLabel(modelShort: string): string {
	const model = AVAILABLE_MODELS.find((m) => m.value === modelShort);
	return model?.label.replace("Claude ", "") || modelShort;
}

// Helper to get thinking label from level
function getThinkingLabel(level: ThinkingLevel): string {
	const thinking = THINKING_LEVELS.find((t) => t.value === level);
	return thinking?.label || level;
}

const AGENT_CONFIGS: Record<string, AgentConfig> = {
	// Spec Creation Phases - all use 'spec' phase settings
	spec_researcher: {
		category: "spec",
		tools: [
			"Read",
			"Glob",
			"Grep",
			"WebFetch",
			"WebSearch",
			"Write",
			"Edit",
			"Bash",
		],
		mcp_servers: ["context7"],
		settingsSource: { type: "phase", phase: "spec" },
	},
	spec_writer: {
		category: "spec",
		tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
		mcp_servers: [],
		settingsSource: { type: "phase", phase: "spec" },
	},
	spec_critic: {
		category: "spec",
		tools: ["Read", "Glob", "Grep"],
		mcp_servers: [],
		settingsSource: { type: "phase", phase: "spec" },
	},
	spec_self_critique: {
		category: "spec",
		tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
		mcp_servers: ["context7"],
		settingsSource: { type: "phase", phase: "spec" },
	},
	spec_validation: {
		category: "spec",
		tools: ["Read", "Glob", "Grep"],
		mcp_servers: [],
		settingsSource: { type: "phase", phase: "spec" },
	},

	// Build Phases
	planner: {
		category: "build",
		tools: [
			"Read",
			"Glob",
			"Grep",
			"Write",
			"Edit",
			"Bash",
			"WebFetch",
			"WebSearch",
		],
		mcp_servers: ["context7", "auto-claude"],
		mcp_optional: ["linear"],
		settingsSource: { type: "phase", phase: "planning" },
	},
	coder: {
		category: "build",
		tools: [
			"Read",
			"Glob",
			"Grep",
			"Write",
			"Edit",
			"Bash",
			"WebFetch",
			"WebSearch",
		],
		mcp_servers: ["context7", "auto-claude"],
		mcp_optional: ["linear"],
		settingsSource: { type: "phase", phase: "coding" },
	},

	// QA Phases
	qa_reviewer: {
		category: "qa",
		tools: ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"],
		mcp_servers: ["context7", "auto-claude"],
		mcp_optional: ["linear", "electron", "puppeteer"],
		settingsSource: { type: "phase", phase: "qa" },
	},
	qa_fixer: {
		category: "qa",
		tools: [
			"Read",
			"Glob",
			"Grep",
			"Write",
			"Edit",
			"Bash",
			"WebFetch",
			"WebSearch",
		],
		mcp_servers: ["context7", "auto-claude"],
		mcp_optional: ["linear", "electron", "puppeteer"],
		settingsSource: { type: "phase", phase: "qa" },
	},
	verifier: {
		category: "qa",
		tools: [
			"Read",
			"Glob",
			"Grep",
			"Write",
			"Edit",
			"Bash",
			"WebFetch",
			"WebSearch",
		],
		mcp_servers: ["context7", "auto-claude", "workpilot-verify"],
		mcp_optional: ["electron", "puppeteer", "chrome-devtools"],
		settingsSource: { type: "phase", phase: "qa" },
	},

	// Utility Phases - use feature settings
	pr_reviewer: {
		category: "utility",
		tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
		mcp_servers: ["context7"],
		settingsSource: { type: "feature", feature: "githubPrs" },
	},
	commit_message: {
		category: "utility",
		tools: [],
		mcp_servers: [],
		settingsSource: { type: "feature", feature: "utility" },
	},
	merge_resolver: {
		category: "utility",
		tools: [],
		mcp_servers: [],
		settingsSource: { type: "feature", feature: "utility" },
	},
	insights: {
		category: "utility",
		tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
		mcp_servers: [],
		settingsSource: { type: "feature", feature: "insights" },
	},
	batch_analysis: {
		category: "utility",
		tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
		mcp_servers: [],
		// Batch uses same as GitHub Issues
		settingsSource: { type: "feature", feature: "githubIssues" },
	},

	// Ideation & Roadmap - use feature settings
	ideation: {
		category: "ideation",
		tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
		mcp_servers: [],
		settingsSource: { type: "feature", feature: "ideation" },
	},
	roadmap_discovery: {
		category: "ideation",
		tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
		mcp_servers: ["context7"],
		settingsSource: { type: "feature", feature: "roadmap" },
	},
	pr_template_filler: {
		category: "utility",
		tools: ["Read", "Glob", "Grep"],
		mcp_servers: [],
		settingsSource: { type: "feature", feature: "utility" },
	},
};

// The MCP servers an agent can be given. Name and description live in
// settings:mcp.servers.<i18nKey>; `requiresSetup` marks the ones that need a
// key or an integration before they start.
const MCP_SERVERS: Record<
	string,
	{ i18nKey: string; icon: React.ElementType; requiresSetup?: boolean }
> = {
	context7: { i18nKey: "context7", icon: Search },
	"auto-claude": { i18nKey: "autoClaude", icon: ListChecks },
	linear: { i18nKey: "linear", icon: ClipboardList, requiresSetup: true },
	electron: { i18nKey: "electron", icon: Monitor, requiresSetup: true },
	puppeteer: { i18nKey: "puppeteer", icon: Globe },
	"chrome-devtools": { i18nKey: "chromeDevtools", icon: Monitor },
	"workpilot-verify": { i18nKey: "workpilotVerify", icon: FileCheck },
	github: { i18nKey: "github", icon: Code, requiresSetup: true },
	"brave-search": { i18nKey: "braveSearch", icon: Search, requiresSetup: true },
	jira: { i18nKey: "jira", icon: ClipboardList, requiresSetup: true },
	"azure-devops": {
		i18nKey: "azureDevops",
		icon: ClipboardList,
		requiresSetup: true,
	},
	sentry: { i18nKey: "sentry", icon: AlertCircle, requiresSetup: true },
	slack: { i18nKey: "slack", icon: Globe, requiresSetup: true },
	postman: { i18nKey: "postman", icon: Globe, requiresSetup: true },
	teams: { i18nKey: "teams", icon: Globe, requiresSetup: true },
};

// Ids a custom server cannot take: the build reads them as its own servers
// (_map_mcp_server_name in agents/tools_pkg/models.py), so a custom "github"
// added to an agent would start the built-in one instead.
const RESERVED_MCP_IDS = [
	...Object.keys(MCP_SERVERS),
	"workpilot",
	"brain",
	"workpilot-brain",
	"uiux",
	"workpilot-uiux",
	"ui-ux-pro-max",
	"verify",
	"code",
	"workpilot-code",
	"search_code",
];

// MCP servers grouped by category for the add dialog
const MCP_CATEGORY_GROUPS: Array<{
	labelKey: string;
	ids: string[];
}> = [
	{
		labelKey: "mcp.categories.core",
		ids: ["context7"],
	},
	{
		labelKey: "mcp.categories.projectMgmt",
		ids: ["linear", "jira", "azure-devops"],
	},
	{
		labelKey: "mcp.categories.devTools",
		ids: ["github"],
	},
	{
		labelKey: "mcp.categories.search",
		ids: ["brave-search"],
	},
	{
		labelKey: "mcp.categories.testingQA",
		ids: ["electron", "puppeteer", "postman"],
	},
	{
		labelKey: "mcp.categories.monitoring",
		ids: ["sentry"],
	},
	{
		labelKey: "mcp.categories.communication",
		ids: ["slack", "teams"],
	},
];

// All available MCP servers that can be added to agents
const ALL_MCP_SERVERS = [
	"context7",
	"linear",
	"electron",
	"puppeteer",
	"auto-claude",
	"github",
	"brave-search",
	"jira",
	"azure-devops",
	"sentry",
	"slack",
	"postman",
	"teams",
] as const;

// Category metadata - neutral styling per design.json
// Names live in settings:agents.categories.<id>.
const CATEGORIES = {
	spec: { icon: FileCheck },
	build: { icon: Code },
	qa: { icon: CheckCircle2 },
	utility: { icon: Wrench },
	ideation: { icon: Lightbulb },
};

interface AgentCardProps {
	readonly id: string;
	readonly config: (typeof AGENT_CONFIGS)[keyof typeof AGENT_CONFIGS];
	readonly modelLabel: string;
	readonly thinkingLabel: string;
	readonly overrides: AgentMcpOverride | undefined;
	readonly mcpServerStates: ProjectEnvConfig["mcpServers"];
	readonly linearEnabled: boolean;
	readonly customServers: CustomMcpServer[];
	readonly onAddMcp: (agentId: string, mcpId: string) => void;
	readonly onRemoveMcp: (agentId: string, mcpId: string) => void;
	readonly onConfigureMcp: (mcpId: string) => void;
}

// Status of a custom MCP server, as an icon named for screen readers
const STATUS_ICONS: Record<
	"checking" | "healthy" | "needsAuth" | "unhealthy" | "unknown",
	React.ReactNode
> = {
	checking: (
		<Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
	),
	healthy: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
	needsAuth: <Lock className="h-3.5 w-3.5 text-warning" />,
	unhealthy: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
	unknown: <Circle className="h-3.5 w-3.5 text-muted-foreground" />,
};

function StatusIndicator({
	isTesting,
	health,
}: {
	readonly isTesting: boolean;
	readonly health?: McpHealthCheckResult;
}) {
	const { t } = useTranslation(["settings"]);
	let status: keyof typeof STATUS_ICONS = "unknown";
	if (isTesting || health?.status === "checking") status = "checking";
	else if (health?.status === "healthy") status = "healthy";
	else if (health?.status === "needs_auth") status = "needsAuth";
	else if (health?.status === "unhealthy") status = "unhealthy";
	return (
		<span role="img" aria-label={t(`settings:mcp.status.${status}`)}>
			{STATUS_ICONS[status]}
		</span>
	);
}

function AgentCard({
	id,
	config,
	modelLabel,
	thinkingLabel,
	overrides,
	mcpServerStates,
	linearEnabled,
	customServers,
	onAddMcp,
	onRemoveMcp,
	onConfigureMcp,
}: AgentCardProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [showAddDialog, setShowAddDialog] = useState(false);
	const [mcpSearch, setMcpSearch] = useState("");
	const { t } = useTranslation(["settings"]);
	const category = CATEGORIES[config.category as keyof typeof CATEGORIES];
	const CategoryIcon = category.icon;

	// Name, description and icon of every server, custom ones included
	const allMcpServers = useMemo(() => {
		const servers: Record<
			string,
			{
				name: string;
				description: string;
				icon: React.ElementType;
				requiresSetup?: boolean;
			}
		> = {};
		for (const [mcpId, server] of Object.entries(MCP_SERVERS)) {
			servers[mcpId] = {
				name: t(`settings:mcp.servers.${server.i18nKey}.name`),
				description: t(`settings:mcp.servers.${server.i18nKey}.description`),
				icon: server.icon,
				requiresSetup: server.requiresSetup,
			};
		}
		for (const custom of customServers) {
			servers[custom.id] = {
				name: custom.name,
				description:
					custom.description ||
					(custom.type === "command"
						? `${custom.command} ${custom.args?.join(" ") || ""}`
						: custom.url || ""),
				icon: custom.type === "command" ? Terminal : Globe,
			};
		}
		return servers;
	}, [customServers, t]);

	// The servers this agent starts with, as the build resolves them
	// (get_required_mcp_servers): a default server only when the project turns
	// it on, a server added for this agent always, minus the ones removed.
	const effectiveMcps = useMemo(() => {
		const states = mcpServerStates ?? {};
		const startsByDefault = (mcp: string) => {
			switch (mcp) {
				case "context7":
					return states.context7Enabled !== false;
				case "linear":
					return linearEnabled && states.linearMcpEnabled !== false;
				case "electron":
					return states.electronEnabled === true;
				case "puppeteer":
					return states.puppeteerEnabled === true;
				case "chrome-devtools":
					return states.chromeDevtoolsEnabled === true;
				default:
					return true;
			}
		};
		const defaults = [
			...config.mcp_servers,
			...(config.mcp_optional || []),
		].filter(startsByDefault);
		const removed = overrides?.remove || [];
		return [...new Set([...defaults, ...(overrides?.add || [])])].filter(
			(mcp) => !removed.includes(mcp),
		);
	}, [config, overrides, mcpServerStates, linearEnabled]);

	// Check if an MCP is a custom addition (not in defaults)
	const isCustomAdd = (mcpId: string) => {
		const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
		return !defaults.includes(mcpId) && (overrides?.add || []).includes(mcpId);
	};

	// Get removed MCPs (from defaults)
	const removedMcps = useMemo(() => {
		const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
		return defaults.filter((mcp) => (overrides?.remove || []).includes(mcp));
	}, [config, overrides]);

	// Get MCPs that can be added (not already in effective list) - includes custom servers
	const customServerIds = customServers.map((s) => s.id);
	const allAvailableMcpIds = [...ALL_MCP_SERVERS, ...customServerIds];
	const availableMcps = allAvailableMcpIds.filter(
		(mcp) =>
			!effectiveMcps.includes(mcp) &&
			!removedMcps.includes(mcp) &&
			mcp !== "auto-claude",
	);

	// Group available MCPs by category, filtered by search query
	const groupedAvailableMcps = useMemo(() => {
		// Every server that can be added is a known or a custom one, so it
		// has a name and a description to search.
		const searchLower = mcpSearch.toLowerCase().trim();
		const matches = (id: string) =>
			[id, allMcpServers[id].name, allMcpServers[id].description].some(
				(text) => text.toLowerCase().includes(searchLower),
			);
		const knownIds = new Set(MCP_CATEGORY_GROUPS.flatMap((g) => g.ids));
		const result: Array<{ labelKey: string; items: string[] }> = [];

		for (const group of MCP_CATEGORY_GROUPS) {
			const items = group.ids.filter(
				(id) => availableMcps.includes(id) && matches(id),
			);
			if (items.length > 0) result.push({ ...group, items });
		}

		// Custom servers not in any known category
		const customItems = availableMcps.filter(
			(id) => !knownIds.has(id) && matches(id),
		);
		if (customItems.length > 0) {
			result.push({ labelKey: "mcp.categories.custom", items: customItems });
		}

		return result;
	}, [availableMcps, allMcpServers, mcpSearch]);

	return (
		<div className="border border-border rounded-lg bg-card overflow-hidden">
			{/* Header - clickable to expand */}
			<button
				type="button"
				onClick={() => setIsExpanded(!isExpanded)}
				className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
			>
				<div className="p-2 rounded-lg bg-muted">
					<CategoryIcon className="h-4 w-4 text-muted-foreground" />
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<h3 className="font-medium text-sm text-foreground">
							{t(`agents.${id}.label`)}
						</h3>
						<span className="px-2 py-0.5 rounded text-3xs font-medium bg-secondary text-secondary-foreground">
							{modelLabel}
						</span>
						<span className="px-2 py-0.5 rounded text-3xs font-medium bg-secondary text-secondary-foreground">
							{thinkingLabel}
						</span>
					</div>
					<p className="text-xs text-muted-foreground truncate">
						{t(`agents.${id}.description`)}
					</p>
				</div>
				<div className="flex items-center gap-2 text-muted-foreground">
					<span className="text-xs">{effectiveMcps.length} MCP</span>
					{isExpanded ? (
						<ChevronDown className="h-4 w-4" />
					) : (
						<ChevronRight className="h-4 w-4" />
					)}
				</div>
			</button>

			{/* Expanded content */}
			{isExpanded && (
				<div className="border-t border-border p-4 space-y-4 bg-muted/30">
					{/* MCP Servers */}
					<div>
						<div className="flex items-center justify-between mb-2">
							<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
								{t("settings:agentToolsPanel.mcpServers")}
							</h4>
							{availableMcps.length > 0 && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setShowAddDialog(true);
									}}
									className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
								>
									<Plus className="h-3 w-3" />
									{t("mcp.addServer")}
								</button>
							)}
						</div>
						{effectiveMcps.length > 0 || removedMcps.length > 0 ? (
							<div className="space-y-2">
								{/* Active MCPs */}
								{effectiveMcps.map((server) => {
									const serverInfo = allMcpServers[server];
									const ServerIcon = serverInfo?.icon || Server;
									const isAdded = isCustomAdd(server);
									const canRemove = server !== "auto-claude";

									return (
										<div
											key={server}
											className="flex items-center justify-between group"
										>
											{/* The row itself opens the server's settings: seeing a
											    server on an agent and changing that server used to be
											    two unrelated places on the same screen. */}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													onConfigureMcp(server);
												}}
												className="flex items-center gap-2 text-sm text-left rounded px-1 -mx-1 hover:bg-muted/60 transition-colors"
												title={t("mcp.configureServer")}
											>
												<CheckCircle2 className="h-3.5 w-3.5 text-success" />
												<ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
												<span className="font-medium group-hover:underline">
													{serverInfo?.name || server}
												</span>
												{isAdded && (
													<span className="text-3xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
														{t("mcp.added")}
													</span>
												)}
											</button>
											<div className="flex items-center">
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onConfigureMcp(server);
													}}
													className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-primary transition-all"
													title={t("mcp.configureServer")}
												>
													<Settings2 className="h-3.5 w-3.5" />
												</button>
												{canRemove && (
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															onRemoveMcp(id, server);
														}}
														className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-all"
														title={t("mcp.remove")}
													>
														<X className="h-3.5 w-3.5" />
													</button>
												)}
											</div>
										</div>
									);
								})}

								{/* Removed MCPs (grayed out with restore option) */}
								{removedMcps.map((server) => {
									const serverInfo = allMcpServers[server];
									const ServerIcon = serverInfo.icon;

									return (
										<div
											key={server}
											className="flex items-center justify-between group opacity-50"
										>
											<div className="flex items-center gap-2 text-sm line-through">
												<Circle className="h-3.5 w-3.5 text-muted-foreground" />
												<ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
												<span className="font-medium">
													{serverInfo.name}
												</span>
												<span className="text-3xs text-muted-foreground no-underline">
													({t("mcp.removed")})
												</span>
											</div>
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													onAddMcp(id, server);
												}}
												className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-primary transition-all"
												title={t("mcp.restore")}
											>
												<RotateCcw className="h-3.5 w-3.5" />
											</button>
										</div>
									);
								})}
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								{t("mcp.noMcpServers")}
							</p>
						)}
					</div>

					{/* Tools */}
					<div>
						<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
							{t("agents.availableTools")}
						</h4>
						{config.tools.length > 0 ? (
							<div className="flex flex-wrap gap-1.5">
								{config.tools.map((tool) => (
									<span
										key={tool}
										className="px-2 py-1 bg-muted rounded text-xs font-mono"
									>
										{tool}
									</span>
								))}
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								{t("agents.textOnly")}
							</p>
						)}
					</div>
				</div>
			)}

			{/* Add MCP Dialog */}
			<Dialog
				open={showAddDialog}
				onOpenChange={(open) => {
					setShowAddDialog(open);
					if (!open) setMcpSearch("");
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{t("mcp.addMcpTo", {
								agent: t(`agents.${id}.label`),
							})}
						</DialogTitle>
						<DialogDescription>{t("mcp.addMcpDescription")}</DialogDescription>
					</DialogHeader>

					{/* Search */}
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
						<Input
							type="text"
							value={mcpSearch}
							onChange={(e) => setMcpSearch(e.target.value)}
							placeholder={t("mcp.searchPlaceholder")}
							className="w-full pl-9 pr-3 py-2 text-sm h-auto"
						/>
					</div>

					<div className="overflow-y-auto max-h-[400px] space-y-4 pr-1 pt-1">
						{groupedAvailableMcps.length > 0 ? (
							groupedAvailableMcps.map((group, index) => (
								<div
									key={group.labelKey}
									className={index > 0 ? "pt-2" : ""}
								>
									<p className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 px-1">
										{t(group.labelKey)}
									</p>
									<div className="space-y-1">
										{group.items.map((mcpId) => {
											const server = allMcpServers[mcpId];
											const ServerIcon = server.icon;
											const needsSetup = server.requiresSetup;
											return (
												<button
													type="button"
													key={mcpId}
													onClick={() => {
														onAddMcp(id, mcpId);
														setShowAddDialog(false);
														setMcpSearch("");
													}}
													className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted transition-colors text-left group"
												>
													<div className="shrink-0 w-8 h-8 rounded-md bg-muted flex items-center justify-center group-hover:bg-background transition-colors">
														<ServerIcon className="h-4 w-4 text-muted-foreground" />
													</div>
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<span className="font-medium text-sm">
																{server.name}
															</span>
															{needsSetup && (
																<span className="text-3xs px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium shrink-0">
																	{t("mcp.setupRequired")}
																</span>
															)}
														</div>
														<p className="text-xs text-muted-foreground truncate">
															{server.description}
														</p>
													</div>
													<Plus className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
												</button>
											);
										})}
									</div>
								</div>
							))
						) : (
							// The dialog only opens while a server can be added and
							// closes once one is, so an empty list means the search.
							<p className="text-sm text-muted-foreground text-center py-6">
								{t("mcp.noSearchResults")}
							</p>
						)}

						{/* Restore removed MCPs */}
						{removedMcps.length > 0 && !mcpSearch && (
							<div className="border-t border-border pt-3">
								<p className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 px-1">
									{t("mcp.restore")}
								</p>
								<div className="space-y-1">
									{removedMcps.map((mcpId) => {
										const server = allMcpServers[mcpId];
										const ServerIcon = server.icon;
										return (
											<button
												type="button"
												key={mcpId}
												onClick={() => {
													onAddMcp(id, mcpId);
													setShowAddDialog(false);
												}}
												className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted transition-colors text-left group opacity-60 hover:opacity-100"
											>
												<div className="shrink-0 w-8 h-8 rounded-md bg-muted flex items-center justify-center">
													<ServerIcon className="h-4 w-4 text-muted-foreground" />
												</div>
												<div className="flex-1 min-w-0">
													<div className="font-medium text-sm">
														{server.name}
													</div>
													<p className="text-xs text-muted-foreground truncate">
														{server.description}
													</p>
												</div>
												<RotateCcw className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
											</button>
										);
									})}
								</div>
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

// Stable empty values: the health check runs again whenever the list changes.
const NO_CUSTOM_SERVERS: CustomMcpServer[] = [];
const NO_OVERRIDES: AgentMcpOverrides = {};

export function AgentTools() {
	const { t } = useTranslation(["settings", "navigation"]);
	const settings = useSettingsStore((state) => state.settings);
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
		new Set(["spec", "build", "qa"]),
	);
	// Bound to the project it was read for, so a save fired while another
	// project is loading cannot write this one's settings into it.
	const { envConfig, setEnvConfig } = useProjectEnvConfig(
		selectedProjectId,
		selectedProject?.autoBuildPath,
	);
	const customServers = envConfig?.customMcpServers ?? NO_CUSTOM_SERVERS;
	const agentOverrides = envConfig?.agentMcpOverrides ?? NO_OVERRIDES;

	// Custom MCP server dialog state
	const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
	const [editingCustomServer, setEditingCustomServer] =
		useState<CustomMcpServer | null>(null);

	// Health status tracking for custom servers
	const [serverHealthStatus, setServerHealthStatus] = useState<
		Record<string, McpHealthCheckResult>
	>({});
	const [testingServers, setTestingServers] = useState<Set<string>>(new Set());
	// Why the project's MCP policy refused the last save, until the next one.
	const [policyRefusal, setPolicyRefusal] = useState<McpPolicyRefusal | null>(null);

	// Update MCP server toggle
	// Which server's settings are open. A custom server routes to the editor it
	// already has; a built-in one gets the dialog above.
	const [configuringServerId, setConfiguringServerId] = useState<string | null>(
		null,
	);
	const configuringServer = configuringServerId
		? MCP_SERVERS[configuringServerId]
		: undefined;

	const handleConfigureMcp = useCallback(
		(mcpId: string) => {
			const custom = customServers.find((server) => server.id === mcpId);
			if (custom) {
				setEditingCustomServer(custom);
				setShowCustomMcpDialog(true);
				return;
			}
			setConfiguringServerId(mcpId);
		},
		[customServers],
	);

	// Saves part of the project's configuration and shows it at once. A save
	// that throws or that the main process refuses puts the previous values
	// back, so the screen never shows a setting the build will not read.
	const saveEnvPatch = useCallback(
		async (patch: Partial<ProjectEnvConfig>) => {
			if (!selectedProjectId || !envConfig) return;
			const previous: Partial<ProjectEnvConfig> = {};
			for (const key of Object.keys(patch) as Array<keyof ProjectEnvConfig>) {
				Object.assign(previous, { [key]: envConfig[key] });
			}
			setEnvConfig({ ...envConfig, ...patch });
			let saved = false;
			try {
				const result = await globalThis.electronAPI.updateProjectEnv(
					selectedProjectId,
					patch,
				);
				saved = result.success;
				setPolicyRefusal(
					saved ? null : ((result.data as McpPolicyRefusalData | undefined)?.mcpPolicyRefusal ?? null),
				);
			} catch (error) {
				console.error("Failed to save the project's agent tools:", error);
			}
			if (!saved) {
				setEnvConfig((prev) => (prev ? { ...prev, ...previous } : null));
			}
		},
		[selectedProjectId, envConfig, setEnvConfig],
	);

	const updateMcpServer = useCallback(
		(
			key: keyof NonNullable<ProjectEnvConfig["mcpServers"]>,
			value: boolean | string,
		) => saveEnvPatch({ mcpServers: { ...envConfig?.mcpServers, [key]: value } }),
		[envConfig, saveEnvPatch],
	);

	// rtk — same shape as updateMcpServer, separate key. rtk is not an MCP
	// server: it is a binary on the machine, and folding it into mcpServers
	// would have the backend look for a server that does not exist.
	const updateTokenSavings = useCallback(
		(key: keyof NonNullable<ProjectEnvConfig["tokenSavings"]>, value: boolean) =>
			saveEnvPatch({
				tokenSavings: { ...envConfig?.tokenSavings, [key]: value },
			}),
		[envConfig, saveEnvPatch],
	);

	// ui-ux-pro-max — same shape as updateTokenSavings, its own key.
	const updateUiux = useCallback(
		(key: keyof NonNullable<ProjectEnvConfig["uiux"]>, value: boolean) =>
			saveEnvPatch({ uiux: { ...envConfig?.uiux, [key]: value } }),
		[envConfig, saveEnvPatch],
	);

	// Writes one agent's override; empty lists and an empty override are left out.
	const saveAgentOverride = useCallback(
		(agentId: string, add: string[], remove: string[]) => {
			const newOverrides = { ...agentOverrides };
			delete newOverrides[agentId];
			if (add.length > 0 || remove.length > 0) {
				newOverrides[agentId] = {
					...(add.length > 0 && { add }),
					...(remove.length > 0 && { remove }),
				};
			}
			return saveEnvPatch({ agentMcpOverrides: newOverrides });
		},
		[agentOverrides, saveEnvPatch],
	);

	// Adding a server this agent had removed restores it; any other goes to
	// its add list.
	const handleAddMcp = useCallback(
		(agentId: string, mcpId: string) => {
			const { add = [], remove = [] } = agentOverrides[agentId] ?? {};
			if (remove.includes(mcpId)) {
				return saveAgentOverride(
					agentId,
					add,
					remove.filter((m) => m !== mcpId),
				);
			}
			return saveAgentOverride(agentId, [...new Set([...add, mcpId])], remove);
		},
		[agentOverrides, saveAgentOverride],
	);

	// Removing one of the agent's defaults puts it on its remove list; a
	// server that was added leaves the add list.
	const handleRemoveMcp = useCallback(
		(agentId: string, mcpId: string) => {
			const { mcp_servers, mcp_optional = [] } = AGENT_CONFIGS[agentId];
			const { add = [], remove = [] } = agentOverrides[agentId] ?? {};
			const isDefault = [...mcp_servers, ...mcp_optional].includes(mcpId);
			return saveAgentOverride(
				agentId,
				add.filter((m) => m !== mcpId),
				isDefault ? [...new Set([...remove, mcpId])] : remove,
			);
		},
		[agentOverrides, saveAgentOverride],
	);

	// Saving a custom server replaces the one with its id, or adds it.
	const handleSaveCustomServer = useCallback(
		(server: CustomMcpServer) =>
			saveEnvPatch({
				customMcpServers: customServers.some((s) => s.id === server.id)
					? customServers.map((s) => (s.id === server.id ? server : s))
					: [...customServers, server],
			}),
		[customServers, saveEnvPatch],
	);

	// Deleting a custom server also takes it off every agent it was added to.
	const handleDeleteCustomServer = useCallback(
		(serverId: string) => {
			const newOverrides: AgentMcpOverrides = {};
			for (const [agentId, { add = [], remove = [] }] of Object.entries(
				agentOverrides,
			)) {
				const kept = add.filter((m) => m !== serverId);
				if (kept.length > 0 || remove.length > 0) {
					newOverrides[agentId] = {
						...(kept.length > 0 && { add: kept }),
						...(remove.length > 0 && { remove }),
					};
				}
			}
			return saveEnvPatch({
				customMcpServers: customServers.filter((s) => s.id !== serverId),
				agentMcpOverrides: newOverrides,
			});
		},
		[agentOverrides, customServers, saveEnvPatch],
	);

	// Check health of all custom MCP servers. A check that is refused or
	// throws leaves the server "unknown", never spinning.
	const checkAllServersHealth = useCallback(async () => {
		for (const server of customServers) {
			setServerHealthStatus((prev) => ({
				...prev,
				[server.id]: {
					serverId: server.id,
					status: "checking",
					checkedAt: new Date().toISOString(),
				},
			}));

			let health: McpHealthCheckResult | undefined;
			try {
				const result = await globalThis.electronAPI.checkMcpHealth(
					server,
					selectedProjectId ?? undefined,
				);
				health = result.success ? result.data : undefined;
			} catch (error) {
				console.warn(`Health check failed for MCP server ${server.id}:`, error);
			}
			setServerHealthStatus((prev) => ({
				...prev,
				[server.id]: health ?? {
					serverId: server.id,
					status: "unknown",
					message: t("settings:mcp.healthCheckFailed"),
					checkedAt: new Date().toISOString(),
				},
			}));
		}
	}, [customServers, selectedProjectId, t]);

	// Check health when custom servers change
	useEffect(() => {
		checkAllServersHealth();
	}, [checkAllServersHealth]);

	// Test a single server connection (full test)
	const handleTestConnection = useCallback(
		async (server: CustomMcpServer) => {
			setTestingServers((prev) => new Set(prev).add(server.id));

			let test: McpTestConnectionResult | undefined;
			try {
				const result = await globalThis.electronAPI.testMcpConnection(
					server,
					selectedProjectId ?? undefined,
				);
				test = result.success ? result.data : undefined;
			} catch (error) {
				console.warn(
					`Connection test failed for MCP server ${server.id}:`,
					error,
				);
			}
			setServerHealthStatus((prev) => ({
				...prev,
				[server.id]: {
					serverId: server.id,
					status: test?.success ? "healthy" : "unhealthy",
					message: test?.confined
						? t("settings:mcp.confinedNotTested")
						: (test?.message ?? t("settings:mcp.connectionTestFailed")),
					responseTime: test?.responseTime,
					checkedAt: new Date().toISOString(),
				},
			}));
			setTestingServers((prev) => {
				const next = new Set(prev);
				next.delete(server.id);
				return next;
			});
		},
		[selectedProjectId, t],
	);

	// Resolve agent settings using the centralized utility
	// Resolution order: custom overrides -> selected profile's config -> global defaults
	const { phaseModels, phaseThinking, featureModels, featureThinking } =
		useResolvedAgentSettings(settings);

	// Get MCP server states for display
	const mcpServers = envConfig?.mcpServers || {};

	// Count enabled MCP servers
	const enabledCount = [
		mcpServers.context7Enabled !== false,
		mcpServers.linearMcpEnabled !== false && envConfig?.linearEnabled,
		mcpServers.electronEnabled,
		mcpServers.puppeteerEnabled,
		mcpServers.chromeDevtoolsEnabled,
		true, // auto-claude always enabled
	].filter(Boolean).length;

	// Resolve model and thinking for an agent based on its settings source
	const getAgentModelConfig = useMemo(() => {
		return (
			config: AgentConfig,
		): { model: string; thinking: ThinkingLevel } => {
			return resolveAgentModelConfig(config.settingsSource, {
				phaseModels,
				phaseThinking,
				featureModels,
				featureThinking,
			});
		};
	}, [phaseModels, phaseThinking, featureModels, featureThinking]);

	const toggleCategory = (category: string) => {
		setExpandedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) {
				next.delete(category);
			} else {
				next.add(category);
			}
			return next;
		});
	};

	// Group agents by category
	const agentsByCategory = Object.entries(AGENT_CONFIGS).reduce(
		(acc, [id, config]) => {
			const category = config.category;
			if (!acc[category]) {
				acc[category] = [];
			}
			acc[category].push({ id, config });
			return acc;
		},
		{} as Record<
			string,
			Array<{
				id: string;
				config: (typeof AGENT_CONFIGS)[keyof typeof AGENT_CONFIGS];
			}>
		>,
	);

	return (
		<ModuleStage scroll="page" data-testid="agent-tools-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("settings:mcp.title")}
				description={
					selectedProject
						? `${t("agents.forProject", { name: selectedProject.name })} · ${t("settings:mcp.description")}`
						: t("settings:mcp.descriptionNoProject")
				}
				icon={Wrench}
				tone="accent"
				actions={
					envConfig && (
						<Chip tone="green">{t("settings:mcp.serversEnabled", { count: enabledCount })}</Chip>
					)
				}
			/>
			{/* Content */}
			<Page className="max-w-none space-y-6">
					{/* No project selected message */}
					{!selectedProject && (
						<div className="wp-card wp-card-pad text-center">
							<AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
							<h2 className="text-sm font-medium text-foreground mb-1">
								{t("settings:mcp.noProjectSelected")}
							</h2>
							<p className="text-sm text-muted-foreground">
								{t("settings:mcp.noProjectSelectedDescription")}
							</p>
						</div>
					)}

					{/* Project not initialized message */}
					{selectedProject && !selectedProject.autoBuildPath && (
						<div className="wp-card wp-card-pad text-center">
							<Info className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
							<h2 className="text-sm font-medium text-foreground mb-1">
								{t("settings:mcp.projectNotInitialized")}
							</h2>
							<p className="text-sm text-muted-foreground">
								{t("settings:mcp.projectNotInitializedDescription")}
							</p>
						</div>
					)}

					{/* MCP Server Configuration */}
					{envConfig && (
						<div className="wp-card wp-card-pad">
							<div className="flex items-center justify-between mb-4">
								<h2 className="text-sm font-medium text-foreground">
									{t("settings:mcp.configuration")}
								</h2>
								<span className="text-xs text-muted-foreground">
									{t("settings:mcp.configurationHint")}
								</span>
							</div>

							<div className="space-y-4">
								{/* Context7 */}
								<div className="flex items-center justify-between py-2 border-b border-border last:border-0">
									<div className="flex items-center gap-3">
										<Search className="h-4 w-4 text-muted-foreground" />
										<div>
											<span className="text-sm font-medium">
												{t("settings:mcp.servers.context7.name")}
											</span>
											<p className="text-xs text-muted-foreground">
												{t("settings:mcp.servers.context7.description")}
											</p>
										</div>
									</div>
									<Switch
										checked={mcpServers.context7Enabled !== false}
										aria-label={t("settings:mcp.servers.context7.name")}
										onCheckedChange={(checked) =>
											updateMcpServer("context7Enabled", checked)
										}
									/>
								</div>

								{/* Context7 API key — optional; without it the quota is
								    the anonymous per-IP one, which a machine running
								    builds all day exhausts. Saved on blur rather than on
								    every keystroke: each save rewrites .workpilot/.env. */}
								{mcpServers.context7Enabled !== false && (
									<div className="pl-7 pb-2 space-y-1 border-b border-border last:border-0">
										<Input
											type="password"
											placeholder={t(
												"settings:mcp.servers.context7.apiKeyPlaceholder",
											)}
											defaultValue={mcpServers.context7ApiKey || ""}
											onBlur={(e) => {
												const value = e.target.value.trim();
												if (value !== (mcpServers.context7ApiKey || "")) {
													updateMcpServer("context7ApiKey", value);
												}
											}}
											className="h-8 text-xs"
										/>
										<p className="text-xs text-muted-foreground">
											{t("settings:mcp.servers.context7.apiKeyHint")}
										</p>
									</div>
								)}

								{/* Linear */}
								<div className="flex items-center justify-between py-2 border-b border-border last:border-0">
									<div className="flex items-center gap-3">
										<ClipboardList className="h-4 w-4 text-muted-foreground" />
										<div>
											<span className="text-sm font-medium">
												{t("settings:mcp.servers.linear.name")}
											</span>
											<p className="text-xs text-muted-foreground">
												{envConfig.linearEnabled
													? t("settings:mcp.servers.linear.description")
													: t("settings:mcp.servers.linear.notConfigured")}
											</p>
										</div>
									</div>
									<Switch
										aria-label={t("settings:mcp.servers.linear.name")}
										checked={
											mcpServers.linearMcpEnabled !== false &&
											envConfig.linearEnabled
										}
										onCheckedChange={(checked) =>
											updateMcpServer("linearMcpEnabled", checked)
										}
										disabled={!envConfig.linearEnabled}
									/>
								</div>

								{/* Browser Automation Section */}
								<div className="pt-2">
									<div className="flex items-center gap-2 mb-3">
										<Info className="h-3 w-3 text-muted-foreground" />
										<span className="text-xs text-muted-foreground uppercase tracking-wider">
											{t("settings:mcp.browserAutomation")}
										</span>
									</div>

									{/* Electron */}
									<div className="flex items-center justify-between py-2 border-b border-border">
										<div className="flex items-center gap-3">
											<Monitor className="h-4 w-4 text-muted-foreground" />
											<div>
												<span className="text-sm font-medium">
													{t("settings:mcp.servers.electron.name")}
												</span>
												<p className="text-xs text-muted-foreground">
													{t("settings:mcp.servers.electron.description")}
												</p>
											</div>
										</div>
										<Switch
											checked={mcpServers.electronEnabled === true}
											aria-label={t("settings:mcp.servers.electron.name")}
											onCheckedChange={(checked) =>
												updateMcpServer("electronEnabled", checked)
											}
										/>
									</div>

									{/* Puppeteer */}
									<div className="flex items-center justify-between py-2">
										<div className="flex items-center gap-3">
											<Globe className="h-4 w-4 text-muted-foreground" />
											<div>
												<span className="text-sm font-medium">
													{t("settings:mcp.servers.puppeteer.name")}
												</span>
												<p className="text-xs text-muted-foreground">
													{t("settings:mcp.servers.puppeteer.description")}
												</p>
											</div>
										</div>
										<Switch
											checked={mcpServers.puppeteerEnabled === true}
											aria-label={t("settings:mcp.servers.puppeteer.name")}
											onCheckedChange={(checked) =>
												updateMcpServer("puppeteerEnabled", checked)
											}
										/>
									</div>

									{/* Chrome DevTools */}
									<div className="flex items-center justify-between py-2">
										<div className="flex items-center gap-3">
											<Monitor className="h-4 w-4 text-muted-foreground" />
											<div>
												<span className="text-sm font-medium">
													{t("settings:mcp.servers.chromeDevtools.name")}
												</span>
												<p className="text-xs text-muted-foreground">
													{t("settings:mcp.servers.chromeDevtools.description")}
												</p>
											</div>
										</div>
										<Switch
											checked={mcpServers.chromeDevtoolsEnabled === true}
											aria-label={t("settings:mcp.servers.chromeDevtools.name")}
											onCheckedChange={(checked) =>
												updateMcpServer("chromeDevtoolsEnabled", checked)
											}
										/>
									</div>
								</div>

								{/* WorkPilot AI (always enabled) */}
								<div className="flex items-center justify-between py-2 border-t border-border opacity-60">
									<div className="flex items-center gap-3">
										<ListChecks className="h-4 w-4 text-muted-foreground" />
										<div>
											<span className="text-sm font-medium">
												{t("settings:mcp.servers.autoClaude.name")}
											</span>
											<p className="text-xs text-muted-foreground">
												{t("settings:mcp.servers.autoClaude.description")} (
												{t("settings:mcp.alwaysEnabled")})
											</p>
										</div>
									</div>
									<Switch
										aria-label={t("settings:mcp.servers.autoClaude.name")}
										checked={true}
										disabled
									/>
								</div>

								{/* rtk — la condensation de sortie, toujours visible : on la découvre ici. */}
								<TokenSavingsSettings
									tokenSavings={envConfig?.tokenSavings}
									projectPath={selectedProject?.path}
									onUpdate={updateTokenSavings}
								/>

								{/* ui-ux-pro-max — le design system des tâches d'interface, toujours visible. */}
								<UiUxSettings uiux={envConfig?.uiux} onUpdate={updateUiux} />

								{/* Custom MCP Servers Section */}
								<div className="pt-4 border-t border-border">
									<div className="flex items-center justify-between mb-3">
										<div className="flex items-center gap-2">
											<Terminal className="h-3 w-3 text-muted-foreground" />
											<span className="text-xs text-muted-foreground uppercase tracking-wider">
												{t("settings:mcp.customServers")}
											</span>
										</div>
										<button
											type="button"
											onClick={() => {
												setEditingCustomServer(null);
												setShowCustomMcpDialog(true);
											}}
											className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
										>
											<Plus className="h-3 w-3" />
											{t("settings:mcp.addCustomServer")}
										</button>
									</div>

									{policyRefusal && (
										<McpPolicyRefusalNotice refusal={policyRefusal} className="mb-3" />
									)}

									{customServers.length > 0 ? (
										<div className="space-y-2">
											{customServers.map((server) => {
												const health = serverHealthStatus[server.id];
												const isTesting = testingServers.has(server.id);

												return (
													<div
														key={server.id}
														className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-lg group"
													>
														<div className="flex items-center gap-3">
															{/* Status indicator */}
															<StatusIndicator
																isTesting={isTesting}
																health={health}
															/>
															{server.type === "command" ? (
																<Terminal className="h-4 w-4 text-muted-foreground" />
															) : (
																<Globe className="h-4 w-4 text-muted-foreground" />
															)}
															<div className="flex-1 min-w-0">
																<div className="flex items-center gap-2">
																	<span className="text-sm font-medium">
																		{server.name}
																	</span>
																	{health?.responseTime && (
																		<span className="text-3xs text-muted-foreground">
																			{health.responseTime}ms
																		</span>
																	)}
																</div>
																<p className="text-xs text-muted-foreground truncate">
																	{health?.message ||
																		(server.type === "command"
																			? `${server.command} ${server.args?.join(" ") || ""}`
																			: server.url)}
																</p>
															</div>
														</div>
														<div className="flex items-center gap-1">
															{/* Test button - always visible */}
															<Button
																variant="ghost"
																size="sm"
																onClick={() => handleTestConnection(server)}
																disabled={isTesting}
																className="h-7 px-2 text-xs"
																title={t("dialogs:githubSetup.testConnection")}
															>
																{isTesting ? (
																	<Loader2 className="h-3 w-3 animate-spin" />
																) : (
																	<RefreshCw className="h-3 w-3" />
																)}
																<span className="ml-1">{t("common:buttons.test")}</span>
															</Button>
															{/* Edit/Delete - show on hover */}
															<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
																<button
																	type="button"
																	onClick={() => {
																		setEditingCustomServer(server);
																		setShowCustomMcpDialog(true);
																	}}
																	className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
																	title={t("settings:agentToolsPanel.edit")}
																>
																	<Pencil className="h-3.5 w-3.5" />
																</button>
																<button
																	type="button"
																	onClick={() =>
																		handleDeleteCustomServer(server.id)
																	}
																	className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
																	title={t("common:buttons.delete")}
																>
																	<Trash2 className="h-3.5 w-3.5" />
																</button>
															</div>
														</div>
													</div>
												);
											})}
										</div>
									) : (
										<p className="text-sm text-muted-foreground text-center py-3">
											{t("settings:mcp.noCustomServers")}
										</p>
									)}
								</div>
								<McpPinsSection projectPath={selectedProject?.path} />
							</div>
						</div>
					)}

					{/* Agent Categories */}
					{Object.entries(CATEGORIES).map(([categoryId, category]) => {
						// Every category has agents.
						const agents = agentsByCategory[categoryId];

						const isExpanded = expandedCategories.has(categoryId);
						const CategoryIcon = category.icon;

						return (
							<div key={categoryId} className="space-y-3">
								{/* Category Header */}
								<button
									type="button"
									onClick={() => toggleCategory(categoryId)}
									className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
								>
									{isExpanded ? (
										<ChevronDown className="h-4 w-4 text-muted-foreground" />
									) : (
										<ChevronRight className="h-4 w-4 text-muted-foreground" />
									)}
									<CategoryIcon className="h-4 w-4 text-muted-foreground" />
									<h2 className="text-sm font-semibold text-foreground">
										{t(`agents.categories.${categoryId}`)}
									</h2>
									<span className="text-xs text-muted-foreground">
										{t("agents.agentsCount", { count: agents.length })}
									</span>
								</button>

								{/* Agent Cards */}
								{isExpanded && (
									<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pl-6">
										{agents.map(({ id, config }) => {
											const { model, thinking } = getAgentModelConfig(config);
											return (
												<AgentCard
													key={id}
													id={id}
													config={config}
													modelLabel={getModelLabel(model)}
													thinkingLabel={getThinkingLabel(thinking)}
													overrides={agentOverrides[id]}
													mcpServerStates={envConfig?.mcpServers}
													linearEnabled={envConfig?.linearEnabled === true}
													customServers={customServers}
													onAddMcp={handleAddMcp}
													onRemoveMcp={handleRemoveMcp}
													onConfigureMcp={handleConfigureMcp}
												/>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
			</Page>

			{/* Custom MCP Server Dialog */}
			<McpServerSettingsDialog
				open={configuringServerId !== null}
				onOpenChange={(next) => {
					if (!next) setConfiguringServerId(null);
				}}
				serverId={configuringServerId}
				serverName={
					configuringServer
						? t(`settings:mcp.servers.${configuringServer.i18nKey}.name`)
						: configuringServerId || ""
				}
				serverDescription={
					configuringServer &&
					t(`settings:mcp.servers.${configuringServer.i18nKey}.description`)
				}
				icon={configuringServer?.icon}
				mcpServers={mcpServers}
				envConfig={envConfig}
				onUpdate={updateMcpServer}
			/>

			<CustomMcpDialog
				open={showCustomMcpDialog}
				onOpenChange={setShowCustomMcpDialog}
				server={editingCustomServer}
				existingIds={[...RESERVED_MCP_IDS, ...customServers.map((s) => s.id)]}
				onSave={handleSaveCustomServer}
			/>
		</ModuleStage>
	);
}
