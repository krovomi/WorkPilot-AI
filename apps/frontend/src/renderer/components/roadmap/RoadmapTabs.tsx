import { Columns3, Flag, ListChecks, Milestone, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RoadmapFeature, RoadmapPhase } from "../../../shared/types";
import { getFeaturesByPhase } from "../../stores/roadmap-store";
import { Chip, Panel, Tabs } from "../charter";
import { RoadmapKanbanView } from "../RoadmapKanbanView";
import { FeatureCard } from "./FeatureCard";
import { PhaseCard } from "./PhaseCard";
import { ROADMAP_PRIORITIES, ROADMAP_PRIORITY_TONES } from "./tones";
import type { RoadmapTabsProps } from "./types";
import { hasCompetitorInsight } from "./utils";

type RoadmapTab = "kanban" | "phases" | "features" | "priorities";

/** The four views of a roadmap, switched by the charter's pill tabs. */
export function RoadmapTabs({
	roadmap,
	activeTab,
	onTabChange,
	onFeatureSelect,
	onConvertToSpec,
	onGoToTask,
	onSave,
}: Readonly<RoadmapTabsProps>) {
	const { t } = useTranslation("roadmap");
	const tab = activeTab as RoadmapTab;
	const tabs = [
		{ id: "kanban", label: t("tabs.kanban"), icon: Columns3 },
		{ id: "phases", label: t("phases.title"), icon: Milestone, count: roadmap.phases.length },
		{ id: "features", label: t("tabs.allFeatures"), icon: ListChecks, count: roadmap.features.length },
		{ id: "priorities", label: t("tabs.byPriority"), icon: Flag },
	] as const;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Tabs
				tabs={tabs}
				value={tab}
				onChange={(id) => onTabChange(id)}
				label={t("tabs.label")}
				className="relative z-[1] shrink-0 px-5 pb-3"
			/>

			{tab === "kanban" && (
				<div className="relative z-[1] min-h-0 flex-1 overflow-hidden">
					<RoadmapKanbanView
						key={roadmap.updatedAt?.toString()}
						roadmap={roadmap}
						onFeatureClick={onFeatureSelect}
						onConvertToSpec={onConvertToSpec}
						onGoToTask={onGoToTask}
						onSave={onSave}
					/>
				</div>
			)}

			{tab === "phases" && (
				<div className="relative z-[1] min-h-0 flex-1 space-y-4 overflow-auto px-5 pb-4">
					{roadmap.phases.map((phase: RoadmapPhase, index: number) => (
						<PhaseCard
							key={phase.id}
							phase={phase}
							features={getFeaturesByPhase(roadmap, phase.id)}
							isFirst={index === 0}
							onFeatureSelect={onFeatureSelect}
							onConvertToSpec={onConvertToSpec}
							onGoToTask={onGoToTask}
						/>
					))}
				</div>
			)}

			{tab === "features" && (
				<div className="relative z-[1] grid min-h-0 flex-1 content-start gap-3 overflow-auto px-5 pb-4">
					{roadmap.features.map((feature: RoadmapFeature) => (
						<FeatureCard
							key={feature.id}
							feature={feature}
							onClick={() => onFeatureSelect(feature)}
							onConvertToSpec={onConvertToSpec}
							onGoToTask={onGoToTask}
							hasCompetitorInsight={hasCompetitorInsight(feature)}
						/>
					))}
				</div>
			)}

			{tab === "priorities" && (
				<div className="relative z-[1] grid min-h-0 flex-1 content-start gap-4 overflow-auto px-5 pb-4 md:grid-cols-2">
					{ROADMAP_PRIORITIES.map((priority) => {
						const features = roadmap.features.filter((f: RoadmapFeature) => f.priority === priority);
						const tone = ROADMAP_PRIORITY_TONES[priority];
						return (
							<Panel key={priority} rail tone={tone} className="space-y-2">
								<div className="flex items-center gap-2">
									<Chip tone={tone}>{t(`priorityLabels.${priority}`)}</Chip>
									<span className="wp-meta">{t("tabs.featuresCount", { count: features.length })}</span>
								</div>
								{features.map((feature: RoadmapFeature) => (
									<button
										key={feature.id}
										type="button"
										className="wp-card wp-card-pad wp-step block w-full text-left"
										onClick={() => onFeatureSelect(feature)}
									>
										<div className="wp-title text-sm">{feature.title}</div>
										<div className="wp-chips mt-1">
											<Chip tone="muted" dot={false}>
												{feature.complexity}
											</Chip>
											<Chip tone="muted" dot={false}>
												{t("featureCard.impact", { impact: feature.impact })}
											</Chip>
											{hasCompetitorInsight(feature) && (
												<Chip tone="accent" dot={false}>
													<TrendingUp className="h-3 w-3" aria-hidden="true" />
													{t("tabs.insight")}
												</Chip>
											)}
										</div>
									</button>
								))}
							</Panel>
						);
					})}
				</div>
			)}
		</div>
	);
}
