/**
 * Self-healing, in the UI charter (docs/architecture/ui-charter.md): the
 * header and its counters, one tab per incident source, the tab's content
 * below.
 */
import type { IncidentMode } from "@shared/types/self-healing";
import { Factory, GitBranch, HeartPulse, type LucideIcon, Telescope } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/project-store";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { ModuleHeader, ModuleStage, Notice, ScanLine, Stat, Stats, Tabs } from "../charter";
import { CICDTab } from "./CICDTab";
import { ProactiveTab } from "./ProactiveTab";
import { ProductionTab } from "./ProductionTab";

const TABS: ReadonlyArray<{ id: IncidentMode; icon: LucideIcon; labelKey: string }> = [
	{ id: "cicd", icon: GitBranch, labelKey: "selfHealing:tabCICD" },
	{ id: "production", icon: Factory, labelKey: "selfHealing:tabProduction" },
	{ id: "proactive", icon: Telescope, labelKey: "selfHealing:tabProactive" },
];

export function SelfHealingDashboard() {
	const { t } = useTranslation(["selfHealing", "common", "navigation"]);
	const { activeTab, setActiveTab, stats, isLoading, error, fetchDashboard } = useSelfHealingStore();
	const selectedProject = useProjectStore((s) => s.getSelectedProject?.());
	const projectPath = selectedProject?.path || "";

	useEffect(() => {
		if (projectPath) {
			fetchDashboard(projectPath);
		}
	}, [projectPath, fetchDashboard]);

	return (
		<ModuleStage scroll="page" data-testid="self-healing-view">
			<ModuleHeader
				kicker={t("navigation:groups.agents")}
				icon={HeartPulse}
				title={t("selfHealing:title")}
				description={t("selfHealing:subtitle")}
				tone="green"
			/>
			<div className="relative z-[2] px-5 pb-3">
				<Stats>
					<Stat label={t("selfHealing:totalIncidents")} value={stats.totalIncidents} />
					<Stat label={t("selfHealing:resolved")} value={stats.resolvedIncidents} tone="green" />
					<Stat
						label={t("selfHealing:active")}
						value={stats.activeIncidents}
						tone={stats.activeIncidents > 0 ? "amber" : "muted"}
					/>
					<Stat label={t("selfHealing:avgResolution")} value={`${stats.avgResolutionTime}s`} tone="blue" />
					<Stat label={t("selfHealing:autoFixRate")} value={`${stats.autoFixRate}%`} tone="green" />
				</Stats>
			</div>
			<Tabs
				label={t("selfHealing:title")}
				value={activeTab}
				onChange={setActiveTab}
				tabs={TABS.map((tab) => ({ id: tab.id, icon: tab.icon, label: t(tab.labelKey) }))}
			/>
			{error && (
				<Notice tone="red" role="alert" className="relative z-[2] mx-5 mb-3">
					{error}
				</Notice>
			)}
			<div className="relative z-[1] px-5 pb-8">
				{isLoading ? (
					<ScanLine />
				) : (
					<>
						{activeTab === "cicd" && <CICDTab projectPath={projectPath} />}
						{activeTab === "production" && <ProductionTab projectPath={projectPath} />}
						{activeTab === "proactive" && <ProactiveTab projectPath={projectPath} />}
					</>
				)}
			</div>
		</ModuleStage>
	);
}
