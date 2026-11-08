import type { BrowserAgentTab } from "@shared/types/browser-agent";
import { AlertTriangle, FlaskConical, Globe, MonitorX, ScanEye } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";
import { useProjectStore } from "@/stores/project-store";
import {
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	ScanLine,
	Stat,
	Stats,
	Tabs,
} from "../charter";
import { BrowserTab } from "./BrowserTab";
import { TestRunnerTab } from "./TestRunnerTab";
import { VisualRegressionTab } from "./VisualRegressionTab";

/** A Chromium for the project: browse and capture, compare screens, run E2E tests. */
export function BrowserAgentDashboard() {
	const { t } = useTranslation(["browserAgent", "navigation"]);
	const { activeTab, setActiveTab, stats, isLoading, error, fetchDashboard } = useBrowserAgentStore();
	const selectedProject = useProjectStore((s) => s.getSelectedProject?.());
	const projectPath = selectedProject?.path || "";

	useEffect(() => {
		if (projectPath) {
			fetchDashboard(projectPath);
		}
	}, [projectPath, fetchDashboard]);

	const header = (
		<ModuleHeader
			kicker={t("navigation:groups.toolbox")}
			title={t("browserAgent:title")}
			description={t("browserAgent:subtitle")}
			icon={Globe}
			tone="blue"
		/>
	);

	if (!projectPath) {
		return (
			<ModuleStage data-testid="browser-agent-view">
				{header}
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={MonitorX} tone="blue" title={t("browserAgent:title")}>
						{t("browserAgent:errors.noProject")}
					</EmptyStage>
				</div>
			</ModuleStage>
		);
	}

	return (
		<ModuleStage scroll="page" data-testid="browser-agent-view">
			{header}
			<Page className="max-w-none space-y-4">
				<Stats>
					<Stat label={t("browserAgent:stats.totalTests")} value={stats.totalTests} tone="blue" />
					<Stat
						label={t("browserAgent:stats.passRate")}
						value={`${stats.passRate.toFixed(0)}%`}
						tone={stats.totalTests === 0 ? "muted" : stats.passRate >= 80 ? "green" : "amber"}
					/>
					<Stat label={t("browserAgent:stats.screenshots")} value={stats.screenshotsCaptured} tone="violet" />
					<Stat
						label={t("browserAgent:stats.regressions")}
						value={stats.regressionsDetected}
						tone={stats.regressionsDetected > 0 ? "orange" : "muted"}
					/>
				</Stats>

				<Tabs<BrowserAgentTab>
					label={t("browserAgent:title")}
					value={activeTab}
					onChange={setActiveTab}
					tabs={[
						{ id: "browser", label: t("browserAgent:tabs.browser"), icon: Globe },
						{ id: "visual-regression", label: t("browserAgent:tabs.visualRegression"), icon: ScanEye },
						{ id: "test-runner", label: t("browserAgent:tabs.testRunner"), icon: FlaskConical },
					]}
				/>

				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				)}

				{isLoading ? (
					<ScanLine label={t("browserAgent:browser.launching")} />
				) : (
					<div className="relative z-[1]">
						{activeTab === "browser" && <BrowserTab projectPath={projectPath} />}
						{activeTab === "visual-regression" && <VisualRegressionTab projectPath={projectPath} />}
						{activeTab === "test-runner" && <TestRunnerTab projectPath={projectPath} />}
					</div>
				)}
			</Page>
		</ModuleStage>
	);
}
