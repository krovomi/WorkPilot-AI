import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openArenaDialog } from "@/stores/arena-store";
import { openConflictPredictorDialog } from "@/stores/conflict-predictor-store";
import { openContextAwareSnippetsDialog } from "@/stores/context-aware-snippets-store";
import { useNaturalLanguageGitStore } from "@/stores/natural-language-git-store";
import { openSmartEstimation } from "@/stores/smart-estimation-store";
import type { SidebarView } from "../Sidebar";
import { Button } from "../ui/button";
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
		<div className="flex h-full items-center justify-center p-8">
			<div className="flex max-w-md flex-col items-center gap-4 text-center">
				<Icon className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
				<h2 className="text-lg font-semibold">{name}</h2>
				<p className="text-sm text-muted-foreground">
					{t(`navigation:hubs.launchers.${tab.view}`)}
				</p>
				<Button onClick={() => HUB_DIALOG_OPENERS[tab.view]?.()}>
					<ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
					{t("navigation:hubs.open", { name })}
				</Button>
			</div>
		</div>
	);
}
