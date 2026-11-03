import type {
	CatalogPluginType,
	MarketplacePlugin,
} from "@shared/types/plugin-marketplace";
import { FileText, Loader2, MessageSquare, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { localized } from "../../../shared/mcp-catalog/install";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const TYPE_ICONS: Record<CatalogPluginType, React.ElementType> = {
	agent: Zap,
	"spec-template": FileText,
	"custom-prompt": MessageSquare,
};

const TYPE_BADGE_CLASSES: Record<CatalogPluginType, string> = {
	agent: "bg-purple-500/10 text-purple-500 border-purple-500/20",
	"spec-template": "bg-green-500/10 text-green-500 border-green-500/20",
	"custom-prompt": "bg-pink-500/10 text-pink-500 border-pink-500/20",
};

interface PluginCardProps {
	plugin: MarketplacePlugin;
	isInstalled: boolean;
	isInstalling: boolean;
	/** A project is selected to install into */
	canInstall: boolean;
	onInstall: () => void;
	onUninstall: () => void;
}

export function PluginCard({
	plugin,
	isInstalled,
	isInstalling,
	canInstall,
	onInstall,
	onUninstall,
}: PluginCardProps) {
	const { t, i18n } = useTranslation(["common"]);
	const [showFullDesc, setShowFullDesc] = useState(false);
	const [showSkill, setShowSkill] = useState(false);
	const IconComponent = TYPE_ICONS[plugin.type];
	const description = localized(plugin.description, i18n.language);

	const typeLabel: Record<CatalogPluginType, string> = {
		agent: t("common:pluginMarketplace.types.agent"),
		"spec-template": t("common:pluginMarketplace.types.specTemplate"),
		"custom-prompt": t("common:pluginMarketplace.types.customPrompt"),
	};

	return (
		<div
			className={cn(
				"group flex flex-col rounded-xl border border-border bg-card p-5 transition-all duration-200",
				"hover:border-primary/30 hover:shadow-md hover:shadow-primary/5",
			)}
		>
			{/* Header */}
			<div className="flex items-start gap-3">
				<div
					className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
					style={{
						backgroundColor: `${plugin.color}20`,
						border: `1px solid ${plugin.color}40`,
					}}
				>
					<IconComponent className="h-5 w-5" style={{ color: plugin.color }} />
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="truncate font-semibold text-sm">{plugin.name}</h3>
					</div>
					<p className="text-xs text-muted-foreground line-clamp-2">
						{localized(plugin.tagline, i18n.language)}
					</p>
				</div>
			</div>

			{/* Type badge + author */}
			<div className="mt-3 flex items-center gap-2">
				<span
					className={cn(
						"inline-flex items-center rounded-full border px-2 py-0.5 text-3xs font-medium",
						TYPE_BADGE_CLASSES[plugin.type],
					)}
				>
					{typeLabel[plugin.type]}
				</span>
				<span className="text-xs text-muted-foreground truncate">
					{t("common:pluginMarketplace.byAuthor", { author: plugin.author })}
				</span>
			</div>

			{/* Description */}
			<p
				className={cn(
					"mt-3 text-xs text-muted-foreground leading-relaxed",
					!showFullDesc && "line-clamp-2",
				)}
			>
				{description}
			</p>
			{description.length > 120 && (
				<button
					type="button"
					onClick={() => setShowFullDesc(!showFullDesc)}
					className="mt-1 text-3xs text-primary hover:underline text-left"
				>
					{showFullDesc
						? t("common:buttons.showLess")
						: t("common:buttons.showMore")}
				</button>
			)}

			{/* The skill it installs */}
			<button
				type="button"
				onClick={() => setShowSkill(!showSkill)}
				className="mt-3 text-3xs text-primary hover:underline text-left"
			>
				{showSkill
					? t("common:pluginMarketplace.hideSkill")
					: t("common:pluginMarketplace.showSkill")}
			</button>
			{showSkill && (
				<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-3xs leading-relaxed whitespace-pre-wrap">
					{plugin.skill.body}
				</pre>
			)}
			{isInstalled && (
				<p className="mt-2 text-3xs text-muted-foreground">
					{t("common:pluginMarketplace.howToUse", { id: plugin.id })}
				</p>
			)}

			{/* Tags */}
			<div className="mt-3 flex flex-wrap gap-1">
				{plugin.tags.slice(0, 3).map((tag) => (
					<Badge
						key={tag}
						variant="secondary"
						className="text-3xs px-1.5 py-0 h-4"
					>
						{tag}
					</Badge>
				))}
				{plugin.tags.length > 3 && (
					<Badge variant="secondary" className="text-3xs px-1.5 py-0 h-4">
						+{plugin.tags.length - 3}
					</Badge>
				)}
			</div>

			{/* Action */}
			<div className="mt-4">
				{isInstalled ? (
					<Button
						variant="outline"
						size="sm"
						className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
						onClick={onUninstall}
					>
						{t("common:pluginMarketplace.actions.uninstall")}
					</Button>
				) : (
					<Button
						size="sm"
						className="w-full"
						onClick={onInstall}
						disabled={isInstalling || !canInstall}
						title={
							canInstall ? undefined : t("common:pluginMarketplace.noProject")
						}
					>
						{isInstalling ? (
							<>
								<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
								{t("common:pluginMarketplace.actions.installing")}
							</>
						) : (
							t("common:pluginMarketplace.actions.install")
						)}
					</Button>
				)}
			</div>
		</div>
	);
}
