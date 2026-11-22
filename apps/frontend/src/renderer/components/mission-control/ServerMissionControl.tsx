/**
 * Mission Control for a server project (server mode). Its agents run on the
 * server, so the session of this computer (agents started here, on the
 * mirror) is not offered: the page shows the project's execution waves,
 * planned and run by the server (#358).
 */

import { Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Project } from "../../../shared/types";
import { ModuleHeader, ModuleStage, Page } from "../charter";
import { ServerWavesView } from "../conflict-predictor/ServerWavesView";

export function ServerMissionControl({ project }: { project: Project }) {
	const { t } = useTranslation(["missionControl", "navigation"]);
	return (
		<ModuleStage scroll="page" data-testid="mission-control-view">
			<ModuleHeader
				kicker={t("navigation:groups.workspace")}
				title={t("missionControl:title")}
				description={t("missionControl:serverDescription")}
				icon={Rocket}
				tone="orange"
			/>
			<Page className="space-y-4">
				<ServerWavesView key={project.id} project={project} />
			</Page>
		</ModuleStage>
	);
}
