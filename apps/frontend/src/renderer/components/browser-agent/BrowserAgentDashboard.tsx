import type { BrowserAgentTab } from "@shared/types/browser-agent";
import {
	AlertTriangle,
	BarChart3,
	Camera,
	FlaskConical,
	Globe,
	MonitorX,
	ScanEye,
	TestTube2,
} from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";
import { useProjectStore } from "@/stores/project-store";
import { BrowserTab } from "./BrowserTab";
import { TestRunnerTab } from "./TestRunnerTab";
import { VisualRegressionTab } from "./VisualRegressionTab";
import { PageHeader } from "../ui/page-header";

const TABS: Array<{
	id: BrowserAgentTab;
	icon: typeof Globe;
	labelKey: string;
	color: string;
	activeColor: string;
}> = [
	{
		id: "browser",
		icon: Globe,
		labelKey: "browserAgent:tabs.browser",
		color: "text-blue-400",
		activeColor: "border-blue-400 text-blue-400",
	},
	{
		id: "visual-regression",
		icon: ScanEye,
		labelKey: "browserAgent:tabs.visualRegression",
		color: "text-purple-400",
		activeColor: "border-purple-400 text-purple-400",
	},
	{
		id: "test-runner",
		icon: FlaskConical,
		labelKey: "browserAgent:tabs.testRunner",
		color: "text-success",
		activeColor: "border-success text-success",
	},
];

export function BrowserAgentDashboard() {
	const { t } = useTranslation(["browserAgent", "common"]);
	const { activeTab, setActiveTab, stats, isLoading, error, fetchDashboard } =
		useBrowserAgentStore();
	const selectedProject = useProjectStore((s) => s.getSelectedProject?.());
	const projectPath = selectedProject?.path || "";

	useEffect(() => {
		if (projectPath) {
			fetchDashboard(projectPath);
		}
	}, [projectPath, fetchDashboard]);

	if (!projectPath) {
		return (
			<div className="h-full flex flex-col items-center justify-center gap-3">
				<div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
					<MonitorX className="w-7 h-7 text-blue-400 opacity-60" />
				</div>
				<p className="text-sm text-muted-foreground">
					{t("browserAgent:errors.noProject")}
				</p>
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<PageHeader
				icon={Globe}
				title={t("browserAgent:title")}
				description={t("browserAgent:subtitle")}
			>
				<div className="grid grid-cols-4 gap-3">
					<StatCard
						icon={TestTube2}
						label={t("browserAgent:stats.totalTests")}
						value={stats.totalTests}
						color="blue"
					/>
					<StatCard
						icon={BarChart3}
						label={t("browserAgent:stats.passRate")}
						value={`${stats.passRate.toFixed(0)}%`}
						color={
							stats.passRate >= 80
								? "emerald"
								: stats.passRate > 0
									? "amber"
									: "emerald"
						}
					/>
					<StatCard
						icon={Camera}
						label={t("browserAgent:stats.screenshots")}
						value={stats.screenshotsCaptured}
						color="purple"
					/>
					<StatCard
						icon={AlertTriangle}
						label={t("browserAgent:stats.regressions")}
						value={stats.regressionsDetected}
						color={stats.regressionsDetected > 0 ? "orange" : "orange"}
					/>
				</div>
			</PageHeader>

			{/* Tab bar */}
			<div className="flex border-b border-border bg-background px-6">
				{TABS.map((tab) => {
					const Icon = tab.icon;
					const isActive = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors ${
								isActive
									? tab.activeColor
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
						>
							<Icon className={`w-4 h-4 ${isActive ? "" : ""}`} />
							<span>{t(tab.labelKey)}</span>
						</button>
					);
				})}
			</div>

			{/* Error banner */}
			{error && (
				<div className="px-6 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-2">
					<AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
					<p className="text-xs text-destructive">{error}</p>
				</div>
			)}

			{/* Tab content */}
			<div className="flex-1 overflow-y-auto px-6 py-4">
				{isLoading ? (
					<div className="flex flex-col items-center justify-center h-48 gap-3">
						<div className="w-7 h-7 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
						<p className="text-xs text-muted-foreground">
							{t("browserAgent:browser.launching")}
						</p>
					</div>
				) : (
					<>
						{activeTab === "browser" && (
							<BrowserTab projectPath={projectPath} />
						)}
						{activeTab === "visual-regression" && (
							<VisualRegressionTab projectPath={projectPath} />
						)}
						{activeTab === "test-runner" && (
							<TestRunnerTab projectPath={projectPath} />
						)}
					</>
				)}
			</div>
		</div>
	);
}

// ── StatCard component ──────────────────────────────────────

type StatColor = "blue" | "emerald" | "purple" | "orange" | "amber";

const STAT_COLORS: Record<
	StatColor,
	{ icon: string; value: string; bg: string; border: string }
> = {
	blue: {
		icon: "text-blue-400",
		value: "text-blue-400",
		bg: "bg-blue-500/10",
		border: "border-blue-500/20",
	},
	emerald: {
		icon: "text-success",
		value: "text-success",
		bg: "bg-success/10",
		border: "border-success/20",
	},
	purple: {
		icon: "text-purple-400",
		value: "text-purple-400",
		bg: "bg-purple-500/10",
		border: "border-purple-500/20",
	},
	orange: {
		icon: "text-orange-400",
		value: "text-orange-400",
		bg: "bg-orange-500/10",
		border: "border-orange-500/20",
	},
	amber: {
		icon: "text-warning",
		value: "text-warning",
		bg: "bg-warning/10",
		border: "border-warning/20",
	},
};

function StatCard({
	icon: Icon,
	label,
	value,
	color,
}: {
	readonly icon: typeof Globe;
	readonly label: string;
	readonly value: string | number;
	readonly color: StatColor;
}) {
	const colors = STAT_COLORS[color];

	return (
		<div
			className={`px-3 py-2.5 rounded-lg ${colors.bg} border ${colors.border} flex items-center gap-3`}
		>
			<Icon className={`w-4.5 h-4.5 ${colors.icon} shrink-0`} />
			<div className="min-w-0">
				<p className="text-[11px] text-muted-foreground truncate">
					{label}
				</p>
				<p className={`text-lg font-semibold ${colors.value} leading-tight`}>
					{value}
				</p>
			</div>
		</div>
	);
}
