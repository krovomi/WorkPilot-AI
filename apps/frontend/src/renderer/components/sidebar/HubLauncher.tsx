import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openArenaDialog } from "@/stores/arena-store";
import { openConflictPredictorDialog } from "@/stores/conflict-predictor-store";
import { openContextAwareSnippetsDialog } from "@/stores/context-aware-snippets-store";
import { useNaturalLanguageGitStore } from "@/stores/natural-language-git-store";
import { openSmartEstimation } from "@/stores/smart-estimation-store";
import type { SidebarView } from "../Sidebar";
import { CharterButton, EmptyStage, ModuleStage } from "../charter";
import type { HubTab } from "./hubs";

/**
 * How each dialog tool of a hub opens. The dialogs are mounted once by the
 * sidebar; the tab only asks for one.
 */
export const HUB_DIALOG_OPENERS: Partial<Record<SidebarView, () => void>> = {
	"smart-estimation": () => openSmartEstimation(""),
	"context-aware-snippets": openContextAwareSnippetsDialog,
	"conflict-predictor": openConflictPredictorDialog,
	"natural-language-git": () => useNaturalLanguageGitStore.getState().openDialog(),
	"arena-mode": openArenaDialog,
};

/** The page of a tab whose tool is a dialog: what it does, and a button that opens it. */
export function HubLauncher({ tab }: { readonly tab: HubTab }) {
	const { t } = useTranslation(["navigation"]);
	const Icon = tab.icon;
	const name = t(tab.labelKey);
	return (
		<ModuleStage>
			<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
				<EmptyStage
					icon={Icon}
					title={name}
					action={
						<CharterButton
							variant="primary"
							icon={ExternalLink}
							onClick={() => HUB_DIALOG_OPENERS[tab.view]?.()}
						>
							{t("navigation:hubs.open", { name })}
						</CharterButton>
					}
				>
					{t(`navigation:hubs.launchers.${tab.view}`)}
				</EmptyStage>
			</div>
		</ModuleStage>
	);
}
