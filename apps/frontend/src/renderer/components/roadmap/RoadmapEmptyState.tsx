import { Map as MapIcon, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CharterButton, EmptyStage, ModuleHeader, ModuleStage } from "../charter";
import type { RoadmapEmptyStateProps } from "./types";

/** No roadmap yet: one primary action, generate it. */
export function RoadmapEmptyState({ onGenerate }: Readonly<RoadmapEmptyStateProps>) {
	const { t } = useTranslation(["roadmap", "navigation"]);

	return (
		<ModuleStage data-testid="roadmap-view">
			<ModuleHeader
				kicker={t("navigation:groups.planning")}
				title={t("navigation:items.roadmap")}
				description={t("roadmap:emptyState.description")}
				icon={MapIcon}
				tone="accent"
			/>
			<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
				<EmptyStage
					icon={MapIcon}
					title={t("roadmap:emptyState.title")}
					action={
						<CharterButton variant="primary" icon={Sparkles} onClick={onGenerate}>
							{t("roadmap:emptyState.generateButton")}
						</CharterButton>
					}
				/>
			</div>
		</ModuleStage>
	);
}
