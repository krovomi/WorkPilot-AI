import type { IncidentMode } from "@shared/types/self-healing";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/project-store";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { CICDTab } from "./CICDTab";
import { ProactiveTab } from "./ProactiveTab";
import { ProductionTab } from "./ProductionTab";
import { HeartPulse } from "lucide-react";
import { PageHeader } from "../ui/page-header";

const TABS: Array<{ id: IncidentMode; icon: string; labelKey: string }> = [
	{ id: "cicd", icon: "\uD83D\uDD04", labelKey: "selfHealing:tabCICD" },
	{
		id: "production",
		icon: "\uD83C\uDFED",
		labelKey: "selfHealing:tabProduction",
	},
	{
		id: "proactive",
		icon: "\uD83D\uDD2E",
		labelKey: "selfHealing:tabProactive",
	},
];

export function SelfHealingDashboard() {
	const { t } = useTranslation(["selfHealing", "common"]);
	const { activeTab, setActiveTab, stats, isLoading, error, fetchDashboard } =
		useSelfHealingStore();
	const selectedProject = useProjectStore((s) => s.getSelectedProject?.());
	const projectPath = selectedProject?.path || "";

	useEffect(() => {
		if (projectPath) {
			fetchDashboard(projectPath);
		}
	}, [projectPath, fetchDashboard]);

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<PageHeader
				icon={HeartPulse}
				title={t("selfHealing:title")}
				description={t("selfHealing:subtitle")}
			>
				<div className="grid grid-cols-5 gap-3">
					<StatCard
						label={t("selfHealing:totalIncidents")}
						value={stats.totalIncidents}
					/>
					<StatCard
						label={t("selfHealing:resolved")}
						value={stats.resolvedIncidents}
						variant="success"
					/>
					<StatCard
						label={t("selfHealing:active")}
						value={stats.activeIncidents}
						variant={stats.activeIncidents > 0 ? "warning" : "default"}
					/>
					<StatCard
						label={t("selfHealing:avgResolution")}
						value={`${stats.avgResolutionTime}s`}
					/>
					<StatCard
						label={t("selfHealing:autoFixRate")}
						value={`${stats.autoFixRate}%`}
						variant="success"
					/>
				</div>
			</PageHeader>

			{/* Tab bar */}
			<div className="flex border-b border-border bg-background px-6">
				{TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setActiveTab(tab.id)}
						className={`flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors ${
							activeTab === tab.id
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						<span>{tab.icon}</span>
						<span>{t(tab.labelKey)}</span>
					</button>
				))}
			</div>

			{/* Error banner */}
			{error && (
				<div className="px-6 py-2 bg-destructive/10 border-b border-destructive/20">
					<p className="text-xs text-destructive">{error}</p>
				</div>
			)}

			{/* Tab content */}
			<div className="flex-1 overflow-y-auto px-6 py-4">
				{isLoading ? (
					<div className="flex items-center justify-center h-32">
						<div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
					</div>
				) : (
					<>
						{activeTab === "cicd" && <CICDTab projectPath={projectPath} />}
						{activeTab === "production" && (
							<ProductionTab projectPath={projectPath} />
						)}
						{activeTab === "proactive" && (
							<ProactiveTab projectPath={projectPath} />
						)}
					</>
				)}
			</div>
		</div>
	);
}

// ── Stat Card Component ─────────────────────────────────────

interface StatCardProps {
	readonly label: string;
	readonly value: number | string;
	readonly variant?: "default" | "success" | "warning";
}

function StatCard({ label, value, variant = "default" }: StatCardProps) {
	const valueColors = {
		default: "text-foreground",
		success: "text-success",
		warning: "text-warning",
	};

	return (
		<div className="rounded-lg border border-border bg-card p-2.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-lg font-semibold ${valueColors[variant]}`}>{value}</p>
		</div>
	);
}
