/**
 * MCP Server Card
 *
 * Displays a single MCP server in the marketplace catalog grid.
 * Shows name, description, launcher, and install/uninstall actions.
 * Installing adds the server to the selected project and to the agents
 * picked in the dialog (see `stores/mcp-marketplace-store.ts`).
 */

import {
	BadgeCheck,
	ChevronDown,
	ChevronUp,
	Download,
	ExternalLink,
	Eye,
	EyeOff,
	Globe,
	Info,
	Loader2,
	Terminal,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_MCP_AGENTS,
	localized,
	missingCatalogVars,
} from "../../../shared/mcp-catalog/install";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import {
	installMarketplaceServer,
	uninstallMarketplaceServer,
	useMcpMarketplaceStore,
} from "../../stores/mcp-marketplace-store";
import { useProjectStore } from "../../stores/project-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface McpServerCardProps {
	readonly server: McpMarketplaceServer;
}

export function McpServerCard({ server }: McpServerCardProps) {
	const { t, i18n } = useTranslation(["common"]);
	const { isServerInstalled, isInstalling } = useMcpMarketplaceStore();
	const projectId = useProjectStore((state) => state.selectedProjectId);
	const projectName = useProjectStore(
		(state) => state.projects.find((p) => p.id === state.selectedProjectId)?.name,
	);

	const installed = isServerInstalled(server.id);
	const installing = isInstalling === server.id;
	const language = i18n.language;

	const [showInstallDialog, setShowInstallDialog] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
	const [agents, setAgents] = useState<string[]>([...DEFAULT_MCP_AGENTS]);

	const requiredVars = server.vars.filter((v) => v.required);
	const optionalVars = server.vars.filter((v) => !v.required);

	const handleInstallClick = () => {
		setValues({});
		setAgents([...DEFAULT_MCP_AGENTS]);
		setShowInstallDialog(true);
	};

	const handleConfirmInstall = async () => {
		if (!projectId) return;
		const success = await installMarketplaceServer(
			projectId,
			server.id,
			values,
			agents,
			language,
		);
		if (success) {
			setShowInstallDialog(false);
		}
	};

	const handleUninstall = () => {
		if (projectId) uninstallMarketplaceServer(projectId, server.id);
	};

	const toggleAgent = (agent: string, checked: boolean) => {
		setAgents((prev) =>
			checked ? [...prev, agent] : prev.filter((a) => a !== agent),
		);
	};

	const canInstall =
		Boolean(projectId) &&
		agents.length > 0 &&
		missingCatalogVars(server, values).length === 0;

	const renderVar = (envVar: McpMarketplaceServer["vars"][number]) => (
		<div key={envVar.name} className="space-y-1.5">
			<Label className="text-sm flex items-center gap-1">
				{envVar.label}
				{envVar.required && <span className="text-destructive">*</span>}
			</Label>
			<p className="text-xs text-muted-foreground">
				{localized(envVar.description, language)}
			</p>
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Input
						type={
							envVar.secret && !showSecrets[envVar.name] ? "password" : "text"
						}
						placeholder={envVar.placeholder}
						value={values[envVar.name] || ""}
						onChange={(e) =>
							setValues((prev) => ({
								...prev,
								[envVar.name]: e.target.value,
							}))
						}
						className="h-9 pr-9"
					/>
					{envVar.secret && (
						<button
							type="button"
							onClick={() =>
								setShowSecrets((prev) => ({
									...prev,
									[envVar.name]: !prev[envVar.name],
								}))
							}
							className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						>
							{showSecrets[envVar.name] ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</button>
					)}
				</div>
				{envVar.helpUrl && (
					<Button
						variant="outline"
						size="icon"
						className="h-9 w-9 shrink-0"
						asChild
					>
						<a href={envVar.helpUrl} target="_blank" rel="noopener noreferrer">
							<ExternalLink className="h-4 w-4" />
						</a>
					</Button>
				)}
			</div>
		</div>
	);

	return (
		<>
			<div className="wp-card group relative flex flex-col overflow-hidden transition-colors hover:border-[var(--wp-accent)]">
				{/* Card header with color accent */}
				<div
					className="h-1.5 w-full"
					style={{ backgroundColor: server.color }}
				/>

				<div className="flex flex-col flex-1 p-4">
					{/* Top row: icon + name + badges */}
					<div className="flex items-start gap-3 mb-3">
						<div
							className="shrink-0 flex items-center justify-center w-10 h-10 rounded-lg text-white text-sm font-bold"
							style={{ backgroundColor: server.color }}
						>
							{server.name.charAt(0)}
						</div>
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-1.5">
								<h3 className="font-semibold text-sm truncate">
									{server.name}
								</h3>
								{server.official && (
									<BadgeCheck className="h-4 w-4 text-blue-500 shrink-0" />
								)}
							</div>
							<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
								{localized(server.tagline, language)}
							</p>
						</div>
					</div>

					{/* Launcher row */}
					<div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
						<span className="flex items-center gap-1">
							{server.transport === "stdio" ? (
								<Terminal className="h-3 w-3" />
							) : (
								<Globe className="h-3 w-3" />
							)}
							{server.transport === "stdio" ? server.command : server.transport}
						</span>
						<Badge
							variant={server.official ? "secondary" : "outline"}
							className="text-3xs px-1.5 py-0"
						>
							{server.official
								? t("mcpMarketplace.official")
								: t("mcpMarketplace.community")}
						</Badge>
						<span className="ml-auto text-3xs opacity-60 truncate max-w-[45%]">
							{server.package}
						</span>
					</div>

					{/* Tools preview */}
					<div className="flex flex-wrap gap-1 mb-3">
						{server.tools.slice(0, 3).map((tool) => (
							<Badge
								key={tool.name}
								variant="secondary"
								className="text-3xs px-1.5 py-0"
							>
								{tool.name}
							</Badge>
						))}
						{server.tools.length > 3 && (
							<Badge variant="outline" className="text-3xs px-1.5 py-0">
								+{server.tools.length - 3}
							</Badge>
						)}
					</div>

					{/* Expandable details */}
					<button
						type="button"
						onClick={() => setShowDetails(!showDetails)}
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
					>
						{showDetails ? (
							<ChevronUp className="h-3 w-3" />
						) : (
							<ChevronDown className="h-3 w-3" />
						)}
						{showDetails
							? t("mcpMarketplace.hideDetails")
							: t("mcpMarketplace.showDetails")}
					</button>

					{showDetails && (
						<div className="text-xs text-muted-foreground mb-3 space-y-2">
							<p>{localized(server.description, language)}</p>
							{server.requires && (
								<p className="flex items-center gap-1 text-warning ">
									<Info className="h-3 w-3 shrink-0" />
									{t(`mcpMarketplace.requires.${server.requires}`)}
								</p>
							)}
							<div className="flex flex-wrap gap-1">
								{server.tags.map((tag) => (
									<span
										key={tag}
										className="text-3xs bg-muted px-1.5 py-0.5 rounded"
									>
										{tag}
									</span>
								))}
							</div>
							{requiredVars.length > 0 && (
								<div>
									<span className="font-medium text-foreground">
										{t("mcpMarketplace.requiredConfig")}:
									</span>
									<ul className="list-disc list-inside mt-1">
										{requiredVars.map((v) => (
											<li key={v.name}>{v.label}</li>
										))}
									</ul>
								</div>
							)}
							<div className="flex gap-2">
								{server.homepage && (
									<a
										href={server.homepage}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center gap-1 text-primary hover:underline"
									>
										<ExternalLink className="h-3 w-3" />
										{t("mcpMarketplace.homepage")}
									</a>
								)}
							</div>
						</div>
					)}

					{/* Action buttons */}
					<div className="mt-auto pt-2">
						{installed ? (
							<div className="flex gap-2">
								<Badge variant="default" className="flex-1 justify-center py-1">
									{t("mcpMarketplace.installedBadge")}
								</Badge>
								<Button
									variant="ghost"
									size="icon"
									className="h-7 w-7 text-destructive hover:text-destructive"
									onClick={handleUninstall}
									title={t("mcpMarketplace.uninstall")}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</div>
						) : (
							<Button
								className="w-full h-8 text-xs"
								onClick={handleInstallClick}
								disabled={installing || !projectId}
								title={projectId ? undefined : t("mcpMarketplace.noProject")}
							>
								{installing ? (
									<>
										<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
										{t("mcpMarketplace.installing")}
									</>
								) : (
									<>
										<Download className="h-3.5 w-3.5 mr-1.5" />
										{t("mcpMarketplace.install")}
									</>
								)}
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Install Configuration Dialog */}
			<Dialog open={showInstallDialog} onOpenChange={setShowInstallDialog}>
				<DialogContent className="sm:max-w-[500px]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<div
								className="flex items-center justify-center w-8 h-8 rounded-lg text-white text-sm font-bold"
								style={{ backgroundColor: server.color }}
							>
								{server.name.charAt(0)}
							</div>
							{t("mcpMarketplace.installDialog.title", { name: server.name })}
						</DialogTitle>
						<DialogDescription>
							{t("mcpMarketplace.installDialog.description", {
								project: projectName ?? "",
							})}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
						{server.requires && (
							<p className="flex items-center gap-1.5 text-xs text-warning ">
								<Info className="h-3.5 w-3.5 shrink-0" />
								{t(`mcpMarketplace.requires.${server.requires}`)}
							</p>
						)}

						{requiredVars.map(renderVar)}

						{optionalVars.length > 0 && (
							<>
								<div className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2">
									{t("mcpMarketplace.installDialog.optional")}
								</div>
								{optionalVars.map(renderVar)}
							</>
						)}

						<div className="space-y-2 pt-2">
							<Label className="text-sm">
								{t("mcpMarketplace.installDialog.agents")}
							</Label>
							<div className="flex flex-wrap gap-4">
								{DEFAULT_MCP_AGENTS.map((agent) => (
									<div key={agent} className="flex items-center gap-2">
										<Checkbox
											id={`mcp-agent-${server.id}-${agent}`}
											checked={agents.includes(agent)}
											onCheckedChange={(checked) =>
												toggleAgent(agent, checked === true)
											}
										/>
										<Label
											htmlFor={`mcp-agent-${server.id}-${agent}`}
											className="text-sm font-normal cursor-pointer"
										>
											{t(`mcpMarketplace.agents.${agent}`)}
										</Label>
									</div>
								))}
							</div>
							<p className="text-xs text-muted-foreground">
								{agents.length === 0
									? t("mcpMarketplace.installDialog.noAgent")
									: t("mcpMarketplace.installDialog.agentsHint")}
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setShowInstallDialog(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							onClick={handleConfirmInstall}
							disabled={!canInstall || installing}
						>
							{installing ? (
								<>
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
									{t("mcpMarketplace.installing")}
								</>
							) : (
								<>
									<Download className="h-4 w-4 mr-2" />
									{t("mcpMarketplace.install")}
								</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
