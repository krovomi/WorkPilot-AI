import { Map as MapIcon, Plus, RefreshCw, TrendingUp, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getFeatureStats } from "../../stores/roadmap-store";
import { CharterButton, Chip, ModuleHeader } from "../charter";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ROADMAP_PRIORITY_TONES } from "./tones";
import type { RoadmapHeaderProps } from "./types";

/** The module band of the roadmap: vision, actions, then audience and counts. */
export function RoadmapHeader({
	roadmap,
	competitorAnalysis,
	onAddFeature,
	onRefresh,
	onViewCompetitorAnalysis,
}: Readonly<RoadmapHeaderProps>) {
	const { t } = useTranslation(["roadmap", "common", "navigation"]);
	const stats = getFeatureStats(roadmap);
	const secondary = roadmap.targetAudience?.secondary ?? [];

	return (
		<>
			<ModuleHeader
				kicker={t("navigation:groups.planning")}
				title={roadmap.projectName}
				description={roadmap.vision}
				icon={MapIcon}
				tone="accent"
				actions={
					<>
						{competitorAnalysis && (
							<CharterButton
								variant="ghost"
								icon={TrendingUp}
								onClick={onViewCompetitorAnalysis}
								title={t("roadmap:header.analyzedCompetitors", {
									count: competitorAnalysis.competitors.length,
									painPoints: competitorAnalysis.competitors.reduce(
										(sum, c) => sum + c.painPoints.length,
										0,
									),
								})}
							>
								{t("roadmap:header.competitorAnalysis")}
							</CharterButton>
						)}
						<CharterButton icon={Plus} onClick={onAddFeature} title={t("roadmap:header.addNewFeature")}>
							{t("roadmap:header.addFeature")}
						</CharterButton>
						<CharterButton
							variant="ghost"
							icon={RefreshCw}
							onClick={onRefresh}
							aria-label={t("common:accessibility.regenerateRoadmapAriaLabel")}
							title={t("roadmap:header.regenerateRoadmap")}
						/>
					</>
				}
			/>
			<div className="wp-chips relative z-[2] px-5 pb-3">
				<Chip tone="green">{roadmap.status}</Chip>
				{roadmap.targetAudience?.primary && (
					<Chip tone="muted" dot={false}>
						<Users className="h-3 w-3" aria-hidden="true" />
						{t("roadmap:header.target")} : {roadmap.targetAudience.primary}
					</Chip>
				)}
				{secondary.length > 0 && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span>
								<Chip tone="muted" dot={false}>
									{t("roadmap:header.morePersonas", { count: secondary.length })}
								</Chip>
							</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-md">
							<div className="mb-1 font-semibold">{t("roadmap:header.secondaryPersonas")}</div>
							{secondary.map((persona) => (
								<div key={persona} className="text-sm">
									• {persona}
								</div>
							))}
						</TooltipContent>
					</Tooltip>
				)}
				<Chip tone="muted" dot={false}>
					{stats.total} {t("roadmap:header.features")}
				</Chip>
				<Chip tone="muted" dot={false}>
					{roadmap.phases.length} {t("roadmap:header.phases")}
				</Chip>
				{Object.entries(stats.byPriority).map(([priority, count]) => (
					<Chip key={priority} tone={ROADMAP_PRIORITY_TONES[priority] ?? "muted"}>
						{count} {t(`roadmap:priorities.${priority}`, { defaultValue: priority })}
					</Chip>
				))}
			</div>
		</>
	);
}
