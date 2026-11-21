import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExternalLink, Layers, Play, ThumbsUp, TrendingUp } from "lucide-react";
import {
	ROADMAP_COMPLEXITY_COLORS,
	ROADMAP_IMPACT_COLORS,
	ROADMAP_PRIORITY_COLORS,
} from "../../shared/constants";
import type { Roadmap, RoadmapFeature } from "../../shared/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useTranslation } from "react-i18next";

interface SortableFeatureCardProps {
	readonly feature: RoadmapFeature;
	readonly roadmap: Roadmap;
	readonly onClick: () => void;
	readonly onConvertToSpec?: (feature: RoadmapFeature) => void;
	readonly onGoToTask?: (specId: string) => void;
}

export function SortableFeatureCard({
	feature,
	roadmap,
	onClick,
	onConvertToSpec,
	onGoToTask,
}: SortableFeatureCardProps) {
	const { t } = useTranslation();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: feature.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		// Prevent z-index stacking issues during drag
		zIndex: isDragging ? 50 : undefined,
	};

	const hasCompetitorInsight =
		!!feature.competitorInsightIds && feature.competitorInsightIds.length > 0;

	// Get phase name for the feature
	const phaseName = roadmap.phases.find((p) => p.id === feature.phaseId)?.name;

	// A feature imported from another tool (Canny, GitHub Issues) says from where.
	const provider = feature.source?.provider;
	const providerName =
		provider && provider !== "internal"
			? t(`roadmap:providers.${provider}`, { defaultValue: t("roadmap:featureCard.external") })
			: null;
	const linkedSpecId = feature.linkedSpecId;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"touch-none transition-all duration-200",
				// The column under the card is highlighted while it moves (RoadmapKanbanView).
				isDragging && "dragging-placeholder opacity-40 scale-[0.98]",
			)}
			{...attributes}
			{...listeners}
		>
			<Card
				className="p-3 hover:bg-muted/50 cursor-pointer transition-colors"
				onClick={onClick}
			>
				{/* Header - Title with priority badge and action button */}
				<div className="flex items-start justify-between gap-2">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-1.5 mb-1 flex-wrap">
							<Badge
								variant="outline"
								className={cn(
									"text-3xs px-1.5 py-0",
									ROADMAP_PRIORITY_COLORS[feature.priority],
								)}
							>
								{t(`roadmap:priorityLabels.${feature.priority}`)}
							</Badge>
							{phaseName && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge
											variant="outline"
											className="text-3xs px-1.5 py-0 text-muted-foreground border-muted-foreground/30"
										>
											<Layers className="h-2.5 w-2.5 mr-0.5" />
											<span className="max-w-24 truncate">{phaseName}</span>
										</Badge>
									</TooltipTrigger>
									<TooltipContent>
								{t("roadmap:featureCard.phase", { name: phaseName })}
							</TooltipContent>
								</Tooltip>
							)}
							{hasCompetitorInsight && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge
											variant="outline"
											className="text-3xs px-1.5 py-0 text-primary border-primary/50"
										>
											<TrendingUp className="h-2.5 w-2.5" />
										</Badge>
									</TooltipTrigger>
									<TooltipContent>
										{t("roadmap:featureCard.competitorInsight")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
						<h3 className="font-medium text-sm leading-snug line-clamp-2">
							{feature.title}
						</h3>
					</div>
					<div className="shrink-0">
						{linkedSpecId ? (
							<Button
								variant="outline"
								size="sm"
								className="h-7 px-2"
								onClick={(e) => {
									e.stopPropagation();
									onGoToTask?.(linkedSpecId);
								}}
							>
								<ExternalLink className="h-3 w-3 mr-1" />
								{t("roadmap:featureCard.task")}
							</Button>
						) : (
							feature.status !== "done" &&
							onConvertToSpec && (
								<Button
									variant="outline"
									size="sm"
									className="h-7 px-2"
									onClick={(e) => {
										e.stopPropagation();
										onConvertToSpec(feature);
									}}
								>
									<Play className="h-3 w-3 mr-1" />
									{t("roadmap:featureCard.build")}
								</Button>
							)
						)}
					</div>
				</div>

				{/* Description */}
				<p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
					{feature.description}
				</p>

				{/* Metadata badges - compact row */}
				<div className="mt-2 flex items-center gap-1.5 flex-wrap">
					<Badge
						variant="outline"
						className={cn(
							"text-3xs px-1.5 py-0",
							ROADMAP_COMPLEXITY_COLORS[feature.complexity],
						)}
					>
						{t(`roadmap:levels.complexityBadge.${feature.complexity}`)}
					</Badge>
					<Badge
						variant="outline"
						className={cn(
							"text-3xs px-1.5 py-0",
							ROADMAP_IMPACT_COLORS[feature.impact],
						)}
					>
						{t(`roadmap:levels.impactBadge.${feature.impact}`)}
					</Badge>
					{/* Show vote count if from external source */}
					{feature.votes !== undefined && feature.votes > 0 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="outline"
									className="text-3xs px-1.5 py-0 text-muted-foreground"
								>
									<ThumbsUp className="h-2.5 w-2.5 mr-0.5" />
									{feature.votes}
								</Badge>
							</TooltipTrigger>
							<TooltipContent>
								{t("roadmap:featureCard.votes", { count: feature.votes })}
							</TooltipContent>
						</Tooltip>
					)}
					{/* Show external source indicator */}
					{providerName && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="outline"
									className="text-3xs px-1.5 py-0 text-orange-500 border-orange-500/30"
								>
									{providerName}
								</Badge>
							</TooltipTrigger>
							<TooltipContent>
								{t("roadmap:featureCard.importedFrom", { provider: providerName })}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			</Card>
		</div>
	);
}
