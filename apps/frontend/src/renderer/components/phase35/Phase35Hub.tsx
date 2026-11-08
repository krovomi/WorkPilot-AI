/**
 * Tabbed page that aggregates the 12 Phase 3-5 panels.
 *
 * Used as a single entry point in the sidebar so users can discover all
 * the new features without us having to thread 12 separate routes.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { ModuleHeader, ModuleStage, Page, Tabs } from "../charter";
import { AgentHealthPanel } from "./AgentHealthPanel";
import { ArchDriftPanel } from "./ArchDriftPanel";
import { AuditTrailPanel } from "./AuditTrailPanel";
import { CicdAnomalyPanel } from "./CicdAnomalyPanel";
import { CogContextPanel } from "./CogContextPanel";
import { DomainAgentsPanel } from "./DomainAgentsPanel";
import { GenTestsPanel } from "./GenTestsPanel";
import { I18nScalerPanel } from "./I18nScalerPanel";
import { LicensePanel } from "./LicensePanel";
import { LongevityPanel } from "./LongevityPanel";
import { ModelRouterPanel } from "./ModelRouterPanel";
import { PairProgrammingPanel } from "./PairProgrammingPanel";

interface Phase35HubProps {
	projectPath?: string;
}

type TabId =
	| "longevity"
	| "agentHealth"
	| "modelRouter"
	| "domainAgents"
	| "cicdAnomaly"
	| "license"
	| "archDrift"
	| "genTests"
	| "i18nScaler"
	| "cogContext"
	| "audit"
	| "pair";

export function Phase35Hub({ projectPath = "" }: Phase35HubProps) {
	const { t } = useTranslation(["phase35", "navigation"]);
	const [tab, setTab] = useState<TabId>("longevity");

	const tabs: { id: TabId; titleKey: string }[] = [
		{ id: "longevity", titleKey: "longevity.title" },
		{ id: "agentHealth", titleKey: "agentHealth.title" },
		{ id: "modelRouter", titleKey: "modelRouter.title" },
		{ id: "domainAgents", titleKey: "domainAgents.title" },
		{ id: "cicdAnomaly", titleKey: "cicdAnomaly.title" },
		{ id: "license", titleKey: "license.title" },
		{ id: "archDrift", titleKey: "archDrift.title" },
		{ id: "genTests", titleKey: "genTests.title" },
		{ id: "i18nScaler", titleKey: "i18nScaler.title" },
		{ id: "cogContext", titleKey: "cogContext.title" },
		{ id: "audit", titleKey: "audit.title" },
		{ id: "pair", titleKey: "pair.title" },
	];

	return (
		<ModuleStage scroll="page" data-testid="phase35-hub-view">
			<ModuleHeader
				kicker={t("navigation:groups.workspace")}
				title={t("navigation:items.phase35Hub")}
				description={t("phase35:hubDescription")}
				icon={Sparkles}
				tone="violet"
			/>
			<Page className="space-y-4">
				<Tabs
					label={t("navigation:items.phase35Hub")}
					value={tab}
					onChange={setTab}
					className="flex-wrap"
					tabs={tabs.map((item) => ({ id: item.id, label: t(`phase35:${item.titleKey}` as never) }))}
				/>
				{tab === "longevity" && <LongevityPanel projectPath={projectPath} />}
				{tab === "agentHealth" && <AgentHealthPanel />}
				{tab === "modelRouter" && <ModelRouterPanel />}
				{tab === "domainAgents" && <DomainAgentsPanel />}
				{tab === "cicdAnomaly" && <CicdAnomalyPanel />}
				{tab === "license" && <LicensePanel projectPath={projectPath} />}
				{tab === "archDrift" && <ArchDriftPanel projectPath={projectPath} />}
				{tab === "genTests" && <GenTestsPanel projectPath={projectPath} />}
				{tab === "i18nScaler" && <I18nScalerPanel projectPath={projectPath} />}
				{tab === "cogContext" && <CogContextPanel />}
				{tab === "audit" && <AuditTrailPanel projectPath={projectPath} />}
				{tab === "pair" && <PairProgrammingPanel />}
			</Page>
		</ModuleStage>
	);
}
